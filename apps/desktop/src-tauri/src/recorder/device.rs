//! One capture part on Core Audio: a private aggregate device joining the
//! default output device (the clock), the default input device, and a global
//! process tap (macOS 14.2+), so the microphone and everything the Mac plays
//! share one clock and need no alignment afterwards. Devices are fixed for the
//! part's lifetime; the recorder starts a new part when they change.

use std::cell::RefCell;
use std::ffi::CStr;
use std::path::Path;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use block2::{DynBlock, RcBlock};
use objc2::AnyThread;
use objc2_core_audio::{
    kAudioAggregateDeviceIsPrivateKey, kAudioAggregateDeviceIsStackedKey,
    kAudioAggregateDeviceMainSubDeviceKey, kAudioAggregateDeviceNameKey,
    kAudioAggregateDeviceSubDeviceListKey, kAudioAggregateDeviceTapAutoStartKey,
    kAudioAggregateDeviceTapListKey, kAudioAggregateDeviceUIDKey, kAudioDevicePropertyDeviceUID,
    kAudioDevicePropertyNominalSampleRate, kAudioDevicePropertyStreams,
    kAudioHardwarePropertyDefaultInputDevice, kAudioHardwarePropertyDefaultSystemOutputDevice,
    kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyScopeInput, kAudioObjectSystemObject, kAudioObjectUnknown,
    kAudioSubDeviceDriftCompensationKey, kAudioSubDeviceUIDKey, kAudioSubTapDriftCompensationKey,
    kAudioSubTapUIDKey, AudioDeviceCreateIOProcIDWithBlock, AudioDeviceDestroyIOProcID,
    AudioDeviceIOProcID, AudioDeviceStart, AudioDeviceStop, AudioHardwareCreateAggregateDevice,
    AudioHardwareCreateProcessTap, AudioHardwareDestroyAggregateDevice,
    AudioHardwareDestroyProcessTap, AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize,
    AudioObjectID, AudioObjectPropertyAddress, AudioObjectPropertyScope,
    AudioObjectPropertySelector, CATapDescription, CATapMuteBehavior,
};
use objc2_core_audio_types::{AudioBuffer, AudioBufferList, AudioTimeStamp};
use objc2_core_foundation::{CFArray, CFBoolean, CFDictionary, CFRetained, CFString, CFType};
use objc2_foundation::{NSArray, NSNumber, NSUUID};

use super::audio_file::{PartFeed, PartWriter};

/// The most frames one IO cycle can hand over; larger cycles are truncated.
const MAX_IO_FRAMES: usize = 16_384;

fn check(status: i32, action: &str) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!("{action} failed (OSStatus {status})"))
    }
}

fn address(
    selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope,
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: scope,
        mElement: kAudioObjectPropertyElementMain,
    }
}

/// Read a fixed-size property of `object`.
fn property<T: Copy>(
    object: AudioObjectID,
    selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope,
    initial: T,
    what: &str,
) -> Result<T, String> {
    let mut value = initial;
    let mut size = std::mem::size_of::<T>() as u32;
    let mut target = address(selector, scope);
    // SAFETY: `value` is a live `T` and `size` matches it.
    check(
        unsafe {
            AudioObjectGetPropertyData(
                object,
                NonNull::from(&mut target),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
                NonNull::from(&mut value).cast(),
            )
        },
        what,
    )?;
    Ok(value)
}

/// The current default input and output devices.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeviceIds {
    pub input: AudioObjectID,
    pub output: AudioObjectID,
}

pub fn current_devices() -> Result<DeviceIds, String> {
    let system = kAudioObjectSystemObject as AudioObjectID;
    Ok(DeviceIds {
        input: property(
            system,
            kAudioHardwarePropertyDefaultInputDevice,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectUnknown,
            "reading the default microphone",
        )?,
        output: property(
            system,
            kAudioHardwarePropertyDefaultSystemOutputDevice,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectUnknown,
            "reading the default output device",
        )?,
    })
}

