//! The recording's watchdog: once a second it looks at what the IO thread
//! delivered and decides whether capture needs rebuilding, whether the user
//! should hear about it, or whether a forgotten recording should end.
//!
//! Pure policy over [`Observation`]s, so every rule is testable without audio
//! hardware; the recorder applies the [`Action`]s.

/// A one-second look at the capture.
#[derive(Clone, Copy, Debug, Default)]
pub struct Observation {
    /// Frames the IO proc has delivered since the current part started.
    pub frames: u64,
    /// Loudest microphone sample during the last second.
    pub mic_peak: f32,
    /// Loudest system-audio sample during the last second.
    pub system_peak: f32,
    /// The default input or output device differs from the one being recorded.
    pub devices_changed: bool,
    /// The part's writer hit an error and stopped saving audio.
    pub write_failed: bool,
}

/// Something the user is told about; each is reported once per recording.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Warning {
    /// Nothing arrives even after a rebuild: permissions or hardware.
    NoAudio,
    /// The microphone delivers digital silence: muted, or no permission.
    MicrophoneSilent,
    /// Both sides have been quiet long enough that the recording was forgotten.
    Idle,
    /// Audio stopped reaching the disk (full, or unwritable).
    WriteFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// Tear the capture down and build it again on the current devices,
    /// continuing in a new part.
    Rebuild,
    Warn(Warning),
    /// End the recording as if the user had stopped it.
    Stop,
}

/// A permission prompt still open when capture starts leaves the device
/// silent, so the first rebuild comes quickly.
const FIRST_FRAMES_SECONDS: u32 = 3;
const NO_AUDIO_SECONDS: u32 = 8;
/// Frames that stop arriving mean the device went away.
const STALL_SECONDS: u32 = 3;
const MIC_SILENT_SECONDS: u32 = 10;
/// Below this peak a second counts as quiet (about -50 dBFS).
pub const QUIET_PEAK: f32 = 0.003;
pub const IDLE_WARN_SECONDS: u32 = 5 * 60;
pub const IDLE_STOP_SECONDS: u32 = 15 * 60;

/// Rebuilds never come closer together than this, so a flapping device can't
/// spin the recorder.
const REBUILD_SPACING_SECONDS: u32 = 10;

#[derive(Debug, Default)]
pub struct Watchdog {
    /// Seconds since the current part started.
    part_seconds: u32,
    /// Seconds since the last rebuild was requested, if any was.
    since_rebuild: Option<u32>,
    early_rebuilds: u32,
    last_frames: u64,
    stalled_seconds: u32,
    mic_zero_seconds: u32,
    quiet_seconds: u32,
    warned: Vec<Warning>,
}

impl Watchdog {
    /// Feed one second; returns what to do about it.
    pub fn tick(&mut self, observation: Observation) -> Vec<Action> {
        self.part_seconds += 1;
        if let Some(since) = self.since_rebuild.as_mut() {
            *since += 1;
        }
        let mut actions = Vec::new();

        let delivering = observation.frames > self.last_frames;
        self.stalled_seconds = if delivering || observation.frames == 0 {
            0
        } else {
            self.stalled_seconds + 1
        };
        self.last_frames = observation.frames;

        if observation.frames == 0 {
            // Nothing at all: a permission prompt open at start, a device that
            // never came up, or a rebuild that failed. A recording that never
            // hears anything is as forgotten as a quiet one.
            if self.count_quiet(true, &mut actions) {
                return actions;
            }
            if self.part_seconds >= FIRST_FRAMES_SECONDS && self.early_rebuilds == 0 {
                self.early_rebuilds = 1;
                actions.push(self.rebuild());
            } else if self.part_seconds >= NO_AUDIO_SECONDS {
                self.warn_once(Warning::NoAudio, &mut actions);
                // Keep trying: a later device or a granted permission recovers.
                if self.can_rebuild() {
                    actions.push(self.rebuild());
                }
            }
            return actions;
        }

        if observation.write_failed {
            self.warn_once(Warning::WriteFailed, &mut actions);
        }
        let lost = observation.devices_changed
            || observation.write_failed
            || self.stalled_seconds >= STALL_SECONDS;
        if lost && self.can_rebuild() {
            actions.push(self.rebuild());
            return actions;
        }

        self.mic_zero_seconds = if observation.mic_peak == 0.0 {
            self.mic_zero_seconds + 1
        } else {
            0
        };
        if self.mic_zero_seconds >= MIC_SILENT_SECONDS {
            self.warn_once(Warning::MicrophoneSilent, &mut actions);
        }

        let quiet = observation.mic_peak < QUIET_PEAK && observation.system_peak < QUIET_PEAK;
        self.count_quiet(quiet, &mut actions);
        actions
    }

    /// Advance the quiet clock: warn after five minutes, stop after fifteen.
    /// Returns whether the recording should stop.
    fn count_quiet(&mut self, quiet: bool, actions: &mut Vec<Action>) -> bool {
        self.quiet_seconds = if quiet { self.quiet_seconds + 1 } else { 0 };
        if self.quiet_seconds >= IDLE_STOP_SECONDS {
            actions.push(Action::Stop);
            return true;
        }
        if self.quiet_seconds >= IDLE_WARN_SECONDS {
            self.warn_once(Warning::Idle, actions);
        } else if self.quiet_seconds == 0 {
            // Talking again: a later lull deserves its own warning.
            self.warned.retain(|warning| *warning != Warning::Idle);
        }
        false
    }

