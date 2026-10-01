//! The recording's files: a stereo WAV per capture part while recording (left
//! = microphone, right = system audio, 16 kHz, 16-bit), and one AAC m4a for
//! the archived copy.
//!
//! WAV is the capture format because it survives a crash: samples are appended
//! as they arrive and only the header's sizes go stale, so the reader here
//! takes everything after the `data` chunk header up to the end of the file.
//! ExtAudioFile's own asynchronous writer turned out to drop every frame when
//! its file is opened off a run-loop thread, so capture hands frames to a
//! writer thread of its own instead.

use std::fs;
use std::path::{Path, PathBuf};
use std::ptr::NonNull;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use objc2_audio_toolbox::{
    kAudioFileM4AType, kAudioFileWAVEType, kExtAudioFileProperty_ClientDataFormat, AudioFileFlags,
    ExtAudioFileCreateWithURL, ExtAudioFileDispose, ExtAudioFileRef, ExtAudioFileSetProperty,
    ExtAudioFileWrite,
};
use objc2_core_audio_types::{
    kAudioFormatFlagIsFloat, kAudioFormatFlagIsPacked, kAudioFormatFlagIsSignedInteger,
    kAudioFormatLinearPCM, kAudioFormatMPEG4AAC, AudioBuffer, AudioBufferList,
    AudioStreamBasicDescription,
};
use objc2_core_foundation::CFURL;
use rtrb::{Consumer, Producer, RingBuffer};

/// The rate both channels are stored and transcribed at.
pub const SAMPLE_RATE: u32 = 16_000;
const CHANNELS: u32 = 2;

/// Both channels of one capture part, 16 kHz float.
pub struct Stereo {
    pub mic: Vec<f32>,
    pub system: Vec<f32>,
}

fn check(status: i32, action: &str) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!("{action} failed (OSStatus {status})"))
    }
}