fn device_uid(device: AudioObjectID) -> Result<String, String> {
    let raw: *const CFString = property(
        device,
        kAudioDevicePropertyDeviceUID,
        kAudioObjectPropertyScopeGlobal,
        std::ptr::null(),
        "reading a device identifier",
    )?;
    let raw = NonNull::new(raw.cast_mut()).ok_or("a device reported no identifier")?;
    // SAFETY: the property hands over a +1 reference, released by CFRetained.
    let uid = unsafe { CFRetained::from_raw(raw) };
    Ok(uid.to_string())
}

/// How many input streams `device` contributes to an aggregate, in HAL order.
fn input_stream_count(device: AudioObjectID) -> usize {
    let mut target = address(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput);
    let mut size = 0u32;
    // SAFETY: only the size is written.
    let status = unsafe {
        AudioObjectGetPropertyDataSize(
            device,
            NonNull::from(&mut target),
            0,
            std::ptr::null(),
            NonNull::from(&mut size),
        )
    };
    if status != 0 {
        return 0;
    }
    size as usize / std::mem::size_of::<AudioObjectID>()
}

/// Whether this macOS has process taps (14.2+): the class exists at runtime.
pub fn taps_available() -> bool {
    objc2::runtime::AnyClass::get(c"CATapDescription").is_some()
}

/// What the IO thread reports to the watchdog. Peaks are `f32` bits and are
/// reset by each read.
#[derive(Default)]
pub struct Meters {
    frames: AtomicU64,
    mic_peak: AtomicU32,
    system_peak: AtomicU32,
    /// The louder side's peak for the recording panel, read separately from
    /// the watchdog's so neither reset hides audio from the other.
    display_peak: AtomicU32,
    layout_fallback: AtomicBool,
}

impl Meters {
    pub fn frames(&self) -> u64 {
        self.frames.load(Ordering::Relaxed)
    }

    /// The loudest microphone and system samples since the last call.
    pub fn take_peaks(&self) -> (f32, f32) {
        (
            f32::from_bits(self.mic_peak.swap(0, Ordering::Relaxed)),
            f32::from_bits(self.system_peak.swap(0, Ordering::Relaxed)),
        )
    }

    /// The loudest sample on either side since the last call, for display.
    pub fn take_display_level(&self) -> f32 {
        f32::from_bits(self.display_peak.swap(0, Ordering::Relaxed))
    }

    /// The aggregate's buffers didn't match the device query and the IO
    /// thread fell back to "first buffer = microphone, last = tap".
    pub fn layout_fallback(&self) -> bool {
        self.layout_fallback.load(Ordering::Relaxed)
    }

    fn raise_peak(slot: &AtomicU32, peak: f32) {
        let mut current = slot.load(Ordering::Relaxed);
        while peak > f32::from_bits(current) {
            match slot.compare_exchange_weak(
                current,
                peak.to_bits(),
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(actual) => current = actual,
            }
        }
    }
}

/// What the IO block mutates; only ever touched on the IO thread.
struct IoState {
    interleaved: Vec<f32>,
    feed: PartFeed,
}

type IoBlock = RcBlock<
    dyn Fn(
        NonNull<AudioTimeStamp>,
        NonNull<AudioBufferList>,
        NonNull<AudioTimeStamp>,
        NonNull<AudioBufferList>,
        NonNull<AudioTimeStamp>,
    ),
>;

/// The IO block, kept alive for as long as Core Audio may call it.
struct HeldBlock {
    _block: IoBlock,
}

// SAFETY: the block is only ever invoked by Core Audio's IO thread and only
// dropped after its IO proc is destroyed; holding it elsewhere moves nothing
// the IO thread touches.
unsafe impl Send for HeldBlock {}

/// A running capture part. Dropping it stops the device and finalizes the WAV.
pub struct Capture {
    pub devices: DeviceIds,
    pub meters: Arc<Meters>,
    tap: AudioObjectID,
    aggregate: AudioObjectID,
    proc_id: AudioDeviceIOProcID,
    block: Option<HeldBlock>,
    writer: Option<PartWriter>,
}

impl Capture {
    /// Start capturing the current default devices into a WAV at `path`.
    pub fn start(path: &Path) -> Result<Self, String> {
        let devices = current_devices()?;
        let mut capture = Self {
            devices,
            meters: Arc::new(Meters::default()),
            tap: kAudioObjectUnknown,
            aggregate: kAudioObjectUnknown,
            proc_id: None,
            block: None,
            writer: None,
        };
        // On any failure the partly built capture drops and tears down.
        capture.open(path)?;
        Ok(capture)
    }

