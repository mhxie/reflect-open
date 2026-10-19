//! Two devices' AI summaries of one body: both sides take the entry
//! generated first ([`settle`]), so no merge interleaves two summaries that
//! the shared `hash` would still read as fresh.

use reflect_frontmatter::{AiSummaryEntry, GeneratedAt, ai_summary_entry};

/// Give `first` and `second` the first-generated of their two `aiSummary`
/// entries in place of their own. Nothing changes when they don't carry two
/// different entries for one body (a side without an entry Reflect reads as
/// its own, different `hash`es, or the same entry lines), or when a settled
/// side would no longer read back with that entry (the replaced entry
/// defined an anchor the rest of the block uses, say).
pub(super) fn settle(first: &mut String, second: &mut String) {
    let (Some(first_entry), Some(second_entry)) =
        (ai_summary_entry(first), ai_summary_entry(second))
    else {
        return;
    };
    let first_lines = &first[first_entry.span.clone()];
    let second_lines = &second[second_entry.span.clone()];
    if first_entry.hash != second_entry.hash || first_lines == second_lines {
        return;
    }
    let kept = if generation_order(&first_entry, first_lines)
        <= generation_order(&second_entry, second_lines)
    {
        first_lines
    } else {
        second_lines
    }
    .to_string();
    let settled_first = splice(first, &first_entry, &kept);
    let settled_second = splice(second, &second_entry, &kept);
    if holds(&settled_first, &kept) && holds(&settled_second, &kept) {
        *first = settled_first;
        *second = settled_second;
    }
}

/// An entry's place in generation order, as one tuple: an entry without
/// `generatedAt` first (it predates the field), then valid instants by time,
/// then a value that isn't one, so a mangled stamp never wins; ties fall to
/// the entry lines. Only the two entries decide, never which side is local
/// or newer, so every device keeps the same one.
fn generation_order<'a>(
    entry: &'a AiSummaryEntry,
    lines: &'a str,
) -> (bool, Option<&'a str>, &'a str) {
    let (invalid, instant) = match &entry.generated_at {
        None => (false, None),
        Some(GeneratedAt::Instant(at)) => (false, Some(at.as_str())),
        Some(GeneratedAt::Invalid) => (true, None),
    };
    (invalid, instant, lines)
}

/// `source` with its summary entry's lines replaced by `lines`.
fn splice(source: &str, entry: &AiSummaryEntry, lines: &str) -> String {
    let mut out = String::with_capacity(source.len() + lines.len());
    out.push_str(&source[..entry.span.start]);
    out.push_str(lines);
    out.push_str(&source[entry.span.end..]);
    out
}