/// Interleaved 32-bit float linear PCM at `rate`.
fn float_format(rate: f64, channels: u32) -> AudioStreamBasicDescription {
    AudioStreamBasicDescription {
        mSampleRate: rate,
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

/// Create `path` as `file_format` and accept interleaved float frames at
/// `client_rate`; ExtAudioFile converts (and resamples) on the way in.
fn create(
    path: &Path,
    file_type: u32,
    mut file_format: AudioStreamBasicDescription,
    client_rate: f64,
) -> Result<ExtAudioFileRef, String> {
    let url = CFURL::from_file_path(path)
        .ok_or_else(|| format!("not a file path: {}", path.display()))?;
    let mut file: ExtAudioFileRef = std::ptr::null_mut();
    // SAFETY: the format and out-pointer are valid for the duration of the call.
    check(
        unsafe {
            ExtAudioFileCreateWithURL(
                &url,
                file_type,
                NonNull::from(&mut file_format),
                std::ptr::null(),
                AudioFileFlags::EraseFile.0,
                NonNull::from(&mut file),
            )
        },
        "creating the audio file",
    )?;
    let client = float_format(client_rate, CHANNELS);
    // SAFETY: `file` was just created; the property data is a live ASBD.
    let status = unsafe {
        ExtAudioFileSetProperty(
            file,
            kExtAudioFileProperty_ClientDataFormat,
            std::mem::size_of::<AudioStreamBasicDescription>() as u32,
            NonNull::from(&client).cast(),
        )
    };
    if let Err(err) = check(status, "setting the audio file's input format") {
        // SAFETY: disposed once, on this failure path only.
        unsafe { ExtAudioFileDispose(file) };
        return Err(err);
    }
    Ok(file)
}

/// The IO thread's end of a capture part: interleaved stereo frames go into
/// a lock-free ring, and [`PartWriter`]'s thread writes them to disk.
pub struct PartFeed {
    producer: Producer<f32>,
    dropped: Arc<AtomicU64>,
}

impl PartFeed {
    /// Queue interleaved stereo samples. Realtime-safe: never blocks or
    /// allocates; samples that don't fit (the disk stalled for seconds) are
    /// counted and dropped.
    pub fn push(&mut self, interleaved: &[f32]) {
        let (_, rest) = self.producer.push_partial_slice(interleaved);
        if !rest.is_empty() {
            self.dropped.fetch_add(rest.len() as u64, Ordering::Relaxed);
        }
    }
}

/// Writes one capture part's WAV on its own thread. Dropping it waits for
/// the ring to drain, then finalizes the file.
pub struct PartWriter {
    stop: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    thread: Option<JoinHandle<Result<(), String>>>,
}

/// Four seconds of 48 kHz stereo: far more than the writer ever lags.
const RING_SAMPLES: usize = 4 * 48_000 * CHANNELS as usize;
const DRAIN_INTERVAL: Duration = Duration::from_millis(50);

impl PartWriter {
    /// Create the part at `path`, receiving device frames at `client_rate`.
    pub fn create(path: &Path, client_rate: f64) -> Result<(Self, PartFeed), String> {
        let stored = AudioStreamBasicDescription {
            mSampleRate: f64::from(SAMPLE_RATE),
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 2 * CHANNELS,
            mFramesPerPacket: 1,
            mBytesPerFrame: 2 * CHANNELS,
            mChannelsPerFrame: CHANNELS,
            mBitsPerChannel: 16,
            mReserved: 0,
        };
        let file = OpenFile(create(path, kAudioFileWAVEType, stored, client_rate)?);
        let (producer, consumer) = RingBuffer::<f32>::new(RING_SAMPLES);
        let stop = Arc::new(AtomicBool::new(false));
        let failed = Arc::new(AtomicBool::new(false));
        let dropped = Arc::new(AtomicU64::new(0));
        let thread_stop = Arc::clone(&stop);
        let thread_failed = Arc::clone(&failed);
        let thread = std::thread::Builder::new()
            .name("recorder-writer".to_string())
            .spawn(move || {
                let written = drain(file, consumer, &thread_stop);
                if written.is_err() {
                    thread_failed.store(true, Ordering::Release);
                }
                written
            })
            .map_err(|err| format!("starting the audio writer: {err}"))?;
        Ok((
            Self {
                stop,
                failed,
                dropped: Arc::clone(&dropped),
                thread: Some(thread),
            },
            PartFeed { producer, dropped },
        ))
    }

    /// Samples the ring had no room for.
    pub fn dropped_samples(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Writing hit an error and the writer stopped; nothing more is saved.
    pub fn failed(&self) -> bool {
        self.failed.load(Ordering::Acquire)
    }
}

impl Drop for PartWriter {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            match thread.join() {
                Ok(Ok(())) => {}
                Ok(Err(err)) => tracing::warn!(error = %err, "writing a recording failed"),
                Err(_) => tracing::warn!("the recording writer panicked"),
            }
        }
    }
}

/// Disposes the file (finalizing its header) on every exit path.
struct OpenFile(ExtAudioFileRef);

// SAFETY: an ExtAudioFile ref is a plain handle used by one thread at a time.
unsafe impl Send for OpenFile {}

impl Drop for OpenFile {
    fn drop(&mut self) {
        // SAFETY: the ref came from a successful create and is disposed once.
        unsafe {
            ExtAudioFileDispose(self.0);
        }
    }
}

/// The writer thread: move whatever the ring holds to disk until told to
/// stop (or the feed is gone), then drain the rest.
fn drain(file: OpenFile, mut consumer: Consumer<f32>, stop: &AtomicBool) -> Result<(), String> {
    let mut buffer = vec![0f32; RING_SAMPLES];
    loop {
        let finishing = stop.load(Ordering::Acquire) || consumer.is_abandoned();
        let available = consumer.slots() / CHANNELS as usize * CHANNELS as usize;
        if available > 0 {
            let (taken, _) = consumer.pop_partial_slice(&mut buffer[..available]);
            let frames = taken.len() / CHANNELS as usize;
            write_frames(file.0, taken, frames)?;
        } else if finishing {
            return Ok(());
        } else {
            std::thread::sleep(DRAIN_INTERVAL);
        }
    }
}

fn write_frames(
    file: ExtAudioFileRef,
    interleaved: &mut [f32],
    frames: usize,
) -> Result<(), String> {
    let mut list = AudioBufferList {
        mNumberBuffers: 1,
        mBuffers: [AudioBuffer {
            mNumberChannels: CHANNELS,
            mDataByteSize: (frames * CHANNELS as usize * std::mem::size_of::<f32>()) as u32,
            mData: interleaved.as_mut_ptr().cast(),
        }],
    };
    // SAFETY: the list describes `frames` interleaved frames of a live buffer.
    check(
        unsafe { ExtAudioFileWrite(file, frames as u32, NonNull::from(&mut list)) },
        "writing the recording",
    )
}

/// Read a capture part: both channels as float, everything after the `data`
/// chunk header up to the end of the file (a crash leaves its size stale).
pub fn read_part(path: &Path) -> Result<Stereo, String> {
    let bytes = fs::read(path).map_err(|err| format!("reading {}: {err}", path.display()))?;
    let samples = pcm_samples(&bytes).map_err(|err| format!("{}: {err}", path.display()))?;
    let frames = samples.len() / CHANNELS as usize;
    let mut mic = Vec::with_capacity(frames);
    let mut system = Vec::with_capacity(frames);
    for [left, right] in samples.as_chunks::<2>().0 {
        mic.push(f32::from(*left) / 32_768.0);
        system.push(f32::from(*right) / 32_768.0);
    }
    Ok(Stereo { mic, system })
}

/// The interleaved 16-bit samples of a 16 kHz stereo WAV.
fn pcm_samples(bytes: &[u8]) -> Result<Vec<i16>, String> {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a WAV file".to_string());
    }
    let mut position = 12;
    let mut format_ok = false;
    while position + 8 <= bytes.len() {
        let id = &bytes[position..position + 4];
        let size = u32::from_le_bytes(
            bytes[position + 4..position + 8]
                .try_into()
                .expect("4 bytes"),
        ) as usize;
        let body = position + 8;
        if id == b"fmt " {
            let format = bytes.get(body..body + 16).ok_or("truncated fmt chunk")?;
            let tag = u16::from_le_bytes([format[0], format[1]]);
            let channels = u16::from_le_bytes([format[2], format[3]]);
            let rate = u32::from_le_bytes([format[4], format[5], format[6], format[7]]);
            let bits = u16::from_le_bytes([format[14], format[15]]);
            format_ok =
                tag == 1 && u32::from(channels) == CHANNELS && rate == SAMPLE_RATE && bits == 16;
        } else if id == b"data" {
            if !format_ok {
                return Err("expected 16 kHz stereo 16-bit PCM".to_string());
            }
            let data = &bytes[body.min(bytes.len())..];
            return Ok(data
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| i16::from_le_bytes(*pair))
                .collect());
        }
        position = body + size + (size & 1);
    }
    Err("no data chunk".to_string())
}