    fn open(&mut self, path: &Path) -> Result<(), String> {
        let output_uid = device_uid(self.devices.output)?;
        let input_uid = device_uid(self.devices.input)?;

        let tap_uuid = NSUUID::new();
        // SAFETY: an empty exclusion list taps every process; the setters
        // run before the description is handed to Core Audio.
        let description = unsafe {
            let tap = CATapDescription::initStereoGlobalTapButExcludeProcesses(
                CATapDescription::alloc(),
                &NSArray::<NSNumber>::new(),
            );
            tap.setUUID(&tap_uuid);
            // Muted would silence the speakers while recording.
            tap.setMuteBehavior(CATapMuteBehavior::Unmuted);
            tap.setPrivate(true);
            tap
        };
        // SAFETY: the description is live; the out-pointer is valid.
        check(
            unsafe { AudioHardwareCreateProcessTap(Some(&description), &mut self.tap) },
            "creating the system audio tap",
        )?;

        // Aggregate input buffers arrive as each sub-device's input streams in
        // list order, then the tap. A headset exposes both directions under
        // one identifier, and then it is listed once.
        let mut sub_devices = vec![sub_device(&output_uid, false)];
        let mic_start = if input_uid == output_uid {
            0
        } else {
            sub_devices.push(sub_device(&input_uid, true));
            input_stream_count(self.devices.output)
        };
        let mic_streams = mic_start..mic_start + input_stream_count(self.devices.input).max(1);

        let tap_uid = tap_uuid.UUIDString().to_string();
        let aggregate_uid = NSUUID::new().UUIDString().to_string();
        let sub_device_refs: Vec<&CFDictionary<CFString, CFType>> =
            sub_devices.iter().map(|entry| &**entry).collect();
        let tap_entry = dictionary(&[
            (kAudioSubTapUIDKey, &*CFString::from_str(&tap_uid)),
            (kAudioSubTapDriftCompensationKey, CFBoolean::new(true)),
        ]);
        let sub_device_list = CFArray::from_objects(&sub_device_refs);
        let tap_list = CFArray::from_objects(&[&*tap_entry]);
        let description = dictionary(&[
            (
                kAudioAggregateDeviceNameKey,
                &*CFString::from_str("Reflect recording"),
            ),
            (
                kAudioAggregateDeviceUIDKey,
                &*CFString::from_str(&aggregate_uid),
            ),
            (
                kAudioAggregateDeviceMainSubDeviceKey,
                &*CFString::from_str(&output_uid),
            ),
            (kAudioAggregateDeviceIsPrivateKey, CFBoolean::new(true)),
            (kAudioAggregateDeviceIsStackedKey, CFBoolean::new(false)),
            // Auto-start holds the whole device, microphone included, until
            // some app plays audio; a memo spoken into a silent Mac would
            // record nothing.
            (kAudioAggregateDeviceTapAutoStartKey, CFBoolean::new(false)),
            (kAudioAggregateDeviceSubDeviceListKey, &sub_device_list),
            (kAudioAggregateDeviceTapListKey, &tap_list),
        ]);
        // SAFETY: the description is live; the out-pointer is valid.
        check(
            unsafe {
                AudioHardwareCreateAggregateDevice(
                    description.as_opaque(),
                    NonNull::from(&mut self.aggregate),
                )
            },
            "creating the capture device",
        )?;

        let rate: f64 = property(
            self.aggregate,
            kAudioDevicePropertyNominalSampleRate,
            kAudioObjectPropertyScopeGlobal,
            0.0,
            "reading the capture sample rate",
        )?;
        tracing::info!(
            input = self.devices.input,
            output = self.devices.output,
            shared_device = input_uid == output_uid,
            mic_streams = ?mic_streams,
            rate,
            "recorder: capture device ready"
        );
        let (writer, feed) = PartWriter::create(path, rate)?;
        self.writer = Some(writer);

        let meters = Arc::clone(&self.meters);
        let io = RefCell::new(IoState {
            interleaved: vec![0f32; MAX_IO_FRAMES * 2],
            feed,
        });
        let block: IoBlock = RcBlock::new(
            move |_now: NonNull<AudioTimeStamp>,
                  input: NonNull<AudioBufferList>,
                  _input_time: NonNull<AudioTimeStamp>,
                  _output: NonNull<AudioBufferList>,
                  _output_time: NonNull<AudioTimeStamp>| {
                // SAFETY: Core Audio hands a valid list for the duration of the call.
                let buffers = unsafe { buffer_slice(input) };
                let Ok(mut io) = io.try_borrow_mut() else {
                    return;
                };
                let IoState { interleaved, feed } = &mut *io;
                let frames = mix(buffers, mic_streams.clone(), interleaved, &meters);
                feed.push(&interleaved[..frames * 2]);
            },
        );
        let block_pointer: *mut DynBlock<_> = IoBlock::as_ptr(&block);
        // SAFETY: the block outlives the IO proc (dropped only after it is
        // destroyed); no dispatch queue means it runs on the IO thread.
        check(
            unsafe {
                AudioDeviceCreateIOProcIDWithBlock(
                    NonNull::from(&mut self.proc_id),
                    self.aggregate,
                    None,
                    block_pointer,
                )
            },
            "attaching to the capture device",
        )?;
        self.block = Some(HeldBlock { _block: block });
        // SAFETY: the device and proc were created above.
        check(
            unsafe { AudioDeviceStart(self.aggregate, self.proc_id) },
            "starting the capture",
        )
    }
}

