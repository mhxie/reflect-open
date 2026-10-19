//! The resolution ladder: one conflicted note pair in, one
//! deterministic [`Resolution`] out. It always returns text and never writes
//! conflict markers. First matching rule wins:
//!
//! 1. **Identical** → nothing to write.
//! 2. **Whitespace-equal** → keep the newer side.
//! 3. **Merge-loop breaker** → keep the newer side, as
//!    [`Resolution::Reconciled`]. It depends only on the ordered pair, so two
//!    devices emit identical bytes and stop swapping contents.
//! 4. **Three-way merge** over the shadow base, when one exists and the
//!    hunks do not overlap.
//! 5. **Key-wise frontmatter** when only the header diverged.
//! 6. **Append-union** for any note whose sides only appended to the base.
//! 7. **Word-level merge** ([`total::merge`]) as [`Resolution::Reconciled`]:
//!    both sides' words are kept.
//!
//! Between rules 3 and 4, two AI summaries of one body settle
//! ([`ai_summary`]): when both sides hold an `aiSummary` entry with the same
//! `hash` and the entries differ, both take the one generated first. Sides
//! that then agree are [`Resolution::Merged`] as that content; otherwise
//! rules 4–7 run on the settled pair.
//!
//! The sides are ordered once, by `(modified_ms, content)` as they arrive,
//! and keep that order through the settling, so every rule sees the same
//! pair on every device and concurrent resolution converges.

use reflect_types::AppResult;

use super::ai_summary;
use super::frontmatter;
use super::merge3::diff3;
use super::total;
use super::union::append_union;
use super::{ConflictSide, Resolution};

/// Everything the ladder needs to know about one conflicted note.
pub struct ConflictInput<'a> {
    /// The shadow base (last synced content), when the store has one.
    pub base: Option<&'a str>,
    /// The two conflicting versions, in any order.
    pub sides: (ConflictSide, ConflictSide),
    /// True when this exact content pair was already auto-merged once. It
    /// selects the deterministic loop breaker (rule 3).
    pub merge_loop_detected: bool,
}

/// Run the ladder. The same pair, in either order, gives the same bytes.
pub fn resolve(input: ConflictInput<'_>) -> AppResult<Resolution> {
    let (mut first, mut second) = ordered(input.sides.0, input.sides.1);

    if first.content == second.content {
        return Ok(Resolution::AlreadyResolved);
    }
    if normalized(&first.content) == normalized(&second.content) {
        return Ok(Resolution::Merged {
            content: second.content,
        });
    }
    if input.merge_loop_detected {
        return Ok(Resolution::Reconciled {
            content: second.content,
        });
    }

    // Sides that differed only in their summary of one body now agree.
    ai_summary::settle(&mut first.content, &mut second.content);
    if first.content == second.content {
        return Ok(Resolution::Merged {
            content: second.content,
        });
    }

    if let Some(base) = input.base
        && let Some(content) = diff3(base, &first, &second)?
    {
        return Ok(Resolution::Merged { content });
    }

    if let Some(content) = merge_frontmatter_only(input.base, &first, &second) {
        return Ok(Resolution::Merged { content });
    }

    if let Some(content) = append_union(input.base, &first.content, &second.content) {
        return Ok(Resolution::Merged { content });
    }

    Ok(Resolution::Reconciled {
        content: total::merge(input.base.unwrap_or(""), &first.content, &second.content),
    })
}

/// Ascending `(modified_ms, content)`. The stamps come from shared version
/// metadata, so every device picks the same order.
fn ordered(a: ConflictSide, b: ConflictSide) -> (ConflictSide, ConflictSide) {
    if (a.modified_ms, &a.content) <= (b.modified_ms, &b.content) {
        (a, b)
    } else {
        (b, a)
    }
}

