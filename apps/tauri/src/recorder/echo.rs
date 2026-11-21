//! Far-end echo suppression for the microphone channel.
//!
//! With speakers, the remote side plays out of the speakers and leaks back into
//! the microphone. The system channel is recorded on the same clock, so it is an
//! exact reference for what the speakers played: the delay comes from a
//! log-envelope cross-correlation, the per-band coupling from medians over
//! frames where the far end is active, and every microphone frame that does not
//! rise above the echo predicted from the reference is gated to silence. Frames
//! that do carry near-end speech get spectral subtraction. A weak correlation
//! means headphones, where nothing leaks, and the microphone passes through.
//!
//! The math follows the reference recorder this feature replaces, except that
//! the delay search looks only at far-end-active frames; it streams frame by
//! frame so an hour-long meeting never holds a spectrogram in memory.

use std::sync::Arc;

use realfft::num_complex::Complex32;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};

/// Samples per second of both channels.
const RATE: usize = 16_000;
/// Analysis window; 32 ms at 16 kHz.
const N_FFT: usize = 512;
const HOP: usize = N_FFT / 2;
const BINS: usize = N_FFT / 2 + 1;
/// The longest speaker-to-microphone delay searched for.
const MAX_LAG_SECONDS: f32 = 0.5;
/// Below this envelope correlation the channels are independent (headphones).
const MIN_COUPLING: f32 = 0.3;
/// Fewer far-end frames than this (about a second) can't establish coupling.
const MIN_ACTIVE_FRAMES: usize = 60;
/// At most this many far-end-active frames feed the per-band coupling medians.
const COUPLING_SAMPLE_FRAMES: usize = 6_000;
/// Room reverb: the predicted echo decays by this factor per frame.
const REVERB_DECAY: f32 = 0.75;

/// What [`suppress`] concluded, for the transcript's diagnostics.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EchoOutcome {
    /// The channels correlate: the microphone was gated against the reference.
    Suppressed { delay_ms: u32 },
    /// No usable reference, or no correlation (headphones): passed through.
    PassedThrough,
}

/// Remove far-end echo from `mic` using the sample-aligned `reference`.
/// Both are 16 kHz mono; the result has the length of the shorter input.
pub fn suppress(mic: &[f32], reference: &[f32]) -> (Vec<f32>, EchoOutcome) {
    let length = mic.len().min(reference.len());
    let mic = &mic[..length];
    let reference = &reference[..length];
    if length < N_FFT * 8 || reference.iter().all(|sample| *sample == 0.0) {
        return (mic.to_vec(), EchoOutcome::PassedThrough);
    }
    let analysis = Analysis::new(length);
    let mic_totals: Vec<f32> = (0..analysis.frames)
        .map(|frame| total_power(&analysis.power(mic, frame)))
        .collect();
    let reference_totals: Vec<f32> = (0..analysis.frames)
        .map(|frame| total_power(&analysis.power(reference, frame)))
        .collect();

    let Some(delay) = envelope_delay(&mic_totals, &reference_totals) else {
        return (mic.to_vec(), EchoOutcome::PassedThrough);
    };
    let Some(coupling) = estimate_coupling(
        &analysis,
        mic,
        reference,
        &mic_totals,
        &reference_totals,
        delay,
    ) else {
        return (mic.to_vec(), EchoOutcome::PassedThrough);
    };

    let noise_floor = percentile(&mic_totals, 10.0);
    let mut predictor = EchoPredictor::new(&analysis, reference, delay, &coupling);
    let near: Vec<bool> = (0..analysis.frames)
        .map(|frame| {
            let echo_total: f32 = predictor.next(frame).iter().sum();
            mic_totals[frame] > 3.0 * echo_total + 3.0 * noise_floor
        })
        .collect();
    let gate = speech_gate(&near);

    let mut predictor = EchoPredictor::new(&analysis, reference, delay, &coupling);
    let mut output = vec![0.0f32; analysis.frames * HOP + N_FFT];
    let mut spectrum = analysis.forward.make_output_vec();
    let mut buffer = analysis.forward.make_input_vec();
    let mut synthesized = analysis.inverse.make_output_vec();
    for (frame, open) in gate.iter().enumerate() {
        let echo = predictor.next(frame);
        analysis.spectrum(mic, frame, &mut buffer, &mut spectrum);
        for (value, echo_power) in spectrum.iter_mut().zip(echo) {
            let power = value.norm_sqr();
            let gain = if *open {
                (1.0 - 2.0 * echo_power / (power + 1e-12)).clamp(0.1, 1.0)
            } else {
                0.0
            };
            *value *= gain;
        }
        spectrum[0].im = 0.0;
        spectrum[BINS - 1].im = 0.0;
        analysis
            .inverse
            .process(&mut spectrum, &mut synthesized)
            .expect("inverse FFT buffers are sized by their planner");
        let start = frame * HOP;
        for (offset, sample) in synthesized.iter().enumerate() {
            output[start + offset] += sample / N_FFT as f32;
        }
    }
    let cleaned = output[HOP..HOP + length].to_vec();
    let delay_ms = (delay * HOP * 1000 / RATE) as u32;
    (cleaned, EchoOutcome::Suppressed { delay_ms })
}

