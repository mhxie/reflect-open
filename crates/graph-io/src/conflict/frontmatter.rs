//! Key-wise frontmatter merge: when both sides carry the same body and only
//! the `---` header diverged (pin state on one device, a flag on the other),
//! line-level merging is too blunt — merge per key instead.
//!
//! Deliberately conservative. An entry is a `key: value` line at column 0 and
//! the space-indented lines under it; a nested entry (the AI summary block)
//! is one opaque value. Each entry is written back as its side wrote it (a
//! flat line without trailing whitespace). The merge refuses, falling through
//! to the rest of the ladder:
//! - a side's header, the base's (when there is one), or the merged one, that
//!   doesn't load;
//! - a side's header that uses an alias (`*name`, a `<<` merge key too): the
//!   merged layout could bind it to another anchor;
//! - a non-blank line with a tab in its indent;
//! - an indented line before any key or after a blank line;
//! - a blank line right after a nested entry, or after a key line whose value
//!   opens a block scalar (`|`, `>`, past any anchor or tag);
//! - a column-0 line that starts with a YAML indicator (`-` alone or before a
//!   space or tab, `?`, `:`, `#`, `"`, `'`, `[`, `{`, `&`, `*`, `!`, `|`, `>`,
//!   `%`, `@`, a backtick), or whose first `:` is missing or not followed by a
//!   space or the line's end;
//! - a key twice on one side, a key both sides changed differently, or a
//!   deleted key the other side edited.

use std::collections::BTreeSet;
use std::ops::Range;

use reflect_frontmatter::{frontmatter_loads, frontmatter_uses_aliases};

/// A note split at its frontmatter fence. `header` excludes the `---` fences;
/// `body` starts after the closing fence line.
pub struct SplitNote<'a> {
    pub header: Option<&'a str>,
    pub body: &'a str,
}

/// Split `source` into frontmatter and body. No frontmatter → header `None`.
pub fn split(source: &str) -> SplitNote<'_> {
    let Some(rest) = source.strip_prefix("---\n") else {
        return SplitNote {
            header: None,
            body: source,
        };
    };
    // The closing fence is a `---` line: either mid-file or as the last line.
    if let Some(end) = rest.find("\n---\n") {
        return SplitNote {
            header: Some(&rest[..end]),
            body: &rest[end + "\n---\n".len()..],
        };
    }
    if let Some(header) = rest.strip_suffix("\n---") {
        return SplitNote {
            header: Some(header),
            body: "",
        };
    }
    SplitNote {
        header: None,
        body: source,
    }
}

/// Merge two frontmatter headers key-wise against an optional base header.
/// Returns the merged header (no fences), or `None` when the merge refuses
/// (see the module doc).
pub fn merge_headers(base: Option<&str>, first: &str, second: &str) -> Option<String> {
    let readable = |header: &str| frontmatter_loads(header) && !frontmatter_uses_aliases(header);
    if !readable(first) || !readable(second) || base.is_some_and(|base| !frontmatter_loads(base)) {
        return None;
    }
    let base_entries = match base {
        Some(header) => parse_entries(header)?,
        None => Vec::new(),
    };
    let first_entries = parse_entries(first)?;
    let second_entries = parse_entries(second)?;

    let base_value = |key: &str| {
        base_entries
            .iter()
            .find(|entry| entry.key == key)
            .map(|entry| entry.value)
    };
    let mut merged: Vec<&str> = Vec::new();
    let mut emitted: BTreeSet<&str> = BTreeSet::new();

    // First side's key order wins the layout; the second side's new keys append.
    for first_entry in &first_entries {
        let key = first_entry.key;
        let second_entry = second_entries.iter().find(|entry| entry.key == key);
        let entry = match second_entry {
            Some(second_entry) if second_entry.value == first_entry.value => first_entry,
            Some(second_entry) => match base_value(key) {
                // One side kept the base value: the other side's edit wins.
                Some(base) if base == first_entry.value => second_entry,
                Some(base) if base == second_entry.value => first_entry,
                _ => return None, // both changed the same key differently
            },
            None => match base_value(key) {
                // Present in base, deleted on the second side: deletion wins
                // only if the first side didn't also edit it.
                Some(base) if base == first_entry.value => continue,
                Some(_) => return None,
                // New key on the first side only.
                None => first_entry,
            },
        };
        merged.push(entry.text);
        emitted.insert(key);
    }
    for second_entry in &second_entries {
        if emitted.contains(second_entry.key) {
            continue;
        }
        match base_value(second_entry.key) {
            // Present in base, deleted on the first side.
            Some(base) if base == second_entry.value => continue,
            Some(_) => return None,
            None => merged.push(second_entry.text),
        }
    }

    let merged = merged.join("\n");
    frontmatter_loads(&merged).then_some(merged)
}