/// Whether `source` reads back with `lines` as its summary entry.
fn holds(source: &str, lines: &str) -> bool {
    ai_summary_entry(source).is_some_and(|entry| source[entry.span] == *lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: &str = "# Garden plan\n\nLong body both devices summarized.\n";
    const EARLY: &str = "2026-01-02T08:00:00.000Z";
    const LATE: &str = "2026-01-02T09:30:00.000Z";

    fn note(header: &str, body: &str) -> String {
        format!("---\n{header}---\n\n{body}")
    }

    fn summary(text: &str, generated_at: Option<&str>) -> String {
        let mut entry = format!("aiSummary:\n  text: {text}\n  hash: 0123456789abcdef\n");
        if let Some(at) = generated_at {
            entry.push_str(&format!("  generatedAt: {at}\n"));
        }
        entry
    }

    fn summarized(text: &str, generated_at: Option<&str>) -> String {
        note(
            &format!("title: Garden\n{}", summary(text, generated_at)),
            BODY,
        )
    }

    /// Settle both ways round, insisting the two devices keep the same entry:
    /// the settled sides, or `None` when nothing changed.
    fn settle_both_ways(ours: &str, theirs: &str) -> Option<(String, String)> {
        let settled = |one: &str, other: &str| {
            let (mut one_settled, mut other_settled) = (one.to_string(), other.to_string());
            settle(&mut one_settled, &mut other_settled);
            (one_settled != one || other_settled != other).then_some((one_settled, other_settled))
        };
        let here = settled(ours, theirs);
        let there = settled(theirs, ours).map(|(theirs, ours)| (ours, theirs));
        assert_eq!(here, there, "both devices must keep the same entry");
        here
    }

    #[test]
    fn the_earlier_generated_summary_wins_on_both_sides() {
        let early = summarized("Early.", Some(EARLY));
        let late = summarized("Late.", Some(LATE));
        assert_eq!(
            settle_both_ways(&late, &early),
            Some((early.clone(), early))
        );
    }

    #[test]
    fn a_summary_without_a_timestamp_counts_as_earlier() {
        let legacy = summarized("Legacy.", None);
        let stamped = summarized("Stamped.", Some(EARLY));
        assert_eq!(
            settle_both_ways(&stamped, &legacy),
            Some((legacy.clone(), legacy))
        );
    }

    #[test]
    fn without_timestamps_the_entry_that_sorts_first_wins() {
        let alpha = summarized("Alpha.", None);
        let beta = summarized("Beta.", None);
        assert_eq!(
            settle_both_ways(&beta, &alpha),
            Some((alpha.clone(), alpha))
        );
        // The same instant on both falls back to the lines too.
        let alpha_at = summarized("Alpha.", Some(EARLY));
        let beta_at = summarized("Beta.", Some(EARLY));
        assert_eq!(
            settle_both_ways(&beta_at, &alpha_at),
            Some((alpha_at.clone(), alpha_at))
        );
    }

    /// A stamp that isn't a `toISOString` instant loses to a valid one and to
    /// an entry without one; two such stamps fall to the lines.
    #[test]
    fn a_stamp_that_is_not_an_instant_loses() {
        let odd = summarized("Alpha.", Some("yesterday"));
        let early = summarized("Early.", Some(EARLY));
        assert_eq!(settle_both_ways(&odd, &early), Some((early.clone(), early)));
        let legacy = summarized("Legacy.", None);
        assert_eq!(
            settle_both_ways(&odd, &legacy),
            Some((legacy.clone(), legacy))
        );
        let other_odd = summarized("Beta.", Some("12"));
        assert_eq!(settle_both_ways(&other_odd, &odd), Some((odd.clone(), odd)));
    }

    /// Two stamps an older build's word-level merge ran together lose to a
    /// valid one, even a later one.
    #[test]
    fn an_interleaved_stamp_loses_to_a_valid_one() {
        let interleaved = summarized("Early. Late.", Some(&format!("{EARLY} {LATE}")));
        let late = summarized("Late.", Some(LATE));
        assert_eq!(
            settle_both_ways(&interleaved, &late),
            Some((late.clone(), late))
        );
    }

    /// Only the entry lines change: the rest of each side stays as it was,
    /// for the ladder to merge.
    #[test]
    fn only_the_entry_lines_change() {
        let appended = format!("{BODY}\nAppended on this device.\n");
        let ours = note(
            &format!("title: Garden\n{}pinned: 1\n", summary("Ours.", Some(LATE))),
            &appended,
        );
        let theirs = note(
            &format!("title: Garden v2\n{}", summary("Theirs.", Some(EARLY))),
            BODY,
        );
        let settled = note(
            &format!(
                "title: Garden\n{}pinned: 1\n",
                summary("Theirs.", Some(EARLY))
            ),
            &appended,
        );
        assert_eq!(
            settle_both_ways(&ours, &theirs),
            Some((settled, theirs.clone()))
        );
    }

    /// A replaced entry that defined an anchor the rest of its block uses
    /// would leave the alias dangling: nothing settles, and the ladder goes on
    /// with the sides as they were.
    #[test]
    fn a_settle_that_would_break_the_frontmatter_is_skipped() {
        let anchored = note(
            &format!(
                "{}title: *summary\n",
                summary("&summary Later.", Some(LATE))
            ),
            BODY,
        );
        assert!(ai_summary_entry(&anchored).is_some(), "{anchored}");
        let early = summarized("Early.", Some(EARLY));
        assert_eq!(settle_both_ways(&anchored, &early), None);
    }

    #[test]
    fn sides_without_two_summaries_of_one_body_are_left_alone() {
        let ours = summarized("Ours.", None);
        for theirs in [
            // Summaries of different bodies.
            note(
                "title: Garden\naiSummary:\n  text: Theirs.\n  hash: fedcba9876543210\n",
                BODY,
            ),
            // An entry Reflect doesn't read as its own.
            note("title: Garden\naiSummary: hand-written\n", BODY),
            // No entry at all.
            note("title: Garden\n", BODY),
            // The same entry, whatever else changed.
            note(
                &format!("title: Garden v2\n{}", summary("Ours.", None)),
                BODY,
            ),
        ] {
            assert_eq!(settle_both_ways(&ours, &theirs), None, "{theirs}");
        }
    }
}