/// Framing shared by every pass: one leading hop of zeros, then hops of the
/// signal, zero-padded so the last frame is complete.
struct Analysis {
    frames: usize,
    padded_length: usize,
    window: Vec<f32>,
    forward: Arc<dyn RealToComplex<f32>>,
    inverse: Arc<dyn ComplexToReal<f32>>,
}

impl Analysis {
    fn new(length: usize) -> Self {
        let pad = (HOP - (length + N_FFT) % HOP) % HOP + HOP;
        let padded_length = HOP + length + pad;
        let frames = (padded_length - N_FFT) / HOP + 1;
        let window = (0..N_FFT)
            .map(|index| {
                0.5 - 0.5 * (2.0 * std::f32::consts::PI * index as f32 / N_FFT as f32).cos()
            })
            .collect();
        let mut planner = RealFftPlanner::<f32>::new();
        Self {
            frames,
            padded_length,
            window,
            forward: planner.plan_fft_forward(N_FFT),
            inverse: planner.plan_fft_inverse(N_FFT),
        }
    }

    /// The windowed spectrum of `frame` of `signal`.
    fn spectrum(
        &self,
        signal: &[f32],
        frame: usize,
        buffer: &mut [f32],
        spectrum: &mut [Complex32],
    ) {
        let start = frame * HOP;
        for (offset, slot) in buffer.iter_mut().enumerate() {
            let padded_index = start + offset;
            let sample = if padded_index < HOP || padded_index >= HOP + signal.len() {
                0.0
            } else {
                signal[padded_index - HOP]
            };
            *slot = sample * self.window[offset];
        }
        debug_assert!(start + N_FFT <= self.padded_length);
        self.forward
            .process(buffer, spectrum)
            .expect("forward FFT buffers are sized by their planner");
    }

    /// Per-bin power of `frame` of `signal`.
    fn power(&self, signal: &[f32], frame: usize) -> Vec<f32> {
        let mut buffer = self.forward.make_input_vec();
        let mut spectrum = self.forward.make_output_vec();
        self.spectrum(signal, frame, &mut buffer, &mut spectrum);
        spectrum.iter().map(|value| value.norm_sqr()).collect()
    }
}

fn total_power(power: &[f32]) -> f32 {
    power.iter().sum()
}

/// The frame lag at which the microphone's log-energy envelope best follows
/// the reference's, or `None` when even the best match is too weak to be
/// leakage. Only frames where the far end is active count: while the near end
/// talks into a quiet line, the microphone is loud exactly when the reference
/// is not, and a whole-signal correlation would read that as "no coupling" in
/// every ordinary turn-taking conversation.
fn envelope_delay(mic_totals: &[f32], reference_totals: &[f32]) -> Option<usize> {
    let frames = mic_totals.len();
    let mic_log: Vec<f32> = mic_totals.iter().map(|total| (total + 1e-9).ln()).collect();
    let reference_log: Vec<f32> = reference_totals
        .iter()
        .map(|total| (total + 1e-9).ln())
        .collect();
    let threshold = 0.1 * percentile(reference_totals, 95.0);
    let max_lag = ((MAX_LAG_SECONDS * RATE as f32 / HOP as f32) as usize).min(frames / 2);
    let mut best: Option<(usize, f32)> = None;
    for lag in 0..max_lag {
        let pairs: Vec<(f32, f32)> = (lag..frames)
            .filter(|frame| reference_totals[frame - lag] > threshold)
            .map(|frame| (mic_log[frame], reference_log[frame - lag]))
            .collect();
        if pairs.len() < MIN_ACTIVE_FRAMES {
            continue;
        }
        let correlation = pearson(&pairs);
        if best.is_none_or(|(_, top)| correlation > top) {
            best = Some((lag, correlation));
        }
    }
    best.filter(|(_, correlation)| *correlation >= MIN_COUPLING)
        .map(|(lag, _)| lag)
}