impl Capture {
    /// Samples the writer had no room for (the disk stalled for seconds).
    pub fn dropped_samples(&self) -> u64 {
        self.writer.as_ref().map_or(0, PartWriter::dropped_samples)
    }

    /// The writer stopped after an error (a full or unwritable disk).
    pub fn writer_failed(&self) -> bool {
        self.writer.as_ref().is_some_and(PartWriter::failed)
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        // SAFETY: each object is destroyed once, in reverse creation order,
        // and only if it was created.
        unsafe {
            if self.proc_id.is_some() {
                AudioDeviceStop(self.aggregate, self.proc_id);
                AudioDeviceDestroyIOProcID(self.aggregate, self.proc_id);
            }
            // The block owns the ring's feed; dropping it lets the writer
            // drain, and dropping the writer finalizes the WAV.
            self.block = None;
            self.writer = None;
            if self.aggregate != kAudioObjectUnknown {
                AudioHardwareDestroyAggregateDevice(self.aggregate);
            }
            if self.tap != kAudioObjectUnknown {
                AudioHardwareDestroyProcessTap(self.tap);
            }
        }
    }
}

/// One `kAudioAggregateDeviceSubDeviceListKey` entry.
fn sub_device(uid: &str, drift_compensated: bool) -> CFRetained<CFDictionary<CFString, CFType>> {
    dictionary(&[
        (kAudioSubDeviceUIDKey, &*CFString::from_str(uid)),
        (
            kAudioSubDeviceDriftCompensationKey,
            CFBoolean::new(drift_compensated),
        ),
    ])
}

fn dictionary(entries: &[(&CStr, &CFType)]) -> CFRetained<CFDictionary<CFString, CFType>> {
    let keys: Vec<CFRetained<CFString>> = entries
        .iter()
        .map(|(key, _)| CFString::from_str(&key.to_string_lossy()))
        .collect();
    let key_refs: Vec<&CFString> = keys.iter().map(|key| &**key).collect();
    let values: Vec<&CFType> = entries.iter().map(|(_, value)| *value).collect();
    CFDictionary::from_slices(&key_refs, &values)
}

/// The buffers of an AudioBufferList.
///
/// # Safety
/// `list` must point at a valid list for the returned lifetime.
unsafe fn buffer_slice<'a>(list: NonNull<AudioBufferList>) -> &'a [AudioBuffer] {
    let list = list.as_ptr();
    let count = (*list).mNumberBuffers as usize;
    std::slice::from_raw_parts(
        std::ptr::addr_of!((*list).mBuffers).cast::<AudioBuffer>(),
        count,
    )
}

