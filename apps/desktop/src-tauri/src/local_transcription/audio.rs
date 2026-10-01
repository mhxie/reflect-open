//! Decode a recording to whisper.cpp's input: 16 kHz float PCM, one track per
//! recorded channel. WebM, which WebKit's MediaRecorder writes (Opus), goes
//! through symphonia and libopus, which decodes at 16 kHz directly; anything
//! else (m4a/AAC, WAV) goes through AudioToolbox's ExtAudioFile, whose
//! converter resamples in the same pass.

use std::fs::File;
use std::io::{ErrorKind, Read, Seek};
use std::path::Path;
use std::ptr::NonNull;

use objc2_audio_toolbox::{
    kExtAudioFileProperty_ClientDataFormat, kExtAudioFileProperty_FileDataFormat,
    ExtAudioFileDispose, ExtAudioFileGetProperty, ExtAudioFileOpenURL, ExtAudioFileRead,
    ExtAudioFileRef, ExtAudioFileSetProperty,
};
use objc2_core_audio_types::{
    kAudioFormatFlagIsFloat, kAudioFormatFlagIsPacked, kAudioFormatLinearPCM, AudioBuffer,
    AudioBufferList, AudioStreamBasicDescription,
};
use objc2_core_foundation::CFURL;
use symphonia::core::codecs::audio::well_known::CODEC_ID_OPUS;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::codecs::registry::CodecRegistry;
use symphonia::core::codecs::CodecParameters;
use symphonia::core::errors::Error as StreamError;
use symphonia::core::formats::probe::{Hint, Probe};
use symphonia::core::formats::{FormatOptions, Track, TrackType};
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::default::formats::MkvReader;
use symphonia_adapter_libopus::OpusDecoder;

/// The sample rate whisper.cpp expects.
pub const SAMPLE_RATE: u32 = 16_000;

/// Frames pulled per `ExtAudioFileRead`.
const CHUNK_FRAMES: u32 = 32_768;

/// Every Matroska/WebM file opens with the EBML header ID.
const EBML_MAGIC: [u8; 4] = [0x1a, 0x45, 0xdf, 0xa3];

/// Why a recording yielded no samples.
#[derive(Debug)]
pub enum DecodeError {
    /// The file couldn't be read; a later pass may succeed.
    Unreadable(String),
    /// The bytes aren't audio we can decode; retrying can't help.
    Undecodable(String),
}

/// Decode `path` into one 16 kHz sample track per recorded channel.
pub fn decode_channels(path: &Path) -> Result<Vec<Vec<f32>>, DecodeError> {
    let unreadable = |err: std::io::Error| DecodeError::Unreadable(format!("reading it: {err}"));
    let mut file = File::open(path).map_err(unreadable)?;
    let mut magic = Vec::with_capacity(EBML_MAGIC.len());
    file.by_ref()
        .take(EBML_MAGIC.len() as u64)
        .read_to_end(&mut magic)
        .map_err(unreadable)?;
    if magic == EBML_MAGIC {
        file.rewind().map_err(unreadable)?;
        decode_webm(file)
    } else {
        decode_with_audio_toolbox(path).map_err(DecodeError::Undecodable)
    }
}

/// Demux a WebM file's Opus track and decode it at [`SAMPLE_RATE`].
fn decode_webm(file: File) -> Result<Vec<Vec<f32>>, DecodeError> {
    let stream = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());
    let mut probe = Probe::default();
    probe.register_format::<MkvReader<'_>>();
    let mut reader = probe
        .probe(
            &Hint::new(),
            stream,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(stream_error)?;
    let (track_id, mut params) = match reader.default_track(TrackType::Audio) {
        Some(Track {
            id,
            codec_params: Some(CodecParameters::Audio(params)),
            ..
        }) if params.codec == CODEC_ID_OPUS => (*id, params.clone()),
        _ => {
            return Err(DecodeError::Undecodable(
                "it has no Opus audio track".to_string(),
            ))
        }
    };
    // libopus decodes at any of its native rates, so asking for 16 kHz here
    // replaces a separate resampling pass; the codec pre-skip scales with it.
    params.with_sample_rate(SAMPLE_RATE);
    let mut codecs = CodecRegistry::new();
    codecs.register_audio_decoder::<OpusDecoder>();
    let mut decoder = codecs
        .make_audio_decoder(&params, &AudioDecoderOptions::default())
        .map_err(stream_error)?;

    let mut tracks: Vec<Vec<f32>> = Vec::new();
    let mut planes: Vec<Vec<f32>> = Vec::new();
    let (mut packets, mut damaged) = (0usize, 0usize);
    loop {
        let packet = match reader.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            // A recorder stopped mid-write leaves a final block cut short.
            Err(StreamError::IoError(err)) if err.kind() == ErrorKind::UnexpectedEof => break,
            Err(err) => return Err(stream_error(err)),
        };
        if packet.track_id != track_id {
            continue;
        }
        packets += 1;
        match decoder.decode(&packet) {
            Ok(audio) => {
                audio.copy_to_vecs_planar(&mut planes);
                tracks.resize_with(planes.len(), Vec::new);
                for (track, plane) in tracks.iter_mut().zip(&planes) {
                    track.extend_from_slice(plane);
                }
            }
            // One damaged packet costs a few milliseconds, not the memo.
            Err(StreamError::DecodeError(_)) => damaged += 1,
            Err(err) => return Err(stream_error(err)),
        }
    }
    if packets > 0 && damaged == packets {
        return Err(DecodeError::Undecodable(
            "none of its audio packets decode".to_string(),
        ));
    }
    Ok(tracks)
}