fn pearson(pairs: &[(f32, f32)]) -> f32 {
    let count = pairs.len() as f32;
    let (mean_left, mean_right) = pairs.iter().fold((0.0, 0.0), |(left, right), (x, y)| {
        (left + x / count, right + y / count)
    });
    let (mut covariance, mut left_variance, mut right_variance) = (0.0f32, 0.0f32, 0.0f32);
    for (left, right) in pairs {
        let (left, right) = (left - mean_left, right - mean_right);
        covariance += left * right;
        left_variance += left * left;
        right_variance += right * right;
    }
    covariance / ((left_variance * right_variance).sqrt() + 1e-9)
}

/// Per-band coupling from microphone to reference, capped at ten times the
/// whole-frame coupling. Medians over far-end-active frames stay robust while
/// near-end talk occupies less than half of them.
fn estimate_coupling(
    analysis: &Analysis,
    mic: &[f32],
    reference: &[f32],
    mic_totals: &[f32],
    reference_totals: &[f32],
    delay: usize,
) -> Option<Vec<f32>> {
    let aligned_totals: Vec<f32> = (0..analysis.frames)
        .map(|frame| {
            frame
                .checked_sub(delay)
                .map_or(0.0, |source| reference_totals[source])
        })
        .collect();
    let threshold = 0.1 * percentile(&aligned_totals, 95.0);
    let active: Vec<usize> = (0..analysis.frames)
        .filter(|frame| aligned_totals[*frame] > threshold)
        .collect();
    if active.is_empty() {
        return None;
    }
    let active_mic: Vec<f32> = active.iter().map(|frame| mic_totals[*frame]).collect();
    let active_reference: Vec<f32> = active.iter().map(|frame| aligned_totals[*frame]).collect();
    let frame_coupling =
        percentile(&active_mic, 50.0) / (percentile(&active_reference, 50.0) + 1e-12);

    let stride = active.len().div_ceil(COUPLING_SAMPLE_FRAMES);
    let sampled: Vec<usize> = active.iter().step_by(stride).copied().collect();
    let mut mic_bands: Vec<Vec<f32>> = (0..BINS)
        .map(|_| Vec::with_capacity(sampled.len()))
        .collect();
    let mut reference_bands: Vec<Vec<f32>> = (0..BINS)
        .map(|_| Vec::with_capacity(sampled.len()))
        .collect();
    for frame in sampled {
        let mic_power = analysis.power(mic, frame);
        let reference_power = analysis.power(reference, frame - delay);
        for bin in 0..BINS {
            mic_bands[bin].push(mic_power[bin]);
            reference_bands[bin].push(reference_power[bin]);
        }
    }
    let cap = 10.0 * frame_coupling;
    Some(
        (0..BINS)
            .map(|bin| {
                let coupling = percentile(&mic_bands[bin], 50.0)
                    / (percentile(&reference_bands[bin], 50.0) + 1e-12);
                coupling.min(cap)
            })
            .collect(),
    )
}

/// Streams the predicted echo power spectrum frame by frame: the reference at
/// the measured delay, widened by one frame each way (the true delay falls
/// between frames), held by a decaying running maximum (room reverb), and
/// scaled by the per-band coupling.
struct EchoPredictor<'a> {
    analysis: &'a Analysis,
    reference: &'a [f32],
    delay: usize,
    coupling: &'a [f32],
    /// Reference power spectra by frame, for the frames the widening reads.
    recent: Vec<(usize, Vec<f32>)>,
    held: Vec<f32>,
    echo: Vec<f32>,
}

impl<'a> EchoPredictor<'a> {
    fn new(
        analysis: &'a Analysis,
        reference: &'a [f32],
        delay: usize,
        coupling: &'a [f32],
    ) -> Self {
        Self {
            analysis,
            reference,
            delay,
            coupling,
            recent: Vec::with_capacity(4),
            held: vec![0.0; BINS],
            echo: vec![0.0; BINS],
        }
    }

    fn reference_power(&mut self, frame: usize) -> &[f32] {
        if let Some(index) = self.recent.iter().position(|(cached, _)| *cached == frame) {
            return &self.recent[index].1;
        }
        if self.recent.len() == 3 {
            // Frames advance monotonically, so the earliest cached frame is
            // the one no later request can need.
            let earliest = (0..self.recent.len())
                .min_by_key(|index| self.recent[*index].0)
                .expect("the cache is full");
            self.recent.remove(earliest);
        }
        let power = self.analysis.power(self.reference, frame);
        self.recent.push((frame, power));
        &self.recent.last().expect("just pushed").1
    }