/// One header entry.
struct Entry<'a> {
    key: &'a str,
    /// What the merge compares: a flat value trimmed, a nested entry whole.
    value: &'a str,
    /// What the merge writes: the entry's lines, a flat one trimmed at its end.
    text: &'a str,
}

/// A header's entries in order, or `None` for a shape the merge refuses.
fn parse_entries(header: &str) -> Option<Vec<Entry<'_>>> {
    // Each entry's byte range: its key line through the last line under it.
    let mut ranges: Vec<Range<usize>> = Vec::new();
    let mut after_blank = false;
    let mut offset = 0;
    for line in header.split('\n') {
        let range = offset..offset + line.len();
        offset = range.end + 1;
        if line.trim().is_empty() {
            // It may belong to the value above (`|+` keeps it).
            if ranges
                .last()
                .is_some_and(|last| may_hold_blank_lines(&header[last.clone()]))
            {
                return None;
            }
            after_blank = true;
            continue;
        }
        if line.trim_start_matches(' ').starts_with('\t') {
            return None;
        }
        if line.starts_with(' ') {
            // Only under a key line. After a blank line it may be a block
            // scalar's, whose blank lines can't be delimited safely.
            let last = ranges.last_mut()?;
            if after_blank {
                return None;
            }
            last.end = range.end;
            continue;
        }
        after_blank = false;
        ranges.push(range);
    }

    let mut entries: Vec<Entry<'_>> = Vec::with_capacity(ranges.len());
    for range in ranges {
        let text = &header[range];
        let (key_line, nested) = match text.split_once('\n') {
            Some((key_line, _)) => (key_line, true),
            None => (text, false),
        };
        let (key, value) = split_key_line(key_line)?;
        if entries.iter().any(|entry| entry.key == key) {
            return None;
        }
        entries.push(if nested {
            Entry {
                key,
                value: text,
                text,
            }
        } else {
            Entry {
                key,
                value: value.trim(),
                text: text.trim_end(),
            }
        });
    }
    Some(entries)
}

/// Whether the entry read so far, `text`, may own the blank lines under it:
/// a nested entry, or a key line whose value opens a block scalar.
fn may_hold_blank_lines(text: &str) -> bool {
    text.contains('\n')
        || split_key_line(text).is_some_and(|(_, value)| {
            value
                .split_whitespace()
                .find(|token| !token.starts_with(['&', '!']))
                .is_some_and(|token| token.starts_with(['|', '>']))
        })
}

