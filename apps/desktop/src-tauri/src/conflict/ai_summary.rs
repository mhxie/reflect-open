//! Two devices' summaries of the same body.
//!
//! Every device with note summaries on writes an `aiSummary` entry for a long
//! note whose body has no current one (`actions/note-summaries.ts`), so two
//! devices that meet the same body before either's summary syncs each write
//! their own. Their `text` lines then conflict, though nothing the user wrote
//! does. When both entries describe the same body (equal `hash`), both sides
//! take the summary generated first and merge again: a merge that is then
//! clean needs no review, and any other overlapping change keeps its markers.

use reflect_frontmatter::{ai_summary_entry, AiSummaryEntry};

use crate::error::AppResult;

use super::merge3::{diff3, Diff3Outcome};
use super::{ConflictSide, OTHER_DEVICE, THIS_DEVICE};

/// Merge `ours` and `theirs` over `base` with both sides holding the
/// first-generated of their two summaries of the same body. `None` when the
/// sides don't carry two different summaries of one body, or when the merge
/// still conflicts; the caller then keeps its markers.
pub(crate) fn resolve(base: Option<&str>, ours: &str, theirs: &str) -> AppResult<Option<String>> {
    let (Some(our_entry), Some(their_entry)) = (ai_summary_entry(ours), ai_summary_entry(theirs))
    else {
        return Ok(None);
    };
    let our_lines = &ours[our_entry.span.clone()];
    let their_lines = &theirs[their_entry.span.clone()];
    if our_entry.hash != their_entry.hash || our_lines == their_lines {
        return Ok(None);
    }
    let first = first_generated((&our_entry, our_lines), (&their_entry, their_lines));
    let ours = splice(ours, &our_entry, first);
    let theirs = splice(theirs, &their_entry, first);
    if ours == theirs {
        return Ok(Some(ours));
    }
    // Without a base, every line is an addition on both sides: Git's merge
    // conflicts wherever the sides differ.
    let Some(base) = base else {
        return Ok(None);
    };
    let side = |content: String, label: &str| ConflictSide {
        content,
        label: label.to_string(),
        modified_ms: 0,
    };
    Ok(
        match diff3(base, &side(ours, THIS_DEVICE), &side(theirs, OTHER_DEVICE))? {
            Diff3Outcome::Clean(content) => Some(content),
            Diff3Outcome::Conflicted(_) => None,
        },
    )
}

/// The entry lines of whichever summary was generated first: the earlier
/// `generatedAt` when both record one; an entry without one predates the
/// field, so it counts as earlier; with neither, or the same instant, the
/// lines that sort first. Only the two entries decide, never which side is
/// local, so every device picks the same one.
fn first_generated<'a>(
    (one, one_lines): (&AiSummaryEntry, &'a str),
    (other, other_lines): (&AiSummaryEntry, &'a str),
) -> &'a str {
    let by_lines = || {
        if one_lines <= other_lines {
            one_lines
        } else {
            other_lines
        }
    };
    match (generated_at(one), generated_at(other)) {
        (Some(one_at), Some(other_at)) if one_at != other_at => {
            if one_at < other_at {
                one_lines
            } else {
                other_lines
            }
        }
        (Some(_), None) => other_lines,
        (None, Some(_)) => one_lines,
        _ => by_lines(),
    }
}

/// The entry's `generatedAt` when it is an instant as `toISOString` writes
/// it (`2026-01-02T03:04:05.678Z`), which sorts as text in time order;
/// anything else counts as absent.
fn generated_at(entry: &AiSummaryEntry) -> Option<&str> {
    let value = entry.generated_at.as_deref()?;
    let instant = value.len() == 24
        && value.bytes().enumerate().all(|(index, byte)| match index {
            4 | 7 => byte == b'-',
            10 => byte == b'T',
            13 | 16 => byte == b':',
            19 => byte == b'.',
            23 => byte == b'Z',
            _ => byte.is_ascii_digit(),
        });
    instant.then_some(value)
}

