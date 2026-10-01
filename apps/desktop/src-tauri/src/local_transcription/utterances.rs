//! Split a recording into the stretches worth transcribing.
//!
//! A meeting channel is mostly the other side talking, and the echo gate
//! leaves the microphone digitally silent meanwhile. Feeding silence to a
//! speech model wastes time and invites invented phrases, so audio is cut into
//! speech regions by frame energy first. A region's start and end are also its
//! timestamps: all a two-channel transcript needs to interleave the speakers,
//! and the only timing a model without timestamps (Qwen3-ASR) can give.

use std::ops::Range;

const RATE: usize = 16_000;
/// 20 ms analysis frames.
const FRAME: usize = RATE / 50;
/// RMS below about 0.003 is room tone, not speech.
const MIN_SPEECH_ENERGY: f32 = 1e-5;
/// Speech must stand this far above the channel's quiet frames.
const NOISE_MARGIN: f32 = 6.0;
/// The adaptive threshold never rises above RMS 0.01: a short recording that
/// is speech almost throughout has no quiet frames to learn a floor from.
const MAX_SPEECH_THRESHOLD: f32 = 1e-4;
/// Regions with less speech than this are clicks and breaths.
const MIN_SPEECH_FRAMES: usize = 10;
/// Context kept on each side of a region.
const PAD_FRAMES: usize = 15;

/// How regions are grouped for one speech model.
#[derive(Clone, Copy, Debug)]
pub struct ChunkPlan {
    /// Pauses shorter than this stay inside one region.
    pub close_gap_ms: u32,
    /// Regions longer than this split at their quietest frame.
    pub max_chunk_ms: u32,
}

/// Whisper decodes 30-second windows and times segments inside them, so long
/// regions cost nothing extra and keep their own timestamps.
pub const WHISPER_PLAN: ChunkPlan = ChunkPlan {
    close_gap_ms: 2_000,
    max_chunk_ms: 28_000,
};

/// Qwen3-ASR returns one text per region and no timestamps, so regions stay
/// short: their edges are the transcript's only timing.
pub const QWEN_PLAN: ChunkPlan = ChunkPlan {
    close_gap_ms: 600,
    max_chunk_ms: 12_000,
};

/// Sample ranges of `samples` (16 kHz mono) that carry speech, in order.
pub fn speech_regions(samples: &[f32], plan: ChunkPlan) -> Vec<Range<usize>> {
    let energies: Vec<f32> = samples
        .chunks(FRAME)
        .map(|frame| frame.iter().map(|sample| sample * sample).sum::<f32>() / frame.len() as f32)
        .collect();
    if energies.is_empty() {
        return Vec::new();
    }
    let threshold =
        MIN_SPEECH_ENERGY.max((NOISE_MARGIN * quiet_energy(&energies)).min(MAX_SPEECH_THRESHOLD));
    let speech: Vec<bool> = energies.iter().map(|energy| *energy > threshold).collect();

    let close_gap = plan.close_gap_ms as usize * RATE / 1_000 / FRAME;
    let max_frames = (plan.max_chunk_ms as usize * RATE / 1_000 / FRAME).max(1);
    let mut regions = Vec::new();
    for (start, end) in runs(&speech, close_gap) {
        let speech_frames = speech[start..end].iter().filter(|flag| **flag).count();
        if speech_frames < MIN_SPEECH_FRAMES {
            continue;
        }
        // Pad only the run's outer edges: an internal cut already sits in the
        // quietest frame, and padding it would read that audio twice.
        let padded_start = start.saturating_sub(PAD_FRAMES);
        let padded_end = (end + PAD_FRAMES).min(energies.len());
        for (piece_start, piece_end) in split_long(&energies, padded_start, padded_end, max_frames)
        {
            regions.push(piece_start * FRAME..(piece_end * FRAME).min(samples.len()));
        }
    }
    trim_overlaps(regions)
}

/// The energy of the channel's quieter frames: the 20th percentile.
fn quiet_energy(energies: &[f32]) -> f32 {
    let mut sorted = energies.to_vec();
    sorted.sort_by(f32::total_cmp);
    sorted[(sorted.len() - 1) / 5]
}