/// Downmix the microphone streams and the tap into interleaved
/// `[microphone, system]` frames; returns the frame count.
fn mix(
    buffers: &[AudioBuffer],
    mic_streams: std::ops::Range<usize>,
    interleaved: &mut [f32],
    meters: &Meters,
) -> usize {
    if buffers.len() < 2 {
        return 0;
    }
    let (mic_streams, tap_index) = if mic_streams.end == buffers.len() - 1 {
        (mic_streams, buffers.len() - 1)
    } else {
        meters.layout_fallback.store(true, Ordering::Relaxed);
        (0..1, buffers.len() - 1)
    };
    let frames = buffers
        .iter()
        .map(|buffer| buffer.mDataByteSize as usize / (4 * buffer.mNumberChannels.max(1) as usize))
        .min()
        .unwrap_or(0)
        .min(interleaved.len() / 2);
    let mic_peak = downmix(&buffers[mic_streams], frames, interleaved, 0);
    let system_peak = downmix(&buffers[tap_index..=tap_index], frames, interleaved, 1);
    Meters::raise_peak(&meters.mic_peak, mic_peak);
    Meters::raise_peak(&meters.system_peak, system_peak);
    Meters::raise_peak(&meters.display_peak, mic_peak.max(system_peak));
    meters.frames.fetch_add(frames as u64, Ordering::Relaxed);
    frames
}

/// Average every channel of `buffers` into slot `slot` of each interleaved
/// stereo frame; returns the peak magnitude.
fn downmix(buffers: &[AudioBuffer], frames: usize, interleaved: &mut [f32], slot: usize) -> f32 {
    let channels: usize = buffers
        .iter()
        .map(|buffer| buffer.mNumberChannels as usize)
        .sum::<usize>()
        .max(1);
    let scale = 1.0 / channels as f32;
    let mut peak = 0f32;
    for frame in 0..frames {
        let mut sum = 0f32;
        for buffer in buffers {
            let Some(data) = NonNull::new(buffer.mData.cast::<f32>()) else {
                continue;
            };
            let stride = buffer.mNumberChannels as usize;
            for channel in 0..stride {
                // SAFETY: `frames` is bounded by every buffer's byte size.
                sum += unsafe { *data.as_ptr().add(frame * stride + channel) };
            }
        }
        let value = sum * scale;
        peak = peak.max(value.abs());
        interleaved[frame * 2 + slot] = value;
    }
    peak
}

#[cfg(test)]
mod tests {
    use std::ffi::c_void;

    use super::*;

    fn buffer(samples: &mut [f32], channels: u32) -> AudioBuffer {
        AudioBuffer {
            mNumberChannels: channels,
            mDataByteSize: (samples.len() * 4) as u32,
            mData: samples.as_mut_ptr().cast::<c_void>(),
        }
    }

    #[test]
    fn mixes_the_microphone_and_the_tap_into_stereo_frames() {
        let mut mic = [0.5f32, 0.25, -0.5];
        let mut tap = [0.25f32, 0.75, 0.5, 0.5, -0.5, 0.0];
        let buffers = [buffer(&mut mic, 1), buffer(&mut tap, 2)];
        let meters = Meters::default();
        let mut interleaved = vec![0f32; 8];
        let frames = mix(&buffers, 0..1, &mut interleaved, &meters);
        assert_eq!(frames, 3);
        assert_eq!(&interleaved[..6], &[0.5, 0.5, 0.25, 0.5, -0.5, -0.25]);
        assert_eq!(meters.take_peaks(), (0.5, 0.5));
        assert_eq!(meters.take_peaks(), (0.0, 0.0));
        assert_eq!(meters.frames(), 3);
        assert!(!meters.layout_fallback());
    }

    #[test]
    fn falls_back_when_the_buffer_layout_surprises() {
        let mut output_side = [0.0f32; 2];
        let mut mic = [0.3f32; 2];
        let mut tap = [0.25f32; 4];
        let buffers = [
            buffer(&mut output_side, 1),
            buffer(&mut mic, 1),
            buffer(&mut tap, 2),
        ];
        let meters = Meters::default();
        let mut interleaved = vec![0f32; 4];
        mix(&buffers, 0..3, &mut interleaved, &meters);
        assert!(meters.layout_fallback());
        assert_eq!(interleaved, vec![0.0, 0.25, 0.0, 0.25]);
    }
}