/// A failed read of the file is worth retrying; malformed contents are not.
fn stream_error(err: StreamError) -> DecodeError {
    match err {
        StreamError::IoError(err) if err.kind() != ErrorKind::UnexpectedEof => {
            DecodeError::Unreadable(format!("reading it: {err}"))
        }
        StreamError::IoError(_) => DecodeError::Undecodable("it ends too early".to_string()),
        err => DecodeError::Undecodable(err.to_string()),
    }
}

/// Disposes the file on every exit path.
struct OpenFile(ExtAudioFileRef);

impl Drop for OpenFile {
    fn drop(&mut self) {
        // SAFETY: the ref came from a successful ExtAudioFileOpenURL and is
        // disposed exactly once.
        unsafe {
            ExtAudioFileDispose(self.0);
        }
    }
}

fn check(status: i32, action: &str) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!("{action} failed (OSStatus {status})"))
    }
}

/// Decode and resample any container AudioToolbox reads.
fn decode_with_audio_toolbox(path: &Path) -> Result<Vec<Vec<f32>>, String> {
    let url = CFURL::from_file_path(path)
        .ok_or_else(|| format!("not a file path: {}", path.display()))?;
    let mut raw: ExtAudioFileRef = std::ptr::null_mut();
    // SAFETY: `raw` is a valid out-pointer for the duration of the call.
    check(
        unsafe { ExtAudioFileOpenURL(&url, NonNull::from(&mut raw)) },
        "opening the recording",
    )?;
    let file = OpenFile(raw);

    let mut source = pcm_format(0.0, 0);
    let mut size = std::mem::size_of::<AudioStreamBasicDescription>() as u32;
    // SAFETY: both out-pointers are valid and sized for the property.
    check(
        unsafe {
            ExtAudioFileGetProperty(
                file.0,
                kExtAudioFileProperty_FileDataFormat,
                NonNull::from(&mut size),
                NonNull::from(&mut source).cast(),
            )
        },
        "reading the recording format",
    )?;
    let channels = source.mChannelsPerFrame.max(1);

    let client = pcm_format(f64::from(SAMPLE_RATE), channels);
    // SAFETY: the property data points at a live, correctly sized ASBD.
    check(
        unsafe {
            ExtAudioFileSetProperty(
                file.0,
                kExtAudioFileProperty_ClientDataFormat,
                std::mem::size_of::<AudioStreamBasicDescription>() as u32,
                NonNull::from(&client).cast(),
            )
        },
        "setting the decode format",
    )?;

    let width = channels as usize;
    let mut tracks = vec![Vec::new(); width];
    let mut buffer = vec![0f32; CHUNK_FRAMES as usize * width];
    loop {
        let mut frames = CHUNK_FRAMES;
        let mut list = AudioBufferList {
            mNumberBuffers: 1,
            mBuffers: [AudioBuffer {
                mNumberChannels: channels,
                mDataByteSize: (buffer.len() * std::mem::size_of::<f32>()) as u32,
                mData: buffer.as_mut_ptr().cast(),
            }],
        };
        // SAFETY: the list describes `buffer`, which outlives the call and
        // holds `frames` interleaved frames of the client format.
        check(
            unsafe {
                ExtAudioFileRead(file.0, NonNull::from(&mut frames), NonNull::from(&mut list))
            },
            "decoding the recording",
        )?;
        if frames == 0 {
            break;
        }
        for frame in buffer[..frames as usize * width].chunks_exact(width) {
            for (track, sample) in tracks.iter_mut().zip(frame) {
                track.push(*sample);
            }
        }
    }
    Ok(tracks)
}

/// Interleaved 32-bit float linear PCM.
fn pcm_format(sample_rate: f64, channels: u32) -> AudioStreamBasicDescription {
    AudioStreamBasicDescription {
        mSampleRate: sample_rate,
        mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 4 * channels,
        mFramesPerPacket: 1,
        mBytesPerFrame: 4 * channels,
        mChannelsPerFrame: channels,
        mBitsPerChannel: 32,
        mReserved: 0,
    }
}