    /// The predicted echo power for `frame`; frames must arrive in order.
    fn next(&mut self, frame: usize) -> &[f32] {
        let mut widened = vec![0.0f32; BINS];
        let lags = [
            self.delay.checked_sub(1),
            Some(self.delay),
            Some(self.delay + 1),
        ];
        for lag in lags.into_iter().flatten() {
            let Some(source) = frame.checked_sub(lag) else {
                continue;
            };
            let power = self.reference_power(source).to_vec();
            for (slot, value) in widened.iter_mut().zip(power) {
                *slot = slot.max(value);
            }
        }
        let bins = widened
            .iter()
            .zip(self.held.iter_mut())
            .zip(self.echo.iter_mut())
            .zip(self.coupling);
        for (((widened, held), echo), coupling) in bins {
            *held = if frame == 0 {
                *widened
            } else {
                widened.max(REVERB_DECAY * *held)
            };
            *echo = coupling * *held;
        }
        &self.echo
    }
}

/// Near-end speech must hold for 3 of 5 frames to open the gate, which then
/// stays open for six frames (about 100 ms) on each side.
fn speech_gate(near: &[bool]) -> Vec<bool> {
    let onset = window_count(near, 2)
        .into_iter()
        .map(|count| count >= 3)
        .collect::<Vec<_>>();
    window_count(&onset, 6)
        .into_iter()
        .map(|count| count > 0)
        .collect()
}

/// How many of the frames within `radius` of each frame are set.
fn window_count(flags: &[bool], radius: usize) -> Vec<usize> {
    (0..flags.len())
        .map(|center| {
            let start = center.saturating_sub(radius);
            let end = (center + radius + 1).min(flags.len());
            flags[start..end].iter().filter(|flag| **flag).count()
        })
        .collect()
}