/// Encode capture parts, in order, into one AAC m4a at `destination`. Parts
/// are read one at a time, so only the longest part sits in memory.
pub fn encode_archive(parts: &[PathBuf], destination: &Path) -> Result<(), String> {
    let stored = AudioStreamBasicDescription {
        mSampleRate: f64::from(SAMPLE_RATE),
        mFormatID: kAudioFormatMPEG4AAC,
        mFormatFlags: 0,
        mBytesPerPacket: 0,
        mFramesPerPacket: 0,
        mBytesPerFrame: 0,
        mChannelsPerFrame: CHANNELS,
        mBitsPerChannel: 0,
        mReserved: 0,
    };
    // Disposing the file when this returns finalizes the container.
    let file = OpenFile(create(
        destination,
        kAudioFileM4AType,
        stored,
        f64::from(SAMPLE_RATE),
    )?);
    parts
        .iter()
        .try_for_each(|part| write_part(file.0, &read_part(part)?))
}

fn write_part(file: ExtAudioFileRef, part: &Stereo) -> Result<(), String> {
    const BLOCK: usize = 16_384;
    let mut interleaved = vec![0f32; BLOCK * CHANNELS as usize];
    let frames = part.mic.len().min(part.system.len());
    let mut start = 0;
    while start < frames {
        let count = BLOCK.min(frames - start);
        for offset in 0..count {
            interleaved[offset * 2] = part.mic[start + offset];
            interleaved[offset * 2 + 1] = part.system[start + offset];
        }
        write_frames(file, &mut interleaved, count)?;
        start += count;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav_bytes(samples: &[i16], declared_data_size: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(b"WAVE");
        bytes.extend_from_slice(b"fmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16_000u32.to_le_bytes());
        bytes.extend_from_slice(&64_000u32.to_le_bytes());
        bytes.extend_from_slice(&4u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"FLLR");
        bytes.extend_from_slice(&4u32.to_le_bytes());
        bytes.extend_from_slice(&[0; 4]);
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&declared_data_size.to_le_bytes());
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn reads_past_a_stale_data_size() {
        let samples = [100, -100, 200, -200, 300, -300];
        let parsed = pcm_samples(&wav_bytes(&samples, 0)).unwrap();
        assert_eq!(parsed, samples);
    }

    #[test]
    fn rejects_other_formats() {
        let mut bytes = wav_bytes(&[1, 2], 4);
        bytes[24..28].copy_from_slice(&44_100u32.to_le_bytes());
        assert!(pcm_samples(&bytes).is_err());
        assert!(pcm_samples(b"not audio").is_err());
    }

    #[test]
    fn writes_a_part_and_reads_it_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("part-000.wav");
        let (writer, mut feed) = PartWriter::create(&path, 48_000.0).unwrap();
        let frames: Vec<f32> = (0..48_000)
            .flat_map(|index| {
                let phase = index as f32 * 2.0 * std::f32::consts::PI * 440.0 / 48_000.0;
                [0.5 * phase.sin(), 0.0]
            })
            .collect();
        for block in frames.chunks(512 * 2) {
            feed.push(block);
        }
        drop(feed);
        assert_eq!(writer.dropped_samples(), 0);
        drop(writer);
        let stereo = read_part(&path).unwrap();
        assert!(
            (15_800..=16_200).contains(&stereo.mic.len()),
            "{}",
            stereo.mic.len()
        );
        let loudest = stereo
            .mic
            .iter()
            .fold(0f32, |peak, sample| peak.max(sample.abs()));
        assert!(loudest > 0.4 && stereo.system.iter().all(|sample| sample.abs() < 1e-3));

        let archive = dir.path().join("archive.m4a");
        encode_archive(&[path], &archive).unwrap();
        assert!(fs::metadata(&archive).unwrap().len() > 1_000);
    }
}