/// `source` with its summary entry's lines replaced by `lines`.
fn splice(source: &str, entry: &AiSummaryEntry, lines: &str) -> String {
    let mut out = String::with_capacity(source.len() + lines.len());
    out.push_str(&source[..entry.span.start]);
    out.push_str(lines);
    out.push_str(&source[entry.span.end..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: &str = "# Garden plan\n\nLong body both devices summarized.\n";

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

    /// Resolve both ways round, insisting the two devices agree.
    fn settle(base: &str, ours: &str, theirs: &str) -> Option<String> {
        let here = resolve(Some(base), ours, theirs).unwrap();
        let there = resolve(Some(base), theirs, ours).unwrap();
        assert_eq!(here, there, "the two devices must settle on the same bytes");
        here
    }

    #[test]
    fn the_earlier_generated_summary_wins_on_both_devices() {
        let base = note("title: Garden\n", BODY);
        let early = summary("Early.", Some("2026-01-02T08:00:00.000Z"));
        let late = summary("Late.", Some("2026-01-02T09:30:00.000Z"));
        let ours = note(&format!("title: Garden\n{late}"), BODY);
        let theirs = note(&format!("title: Garden\n{early}"), BODY);
        assert_eq!(settle(&base, &ours, &theirs), Some(theirs));
    }

    #[test]
    fn a_summary_without_a_timestamp_counts_as_earlier() {
        let base = note("title: Garden\n", BODY);
        let legacy = note(
            &format!("title: Garden\n{}", summary("Legacy.", None)),
            BODY,
        );
        let stamped = note(
            &format!(
                "title: Garden\n{}",
                summary("Stamped.", Some("2026-01-02T08:00:00.000Z"))
            ),
            BODY,
        );
        assert_eq!(settle(&base, &stamped, &legacy), Some(legacy));
    }

    #[test]
    fn without_timestamps_the_entry_that_sorts_first_wins() {
        let base = note("title: Garden\n", BODY);
        let alpha = note(&format!("title: Garden\n{}", summary("Alpha.", None)), BODY);
        let beta = note(&format!("title: Garden\n{}", summary("Beta.", None)), BODY);
        assert_eq!(settle(&base, &beta, &alpha), Some(alpha.clone()));
        // A timestamp that isn't `toISOString`'s counts as none.
        let odd = note(
            &format!("title: Garden\n{}", summary("Beta.", Some("yesterday"))),
            BODY,
        );
        assert_eq!(settle(&base, &odd, &alpha), Some(alpha));
    }

    #[test]
    fn other_changes_merge_around_the_winning_summary() {
        let base = note("title: Garden\npinned: 1\n", BODY);
        let ours = note(
            &format!(
                "title: Garden\npinned: 1\n{}",
                summary("Ours.", Some("2026-01-02T09:00:00.000Z"))
            ),
            &format!("{BODY}\nAppended on this device.\n"),
        );
        let theirs = note(
            &format!(
                "title: Garden v2\npinned: 1\n{}",
                summary("Theirs.", Some("2026-01-02T08:30:00.000Z"))
            ),
            BODY,
        );
        let merged = settle(&base, &ours, &theirs).unwrap();
        assert_eq!(
            merged,
            note(
                &format!(
                    "title: Garden v2\npinned: 1\n{}",
                    summary("Theirs.", Some("2026-01-02T08:30:00.000Z"))
                ),
                &format!("{BODY}\nAppended on this device.\n"),
            )
        );
    }

    #[test]
    fn any_other_conflict_keeps_the_markers() {
        let base = note("title: Garden\n", BODY);
        let ours = note(
            &format!("title: Garden\n{}", summary("Ours.", None)),
            "# Garden plan\n\nRewritten here.\n",
        );
        let theirs = note(
            &format!("title: Garden\n{}", summary("Theirs.", None)),
            "# Garden plan\n\nRewritten there.\n",
        );
        assert_eq!(settle(&base, &ours, &theirs), None);
    }

    #[test]
    fn summaries_of_different_bodies_keep_the_markers() {
        let base = note("title: Garden\n", BODY);
        let ours = note(&format!("title: Garden\n{}", summary("Ours.", None)), BODY);
        let theirs = note(
            "title: Garden\naiSummary:\n  text: Theirs.\n  hash: fedcba9876543210\n",
            BODY,
        );
        assert_eq!(settle(&base, &ours, &theirs), None);
    }

    #[test]
    fn a_side_without_a_readable_summary_keeps_the_markers() {
        let base = note("title: Garden\n", BODY);
        let ours = note(&format!("title: Garden\n{}", summary("Ours.", None)), BODY);
        let theirs = note("title: Garden\naiSummary: hand-written\n", BODY);
        assert_eq!(settle(&base, &ours, &theirs), None);
    }

    #[test]
    fn without_a_base_only_notes_equal_but_for_the_summary_settle() {
        let ours = note(&format!("title: Garden\n{}", summary("Ours.", None)), BODY);
        let theirs = note(
            &format!("title: Garden\n{}", summary("Theirs.", None)),
            BODY,
        );
        assert_eq!(resolve(None, &ours, &theirs).unwrap(), Some(ours.clone()));
        let retitled = note(&format!("title: Other\n{}", summary("Theirs.", None)), BODY);
        assert_eq!(resolve(None, &ours, &retitled).unwrap(), None);
    }
}