/// Whitespace-insensitive equality shape: trailing whitespace per line and
/// trailing blank lines don't count as divergence.
fn normalized(content: &str) -> String {
    let mut lines: Vec<&str> = content.split('\n').map(str::trim_end).collect();
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

/// Rule 5: identical bodies, divergent flat frontmatter → key-wise merge.
fn merge_frontmatter_only(
    base: Option<&str>,
    first: &ConflictSide,
    second: &ConflictSide,
) -> Option<String> {
    let first_split = frontmatter::split(&first.content);
    let second_split = frontmatter::split(&second.content);
    if first_split.body != second_split.body {
        return None;
    }
    let base_header = base.map(|content| frontmatter::split(content).header);
    let merged = frontmatter::merge_headers(
        base_header.flatten(),
        first_split.header.unwrap_or(""),
        second_split.header.unwrap_or(""),
    )?;
    if merged.is_empty() {
        return Some(first_split.body.to_string());
    }
    Some(format!("---\n{merged}\n---\n{}", first_split.body))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn side(content: &str, modified_ms: u64) -> ConflictSide {
        ConflictSide {
            content: content.to_string(),
            modified_ms,
        }
    }

    fn input<'a>(base: Option<&'a str>, sides: (ConflictSide, ConflictSide)) -> ConflictInput<'a> {
        ConflictInput {
            base,
            sides,
            merge_loop_detected: false,
        }
    }

    #[test]
    fn identical_content_is_already_resolved() {
        let result = resolve(input(None, (side("same\n", 1), side("same\n", 2)))).unwrap();
        assert_eq!(result, Resolution::AlreadyResolved);
    }

    #[test]
    fn whitespace_noise_keeps_the_newer_side() {
        let result = resolve(input(None, (side("text  \n\n", 1), side("text\n", 2)))).unwrap();
        assert_eq!(
            result,
            Resolution::Merged {
                content: "text\n".to_string()
            }
        );
    }

    #[test]
    fn disjoint_edits_over_a_base_merge_clean() {
        let base = "# T\n\nalpha\n\nomega\n";
        let result = resolve(input(
            Some(base),
            (
                side("# T\n\nALPHA\n\nomega\n", 1),
                side("# T\n\nalpha\n\nOMEGA\n", 2),
            ),
        ))
        .unwrap();
        assert_eq!(
            result,
            Resolution::Merged {
                content: "# T\n\nALPHA\n\nOMEGA\n".to_string()
            }
        );
    }

    #[test]
    fn overlapping_edits_reconcile_without_markers() {
        let base = "line\n";
        let result = resolve(input(Some(base), (side("mac\n", 1), side("phone\n", 2)))).unwrap();
        let Resolution::Reconciled { content } = result else {
            panic!("expected Reconciled, got {result:?}");
        };
        assert!(!content.contains("<<<<<<<"));
        assert!(content.contains("mac"), "{content}");
        assert!(content.contains("phone"), "{content}");
    }

    #[test]
    fn daily_notes_union_after_a_failed_three_way_merge() {
        let base = "# 2026-07-04\n\n- seed\n";
        let result = resolve(input(
            Some(base),
            (
                side("# 2026-07-04\n\n- seed\n- mac\n", 1),
                side("# 2026-07-04\n\n- seed\n- phone\n", 2),
            ),
        ))
        .unwrap();
        assert_eq!(
            result,
            Resolution::Merged {
                content: "# 2026-07-04\n\n- seed\n- mac\n- phone\n".to_string()
            }
        );
    }

    #[test]
    fn union_orders_tails_by_timestamp_not_argument_order() {
        let older = side("- seed\n- older tail\n", 1);
        let newer = side("- seed\n- newer tail\n", 2);
        let one = resolve(input(None, (older.clone(), newer.clone()))).unwrap();
        let two = resolve(input(None, (newer, older))).unwrap();
        assert_eq!(one, two);
        assert_eq!(
            one,
            Resolution::Merged {
                content: "- seed\n- older tail\n- newer tail\n".to_string()
            }
        );
    }

    #[test]
    fn appends_without_a_common_prefix_union() {
        let result = resolve(input(None, (side("- mac\n", 1), side("- phone\n", 2)))).unwrap();
        assert_eq!(
            result,
            Resolution::Merged {
                content: "- mac\n- phone\n".to_string()
            }
        );
    }

    #[test]
    fn rule_6_falls_through_when_a_side_deleted_base_lines() {
        let base = "- a\n- b\n";
        let result = resolve(input(
            Some(base),
            (side("- a\n- b\n- mac\n", 1), side("- a\n- phone\n", 2)),
        ))
        .unwrap();
        let Resolution::Reconciled { content } = result else {
            panic!("expected Reconciled, got {result:?}");
        };
        assert!(
            content.contains("mac") && content.contains("phone"),
            "{content}"
        );
    }

    #[test]
    fn frontmatter_only_divergence_merges_key_wise() {
        let base = "---\nid: abc\n---\n# Body\n";
        let result = resolve(input(
            Some(base),
            (
                side("---\nid: abc\nisPinned: true\n---\n# Body\n", 1),
                side("---\nid: abc\nprivate: true\n---\n# Body\n", 2),
            ),
        ))
        .unwrap();
        assert_eq!(
            result,
            Resolution::Merged {
                content: "---\nid: abc\nisPinned: true\nprivate: true\n---\n# Body\n".to_string()
            }
        );
    }

    #[test]
    fn the_loop_breaker_keeps_the_newer_side() {
        let mut conflict = input(Some("base\n"), (side("merge A\n", 1), side("merge B\n", 2)));
        conflict.merge_loop_detected = true;
        assert_eq!(
            resolve(conflict).unwrap(),
            Resolution::Reconciled {
                content: "merge B\n".to_string()
            }
        );
    }

    const SUMMARIZED_BODY: &str = "# Garden plan\n\nLong body both devices summarized.\n";
    const EARLY: &str = "2026-01-02T08:00:00.000Z";
    const LATE: &str = "2026-01-02T09:30:00.000Z";

    /// A note whose AI summary has [`SUMMARIZED_BODY`]'s hash, laid out as the
    /// summary pass writes it.
    fn summarized(header: &str, text: &str, generated_at: &str, body: &str) -> String {
        format!(
            "---\n{header}aiSummary:\n  text: {text}\n  hash: 0123456789abcdef\n  \
             generatedAt: {generated_at}\n---\n\n{body}"
        )
    }

    /// Two devices summarized the same body: the first generated wins on
    /// both, whichever side is newer, with a base or without.
    #[test]
    fn two_summaries_of_one_body_merge_to_the_first_generated() {
        let base = format!("---\ntitle: Garden\n---\n\n{SUMMARIZED_BODY}");
        let first = summarized("title: Garden\n", "First.", EARLY, SUMMARIZED_BODY);
        let later = summarized("title: Garden\n", "Later.", LATE, SUMMARIZED_BODY);
        let merged = Resolution::Merged {
            content: first.clone(),
        };
        for base in [Some(base.as_str()), None] {
            for sides in [
                (side(&first, 1), side(&later, 2)),
                (side(&later, 1), side(&first, 2)),
            ] {
                assert_eq!(resolve(input(base, sides)).unwrap(), merged);
            }
        }
    }

    /// The rest of the note merges around the settled summary as before.
    #[test]
    fn other_changes_merge_around_the_first_generated_summary() {
        let base = format!("---\ntitle: Garden\npinned: 1\n---\n\n{SUMMARIZED_BODY}");
        let appended = format!("{SUMMARIZED_BODY}\nAppended on this device.\n");
        let ours = summarized("title: Garden\npinned: 1\n", "Ours.", LATE, &appended);
        let theirs = summarized(
            "title: Garden v2\npinned: 1\n",
            "Theirs.",
            EARLY,
            SUMMARIZED_BODY,
        );
        assert_eq!(
            resolve(input(Some(&base), (side(&ours, 2), side(&theirs, 1)))).unwrap(),
            Resolution::Merged {
                content: summarized("title: Garden v2\npinned: 1\n", "Theirs.", EARLY, &appended)
            }
        );
    }

    /// A body both sides rewrote still reaches the word-level merge, but the
    /// summary comes out whole, never two summaries' words interleaved.
    #[test]
    fn the_word_level_merge_keeps_the_first_generated_summary_whole() {
        let base = format!("---\ntitle: Garden\n---\n\n{SUMMARIZED_BODY}");
        let ours = summarized(
            "title: Garden\n",
            "Later, here.",
            LATE,
            "# Garden plan\n\nRewritten here.\n",
        );
        let theirs = summarized(
            "title: Garden\n",
            "First, there.",
            EARLY,
            "# Garden plan\n\nRewritten there.\n",
        );
        let result = resolve(input(Some(&base), (side(&ours, 2), side(&theirs, 1)))).unwrap();
        let Resolution::Reconciled { content } = result else {
            panic!("expected Reconciled, got {result:?}");
        };
        let header = summarized("title: Garden\n", "First, there.", EARLY, "");
        assert!(content.starts_with(&header), "{content}");
        let entry = reflect_frontmatter::ai_summary_entry(&content).expect("a readable summary");
        assert_eq!(
            entry.generated_at,
            Some(reflect_frontmatter::GeneratedAt::Instant(EARLY.to_string()))
        );
        assert!(!content.contains("Later"), "{content}");
        let body = &content[header.len()..];
        assert!(body.contains("here") && body.contains("there"), "{content}");
    }

    #[test]
    fn resolution_is_argument_order_independent() {
        let a = side("# T\n\nmac edit\n", 5);
        let b = side("# T\n\nphone edit\n", 5); // equal stamps → content tiebreak
        let one = resolve(input(None, (a.clone(), b.clone()))).unwrap();
        let two = resolve(input(None, (b, a))).unwrap();
        assert_eq!(one, two);
    }
}