/// Frame runs of speech, bridging pauses up to `close_gap` frames.
fn runs(speech: &[bool], close_gap: usize) -> Vec<(usize, usize)> {
    let mut runs: Vec<(usize, usize)> = Vec::new();
    for (index, is_speech) in speech.iter().enumerate() {
        if !is_speech {
            continue;
        }
        match runs.last_mut() {
            Some((_, end)) if index - *end <= close_gap => *end = index + 1,
            _ => runs.push((index, index + 1)),
        }
    }
    runs
}

/// Cut `[start, end)` into pieces of at most `max_frames`, each cut at the
/// quietest frame of the piece's last quarter so words stay whole.
fn split_long(
    energies: &[f32],
    start: usize,
    end: usize,
    max_frames: usize,
) -> Vec<(usize, usize)> {
    let mut pieces = Vec::new();
    let mut cursor = start;
    while end - cursor > max_frames {
        let search_from = cursor + max_frames * 3 / 4;
        let search_to = cursor + max_frames;
        let cut = (search_from..search_to)
            .min_by(|left, right| energies[*left].total_cmp(&energies[*right]))
            .unwrap_or(search_to);
        let cut = cut.max(cursor + 1);
        pieces.push((cursor, cut));
        cursor = cut;
    }
    pieces.push((cursor, end));
    pieces
}

/// Padding can make neighbors overlap; start each region where the previous
/// one ends so no audio is read twice and no region outgrows its cap.
fn trim_overlaps(regions: Vec<Range<usize>>) -> Vec<Range<usize>> {
    let mut trimmed: Vec<Range<usize>> = Vec::with_capacity(regions.len());
    for mut region in regions {
        if let Some(last) = trimmed.last() {
            region.start = region.start.max(last.end);
        }
        if region.start < region.end {
            trimmed.push(region);
        }
    }
    trimmed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(seconds: f32, amplitude: f32) -> Vec<f32> {
        (0..(seconds * RATE as f32) as usize)
            .map(|index| amplitude * (index as f32 * 0.07).sin())
            .collect()
    }

    fn silence(seconds: f32) -> Vec<f32> {
        vec![0.0; (seconds * RATE as f32) as usize]
    }

    fn seconds(range: &Range<usize>) -> (f32, f32) {
        (
            range.start as f32 / RATE as f32,
            range.end as f32 / RATE as f32,
        )
    }

    #[test]
    fn finds_speech_between_silences_with_padding() {
        let samples = [silence(3.0), tone(2.0, 0.2), silence(5.0)].concat();
        let regions = speech_regions(&samples, WHISPER_PLAN);
        assert_eq!(regions.len(), 1);
        let (start, end) = seconds(&regions[0]);
        assert!(
            (2.6..=3.0).contains(&start) && (5.0..=5.4).contains(&end),
            "{start} {end}"
        );
    }

    #[test]
    fn bridges_short_pauses_and_splits_at_long_ones() {
        let samples = [
            tone(1.0, 0.2),
            silence(1.0),
            tone(1.0, 0.2),
            silence(4.0),
            tone(1.0, 0.2),
        ]
        .concat();
        let regions = speech_regions(&samples, WHISPER_PLAN);
        assert_eq!(regions.len(), 2, "{regions:?}");
    }

    #[test]
    fn drops_clicks_and_room_tone() {
        let mut samples = silence(4.0);
        samples[RATE..RATE + 80].fill(0.5);
        let hiss: Vec<f32> = (0..RATE * 2)
            .map(|index| 0.001 * (index as f32).sin())
            .collect();
        samples.extend(hiss);
        assert!(speech_regions(&samples, WHISPER_PLAN).is_empty());
        assert!(speech_regions(&[], WHISPER_PLAN).is_empty());
    }

    #[test]
    fn caps_region_length() {
        let plan = ChunkPlan {
            close_gap_ms: 2_000,
            max_chunk_ms: 10_000,
        };
        let samples = tone(35.0, 0.2);
        let regions = speech_regions(&samples, plan);
        assert!(regions.len() >= 4, "{regions:?}");
        assert_eq!(regions.first().unwrap().start, 0);
        assert_eq!(regions.last().unwrap().end, samples.len());
        for pair in regions.windows(2) {
            assert_eq!(pair[0].end, pair[1].start);
        }
        assert!(regions.iter().all(|region| region.len() <= 10 * RATE));
    }
}