/// Average the tracks into one; a memo's microphone is usually mono already.
pub fn downmix(tracks: Vec<Vec<f32>>) -> Vec<f32> {
    match tracks.len() {
        0 => Vec::new(),
        1 => tracks.into_iter().next().unwrap_or_default(),
        count => {
            let frames = tracks.iter().map(Vec::len).min().unwrap_or(0);
            (0..frames)
                .map(|index| tracks.iter().map(|track| track[index]).sum::<f32>() / count as f32)
                .collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 16-bit PCM WAV of `seconds` of a 440 Hz tone per channel at `rate`.
    fn write_wav(path: &Path, rate: u32, channels: u16, seconds: f32) {
        let frames = (rate as f32 * seconds) as u32;
        let mut data = Vec::new();
        for frame in 0..frames {
            let value = (f32::sin(frame as f32 * 440.0 * std::f32::consts::TAU / rate as f32)
                * 0.5
                * f32::from(i16::MAX)) as i16;
            for channel in 0..channels {
                // The second channel is inverted so a downmix cancels to silence.
                let sample = if channel == 1 { -value } else { value };
                data.extend_from_slice(&sample.to_le_bytes());
            }
        }
        let block = u32::from(channels) * 2;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&channels.to_le_bytes());
        wav.extend_from_slice(&rate.to_le_bytes());
        wav.extend_from_slice(&(rate * block).to_le_bytes());
        wav.extend_from_slice(&(block as u16).to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(data.len() as u32).to_le_bytes());
        wav.extend_from_slice(&data);
        std::fs::write(path, wav).unwrap();
    }

    fn peak(samples: &[f32]) -> f32 {
        samples
            .iter()
            .fold(0f32, |peak, sample| peak.max(sample.abs()))
    }

    #[test]
    fn resamples_to_16_khz_per_channel() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tone.wav");
        write_wav(&path, 48_000, 2, 1.0);
        let tracks = decode_channels(&path).unwrap();
        assert_eq!(tracks.len(), 2);
        for track in &tracks {
            // The converter may hold back a few priming frames at the edges.
            assert!(
                (15_900..=16_100).contains(&track.len()),
                "{} frames",
                track.len()
            );
            let peak = peak(track);
            assert!((0.4..0.6).contains(&peak), "peak {peak}");
        }
        let residue = peak(&downmix(tracks));
        assert!(
            residue < 0.01,
            "inverted channels should cancel, residue {residue}"
        );
    }

    /// One second of a 440 Hz tone at half scale, laid out like WebKit's
    /// MediaRecorder output: mono Opus in 2.5 ms CELT frames, a Segment and a
    /// single Cluster of unknown size, Cues after the Cluster. Encoded with
    /// `ffmpeg -f lavfi -i 'aevalsrc=0.5*sin(440*2*PI*t):s=48000:d=1'
    /// -c:a libopus -b:a 32k -frame_duration 2.5 -fflags +bitexact
    /// -map_metadata -1 -f webm`, then re-laid out by hand into that shape.
    const WEBKIT_STYLE_WEBM: &[u8] = include_bytes!("testdata/tone.webm");

    #[test]
    fn decodes_webkit_webm_opus_at_16_khz() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.webm");
        std::fs::write(&path, WEBKIT_STYLE_WEBM).unwrap();
        let tracks = decode_channels(&path).unwrap();
        assert_eq!(tracks.len(), 1);
        let track = &tracks[0];
        assert!(
            (15_500..=16_500).contains(&track.len()),
            "{} frames",
            track.len()
        );
        let peak = peak(track);
        assert!((0.35..0.65).contains(&peak), "peak {peak}");
        // 440 Hz crosses zero 880 times a second; at any other rate the
        // samples would be read as a different pitch.
        let middle = &track[4_000..12_000];
        let crossings = middle
            .windows(2)
            .filter(|pair| (pair[0] < 0.0) != (pair[1] < 0.0))
            .count();
        assert!((420..=460).contains(&crossings), "{crossings} crossings");
    }

    #[test]
    fn a_webm_stopped_before_any_audio_has_no_samples() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.webm");
        let cluster = WEBKIT_STYLE_WEBM
            .windows(4)
            .position(|id| id == [0x1f, 0x43, 0xb6, 0x75])
            .unwrap();
        std::fs::write(&path, &WEBKIT_STYLE_WEBM[..cluster]).unwrap();
        let tracks = decode_channels(&path).unwrap();
        assert!(downmix(tracks).is_empty());
    }

    #[test]
    fn rejects_files_that_are_not_audio() {
        let dir = tempfile::tempdir().unwrap();
        for (name, bytes) in [
            ("memo.m4a", b"not audio".as_slice()),
            ("memo.webm", &[0x1a, 0x45, 0xdf, 0xa3, 0x00]),
            ("empty.m4a", b""),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            assert!(
                matches!(decode_channels(&path), Err(DecodeError::Undecodable(_))),
                "{name}"
            );
        }
    }

    #[test]
    fn a_missing_file_is_unreadable_not_undecodable() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            decode_channels(&dir.path().join("gone.webm")),
            Err(DecodeError::Unreadable(_))
        ));
    }
}