/// Linear-interpolated percentile, as numpy computes it.
fn percentile(values: &[f32], rank: f32) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f32::total_cmp);
    let position = rank / 100.0 * (sorted.len() - 1) as f32;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    let fraction = position - lower as f32;
    sorted[lower] + (sorted[upper] - sorted[lower]) * fraction
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic pseudo-noise so tests need no RNG dependency.
    fn noise(length: usize, seed: u32) -> Vec<f32> {
        let mut state = seed;
        (0..length)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (state >> 8) as f32 / (1u32 << 24) as f32 - 0.5
            })
            .collect()
    }

    /// Speech-like bursts: noise switched on and off every `period` samples.
    fn bursts(length: usize, period: usize, phase: usize, seed: u32) -> Vec<f32> {
        noise(length, seed)
            .into_iter()
            .enumerate()
            .map(|(index, sample)| {
                if ((index + phase) / period).is_multiple_of(2) {
                    sample * 0.4
                } else {
                    0.0
                }
            })
            .collect()
    }

    fn energy(signal: &[f32]) -> f32 {
        signal.iter().map(|sample| sample * sample).sum::<f32>() / signal.len().max(1) as f32
    }

    #[test]
    fn gates_a_delayed_attenuated_copy_of_the_reference() {
        let length = RATE * 6;
        let reference = bursts(length, 4_000, 0, 7);
        let delay = 1_600; // 100 ms speaker-to-mic path
        let mut mic = vec![0.0f32; length];
        for index in delay..length {
            mic[index] = 0.3 * reference[index - delay];
        }
        let (cleaned, outcome) = suppress(&mic, &reference);
        assert!(
            matches!(outcome, EchoOutcome::Suppressed { delay_ms } if (80..=130).contains(&delay_ms)),
            "{outcome:?}"
        );
        assert!(
            energy(&cleaned) < 0.05 * energy(&mic),
            "echo energy left: {} of {}",
            energy(&cleaned),
            energy(&mic)
        );
    }

    /// A conversation: far end, pause, near end, pause, with irregular
    /// lengths so no lag lines the turns up by accident. Returns the far-end
    /// and near-end talk as separate signals.
    fn conversation(length: usize) -> (Vec<f32>, Vec<f32>) {
        let mut far = vec![0.0f32; length];
        let mut near = vec![0.0f32; length];
        let far_noise = noise(length, 31);
        let near_noise = noise(length, 37);
        let mut state = 41u32;
        let mut draw = |low: usize, high: usize| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            low + (state >> 8) as usize % (high - low)
        };
        let mut cursor = 0;
        let mut far_turn = true;
        while cursor < length {
            let talk = draw(RATE * 3 / 10, RATE * 12 / 10);
            let end = (cursor + talk).min(length);
            let (target, source) = if far_turn {
                (&mut far, &far_noise)
            } else {
                (&mut near, &near_noise)
            };
            for index in cursor..end {
                target[index] = 0.4 * source[index];
            }
            far_turn = !far_turn;
            cursor = end + draw(RATE / 5, RATE * 6 / 10);
        }
        (far, near)
    }

    #[test]
    fn keeps_the_near_end_and_gates_the_echo_in_a_conversation() {
        let length = RATE * 12;
        let (reference, near_end) = conversation(length);
        let delay = 800;
        let room = noise(length, 43);
        let mic: Vec<f32> = (0..length)
            .map(|index| {
                let echo = if index >= delay {
                    0.3 * reference[index - delay]
                } else {
                    0.0
                };
                near_end[index] + echo + 0.002 * room[index]
            })
            .collect();
        let (cleaned, outcome) = suppress(&mic, &reference);
        assert!(
            matches!(outcome, EchoOutcome::Suppressed { .. }),
            "{outcome:?}"
        );

        let echo_only = |index: &usize| {
            *index >= delay && reference[*index - delay] != 0.0 && near_end[*index] == 0.0
        };
        let near_only = |index: &usize| {
            near_end[*index] != 0.0 && (*index < delay || reference[*index - delay] == 0.0)
        };
        let sum = |signal: &[f32], keep: &dyn Fn(&usize) -> bool| -> f32 {
            (0..length)
                .filter(|index| keep(index))
                .map(|index| signal[index].powi(2))
                .sum()
        };
        let kept = sum(&cleaned, &near_only);
        let spoken = sum(&near_end, &near_only);
        assert!(kept > 0.7 * spoken, "kept {kept} of {spoken}");
        let leaked = sum(&cleaned, &echo_only);
        let echoed = sum(&mic, &echo_only);
        assert!(leaked < 0.1 * echoed, "leaked {leaked} of {echoed}");
    }

    #[test]
    fn passes_independent_channels_through_unchanged() {
        let length = RATE * 6;
        let reference = bursts(length, 4_000, 0, 17);
        let mic: Vec<f32> = noise(length, 19)
            .into_iter()
            .map(|sample| sample * 0.2)
            .collect();
        let (cleaned, outcome) = suppress(&mic, &reference);
        assert_eq!(outcome, EchoOutcome::PassedThrough);
        assert_eq!(cleaned, mic);
    }

    #[test]
    fn passes_through_without_a_reference() {
        let mic = noise(RATE * 2, 23);
        let (cleaned, outcome) = suppress(&mic, &vec![0.0; RATE * 2]);
        assert_eq!(outcome, EchoOutcome::PassedThrough);
        assert_eq!(cleaned, mic);
        let (short, _) = suppress(&mic[..100], &mic[..100]);
        assert_eq!(short.len(), 100);
    }

    #[test]
    fn reconstructs_the_signal_when_nothing_is_gated() {
        let analysis = Analysis::new(RATE);
        let signal = noise(RATE, 29);
        let mut output = vec![0.0f32; analysis.frames * HOP + N_FFT];
        let mut buffer = analysis.forward.make_input_vec();
        let mut spectrum = analysis.forward.make_output_vec();
        let mut synthesized = analysis.inverse.make_output_vec();
        for frame in 0..analysis.frames {
            analysis.spectrum(&signal, frame, &mut buffer, &mut spectrum);
            analysis
                .inverse
                .process(&mut spectrum, &mut synthesized)
                .unwrap();
            for (offset, sample) in synthesized.iter().enumerate() {
                output[frame * HOP + offset] += sample / N_FFT as f32;
            }
        }
        for (rebuilt, original) in output[HOP..HOP + RATE].iter().zip(&signal) {
            assert!((rebuilt - original).abs() < 1e-4);
        }
    }

    #[test]
    fn percentile_interpolates_like_numpy() {
        assert_eq!(percentile(&[1.0, 2.0, 3.0, 4.0], 50.0), 2.5);
        assert_eq!(percentile(&[5.0], 95.0), 5.0);
        assert_eq!(percentile(&[], 10.0), 0.0);
    }

    #[test]
    fn the_gate_needs_three_of_five_frames_and_holds_six() {
        let mut near = vec![false; 30];
        near[10] = true;
        assert!(speech_gate(&near).iter().all(|open| !open));
        near[11] = true;
        near[12] = true;
        let gate = speech_gate(&near);
        assert!(gate[5] && gate[17] && !gate[3] && !gate[20], "{gate:?}");
    }
}