    fn can_rebuild(&self) -> bool {
        self.since_rebuild
            .is_none_or(|since| since >= REBUILD_SPACING_SECONDS)
    }

    /// Record a rebuild: the next part starts counting from zero.
    fn rebuild(&mut self) -> Action {
        self.since_rebuild = Some(0);
        self.part_seconds = 0;
        self.last_frames = 0;
        self.stalled_seconds = 0;
        Action::Rebuild
    }

    fn warn_once(&mut self, warning: Warning, actions: &mut Vec<Action>) {
        if !self.warned.contains(&warning) {
            self.warned.push(warning);
            actions.push(Action::Warn(warning));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn speaking(frames: u64) -> Observation {
        Observation {
            frames,
            mic_peak: 0.2,
            system_peak: 0.1,
            ..Observation::default()
        }
    }

    fn quiet(frames: u64) -> Observation {
        Observation {
            frames,
            mic_peak: 0.001,
            ..Observation::default()
        }
    }

    #[test]
    fn rebuilds_once_when_nothing_arrives_then_warns() {
        let mut watchdog = Watchdog::default();
        let mut actions = Vec::new();
        for _ in 0..12 {
            actions.extend(watchdog.tick(Observation::default()));
        }
        assert_eq!(
            actions,
            vec![Action::Rebuild, Action::Warn(Warning::NoAudio)]
        );
    }

    #[test]
    fn keeps_retrying_a_capture_that_delivers_nothing_and_ends_it_eventually() {
        let mut watchdog = Watchdog::default();
        let mut actions = Vec::new();
        for _ in 0..40 {
            actions.extend(watchdog.tick(Observation::default()));
        }
        assert_eq!(
            actions,
            vec![
                Action::Rebuild,
                Action::Warn(Warning::NoAudio),
                Action::Rebuild,
                Action::Rebuild,
                Action::Rebuild,
            ]
        );
        let mut last = Vec::new();
        for _ in 40..IDLE_STOP_SECONDS {
            last = watchdog.tick(Observation::default());
        }
        assert_eq!(last, vec![Action::Stop]);
    }

    #[test]
    fn rebuilds_when_the_writer_fails() {
        let mut watchdog = Watchdog::default();
        watchdog.tick(speaking(48_000));
        let failed = Observation {
            write_failed: true,
            ..speaking(96_000)
        };
        assert_eq!(
            watchdog.tick(failed),
            vec![Action::Warn(Warning::WriteFailed), Action::Rebuild]
        );
    }

    #[test]
    fn stays_quiet_while_audio_flows() {
        let mut watchdog = Watchdog::default();
        for second in 1..120 {
            assert!(watchdog.tick(speaking(second * 48_000)).is_empty());
        }
    }

    #[test]
    fn rebuilds_on_a_device_change_or_stall_but_not_in_a_burst() {
        let mut watchdog = Watchdog::default();
        watchdog.tick(speaking(48_000));
        let changed = Observation {
            devices_changed: true,
            ..speaking(96_000)
        };
        assert_eq!(watchdog.tick(changed), vec![Action::Rebuild]);
        watchdog.tick(speaking(48_000));
        assert!(watchdog
            .tick(Observation {
                devices_changed: true,
                ..speaking(96_000)
            })
            .is_empty());
        for _ in 0..3 {
            watchdog.tick(speaking(96_000));
        }
        let mut later = Vec::new();
        for _ in 0..10 {
            later.extend(watchdog.tick(speaking(96_000)));
        }
        assert_eq!(later, vec![Action::Rebuild]);
    }

    #[test]
    fn warns_about_a_silent_microphone_once() {
        let mut watchdog = Watchdog::default();
        let mut actions = Vec::new();
        for second in 1..40 {
            actions.extend(watchdog.tick(Observation {
                frames: second * 48_000,
                system_peak: 0.2,
                ..Observation::default()
            }));
        }
        assert_eq!(actions, vec![Action::Warn(Warning::MicrophoneSilent)]);
    }

    #[test]
    fn warns_when_idle_then_stops() {
        let mut watchdog = Watchdog::default();
        let mut actions = Vec::new();
        for second in 1..=u64::from(IDLE_STOP_SECONDS) {
            actions.extend(watchdog.tick(quiet(second * 48_000)));
        }
        assert_eq!(actions, vec![Action::Warn(Warning::Idle), Action::Stop]);
    }

    #[test]
    fn talking_resets_the_idle_clock() {
        let mut watchdog = Watchdog::default();
        let mut frames = 0;
        let mut actions = Vec::new();
        for _ in 0..2 {
            for _ in 0..IDLE_WARN_SECONDS + 10 {
                frames += 48_000;
                actions.extend(watchdog.tick(quiet(frames)));
            }
            frames += 48_000;
            actions.extend(watchdog.tick(speaking(frames)));
        }
        assert_eq!(
            actions,
            vec![Action::Warn(Warning::Idle), Action::Warn(Warning::Idle)]
        );
    }
}