/// A key line's key and inline value, or `None` when it starts with a YAML
/// indicator or its first `:` isn't followed by a space or the line's end.
fn split_key_line(line: &str) -> Option<(&str, &str)> {
    let mut chars = line.chars();
    let indicator = match chars.next()? {
        '-' => chars.next().is_none_or(|next| next == ' ' || next == '\t'),
        '?' | ':' | '#' | '"' | '\'' | '[' | '{' | '&' | '*' | '!' | '|' | '>' | '%' | '@'
        | '`' => true,
        _ => false,
    };
    let (key, value) = line.split_once(':')?;
    if indicator || !(value.is_empty() || value.starts_with(' ')) {
        return None;
    }
    Some((key.trim_end(), value))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A summary block as the summary pass writes it, folded text included.
    const SUMMARY: &str = "aiSummary:\n  text: Plans a vegetable garden for the spring, \
                           from which seeds to start indoors to\n    how far apart to set the \
                           beds.\n  hash: 0123456789abcdef\n  generatedAt: \
                           2026-01-02T08:00:00.000Z";

    #[test]
    fn split_finds_header_and_body() {
        let note = "---\nid: abc\nprivate: true\n---\n# Body\n";
        let parts = split(note);
        assert_eq!(parts.header, Some("id: abc\nprivate: true"));
        assert_eq!(parts.body, "# Body\n");
        assert_eq!(split("# No header\n").header, None);
    }

    #[test]
    fn disjoint_key_edits_merge() {
        let base = "id: abc";
        let first = "id: abc\nisPinned: true"; // pinned on the Mac
        let second = "id: abc\nprivate: true"; // marked private on the phone
        assert_eq!(
            merge_headers(Some(base), first, second),
            Some("id: abc\nisPinned: true\nprivate: true".to_string())
        );
    }

    #[test]
    fn the_edited_side_beats_the_side_that_kept_the_base_value() {
        let base = "id: abc\npinnedOrder: 2";
        let first = "id: abc\npinnedOrder: 2";
        let second = "id: abc\npinnedOrder: 5";
        assert_eq!(
            merge_headers(Some(base), first, second),
            Some("id: abc\npinnedOrder: 5".to_string())
        );
    }

    #[test]
    fn same_key_changed_differently_refuses() {
        let base = "pinnedOrder: 1";
        assert_eq!(
            merge_headers(Some(base), "pinnedOrder: 2", "pinnedOrder: 3"),
            None
        );
    }

    #[test]
    fn deletion_wins_only_against_an_unedited_value() {
        let base = "id: abc\nisPinned: true";
        // Second side unpinned (deleted the key); first side left it alone.
        assert_eq!(
            merge_headers(Some(base), "id: abc\nisPinned: true", "id: abc"),
            Some("id: abc".to_string())
        );
        // But a delete against an *edit* is a real conflict.
        assert_eq!(
            merge_headers(Some(base), "id: abc\nisPinned: false", "id: abc"),
            None
        );
    }

    #[test]
    fn without_a_base_only_disjoint_and_equal_keys_merge() {
        assert_eq!(
            merge_headers(None, "id: abc\nkind: template", "id: abc\nprivate: true"),
            Some("id: abc\nkind: template\nprivate: true".to_string())
        );
        assert_eq!(merge_headers(None, "id: abc", "id: xyz"), None);
    }

    #[test]
    fn an_unchanged_nested_entry_passes_through_flat_edits() {
        let base = format!("id: abc\n{SUMMARY}\ntitle: Garden");
        let first = format!("id: abc\n{SUMMARY}\ntitle: Garden\npinned: true");
        let second = format!("id: abc\n{SUMMARY}\ntitle: Garden v2");
        assert_eq!(
            merge_headers(Some(&base), &first, &second),
            Some(format!(
                "id: abc\n{SUMMARY}\ntitle: Garden v2\npinned: true"
            ))
        );
    }

    #[test]
    fn a_nested_edit_on_one_side_wins_verbatim() {
        let base = format!("id: abc\n{SUMMARY}");
        let edited = "aiSummary: # regenerated\n  text: A shorter summary.\n    \
                      Still one paragraph.\n  hash: 0123456789abcdef";
        let first = format!("id: abc\n{edited}");
        let second = format!("id: abc\n{SUMMARY}\nprivate: true");
        assert_eq!(
            merge_headers(Some(&base), &first, &second),
            Some(format!("id: abc\n{edited}\nprivate: true"))
        );
    }

    #[test]
    fn both_sides_editing_a_nested_entry_refuses() {
        let base = format!("id: abc\n{SUMMARY}");
        let first = "id: abc\naiSummary:\n  text: Ours.\n  hash: 0123456789abcdef";
        let second = "id: abc\naiSummary:\n  text: Theirs.\n  hash: 0123456789abcdef";
        assert_eq!(merge_headers(Some(&base), first, second), None);
    }

    #[test]
    fn deleting_a_nested_entry_works_like_a_flat_key() {
        let base = format!("id: abc\n{SUMMARY}");
        assert_eq!(
            merge_headers(Some(&base), "id: abc", &base),
            Some("id: abc".to_string())
        );
        let edited = "id: abc\naiSummary:\n  text: Edited.\n  hash: 0123456789abcdef";
        assert_eq!(merge_headers(Some(&base), "id: abc", edited), None);
    }

    /// Flat values compare trimmed; each line is written as its side wrote it.
    #[test]
    fn lines_are_written_as_their_side_wrote_them() {
        assert_eq!(
            merge_headers(
                Some("id: abc\nkey: spaced\ntags:"),
                "id: abc  \nkey:   spaced\ntags:",
                "id: abc\nkey: spaced\ntags:\npinned: true",
            ),
            Some("id: abc\nkey:   spaced\ntags:\npinned: true".to_string())
        );
    }

    /// Each loads, so only the line rules keep it from being re-keyed.
    #[test]
    fn yaml_indicators_at_column_0_refuse() {
        for header in [
            "\"og:title\": x",
            "agenda:\n- 10:30 standup",
            "a:\n- i: 8\n- j: 9\nb:\n- k: 10",
            "a:\n-\ti: 8\nb:\n-\tk: 10",
        ] {
            assert!(frontmatter_loads(header), "{header}");
            assert_eq!(
                merge_headers(None, header, "pinned: true"),
                None,
                "{header}"
            );
        }
        for header in [
            "# note: x",
            "'a:b': c",
            "? k",
            "[a]: b",
            "&x k: v",
            "!!str k: v",
        ] {
            assert_eq!(
                merge_headers(None, header, "pinned: true"),
                None,
                "{header}"
            );
            assert_eq!(
                merge_headers(None, "pinned: true", header),
                None,
                "{header}"
            );
        }
    }

    #[test]
    fn a_key_line_needs_a_space_or_the_end_after_its_first_colon() {
        assert!(frontmatter_loads("og:title: x"));
        for header in ["og:title: x", "key:value"] {
            assert_eq!(
                merge_headers(None, header, "pinned: true"),
                None,
                "{header}"
            );
        }
    }

    #[test]
    fn shapes_the_merge_cannot_take_apart_refuse() {
        for header in [
            // A tab in the indent, at column 0 or after the spaces.
            "id: abc\n\ttitle: Tabbed",
            "id: abc\naiSummary:\n\ttext: Tabbed.",
            "id: abc\naiSummary:\n \ttext: Tabbed.",
            // An indented line before any key.
            "  text: Orphaned.\nid: abc",
            // An indented line after a blank line.
            "id: abc\nnotes: |\n  First paragraph.\n\n  Second paragraph.",
        ] {
            assert_eq!(merge_headers(None, header, "id: abc"), None, "{header}");
            assert_eq!(merge_headers(None, "id: abc", header), None, "{header}");
        }
    }

    #[test]
    fn a_blank_line_after_a_nested_entry_refuses() {
        let kept = "notes: |+\n  text\n\ntitle: T";
        assert_eq!(
            merge_headers(None, kept, &format!("{kept}\npinned: true")),
            None
        );
        // Between flat entries a blank line is skipped, as before.
        assert_eq!(
            merge_headers(None, "id: a\n\ntitle: T", "id: a\n\ntitle: T\npinned: true"),
            Some("id: a\ntitle: T\npinned: true".to_string())
        );
    }

    #[test]
    fn a_key_twice_on_one_side_refuses() {
        assert_eq!(
            merge_headers(None, "id: abc\nid: xyz", "id: abc\nprivate: true"),
            None
        );
        let twice = "aiSummary:\n  text: One.\naiSummary:\n  text: Two.";
        assert_eq!(merge_headers(None, twice, "id: abc"), None);
    }

    #[test]
    fn a_side_whose_header_does_not_load_refuses() {
        for (one, other) in [
            ("id: a\nx:y", "id: a\npinned: true"),
            ("base: &b\n  x: 1\nid: a\npinned: true", "id: a\n<<: *b"),
            ("id: a\nref: *missing", "id: a\npinned: true"),
        ] {
            assert_eq!(merge_headers(None, one, other), None, "{one} / {other}");
            assert_eq!(merge_headers(None, other, one), None, "{one} / {other}");
        }
    }

    /// A hand-broken quote in the base: dropping it would bring back the unpin.
    #[test]
    fn a_base_that_does_not_load_refuses() {
        let base = "title: \"oops\npinned: true";
        assert!(!frontmatter_loads(base));
        let fixed_and_unpinned = "title: \"oops\"";
        let fixed = "title: \"oops\"\npinned: true";
        assert_eq!(merge_headers(Some(base), fixed_and_unpinned, fixed), None);
        assert_eq!(merge_headers(Some(base), fixed, fixed_and_unpinned), None);
    }

    /// Appended after a reordered side, `*x` would bind to the other `&x`.
    #[test]
    fn a_side_that_uses_an_alias_refuses() {
        let base = "a: &x 1\nc: &x 2";
        let reordered = "c: &x 2\na: &x 1";
        let aliased = "a: &x 1\nc: &x 2\nr: *x";
        assert!(frontmatter_loads(aliased));
        assert_eq!(merge_headers(Some(base), reordered, aliased), None);
        for merge_key in ["b: &b\n  x: 1\n<<: *b", "b: &b\n  x: 1\nmeta:\n  <<: *b"] {
            assert_eq!(
                merge_headers(None, merge_key, "b: &b\n  x: 1"),
                None,
                "{merge_key}"
            );
            assert_eq!(
                merge_headers(None, "b: &b\n  x: 1", merge_key),
                None,
                "{merge_key}"
            );
        }
    }

    #[test]
    fn a_blank_line_after_a_block_scalar_key_refuses() {
        for notes in ["notes: |+", "notes: >", "notes: &n |+", "notes: !!str |+"] {
            let base = format!("{notes}\n\ntitle: T");
            let pinned = format!("{notes}\n\ntitle: T\npinned: true");
            let retitled = format!("{notes}\n\ntitle: T2");
            assert_eq!(
                merge_headers(Some(&base), &pinned, &retitled),
                None,
                "{notes}"
            );
        }
    }

    /// `true` and `True` are one YAML key, so the merged header would not load.
    #[test]
    fn a_merged_header_that_does_not_load_refuses() {
        assert!(frontmatter_loads("id: a\ntrue: x") && frontmatter_loads("id: a\nTrue: y"));
        assert_eq!(
            merge_headers(Some("id: a"), "id: a\ntrue: x", "id: a\nTrue: y"),
            None
        );
    }

    /// Both sides load, but the merge would part `&owner` from `*owner`.
    #[test]
    fn a_merge_that_parts_an_anchor_from_its_alias_refuses() {
        let base = "id: abc\nmeta:\n  owner: &owner alex\ntitle: Garden";
        let first = "id: abc\ntitle: Garden";
        let second = "id: abc\nmeta:\n  owner: &owner alex\ntitle: Garden\nreviewer: *owner";
        assert!(frontmatter_loads(first) && frontmatter_loads(second));
        assert_eq!(merge_headers(Some(base), first, second), None);
    }
}
