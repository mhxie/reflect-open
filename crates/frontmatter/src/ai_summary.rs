//! The `aiSummary` entry — the Rust mirror of `aiSummaryFrontmatterSchema`
//! (`packages/core/src/markdown/model.ts`) for the conflict ladder, which
//! needs the summary's fields and where its entry sits in the note.

use std::ops::Range;

use saphyr::{LoadableYamlNode, Yaml};

use crate::scan::frontmatter_loads;
use crate::split::split_block;

/// The frontmatter key the summary lives under (`AI_SUMMARY_KEY`).
const KEY: &str = "aiSummary";

/// A note's `aiSummary` entry: the fields the conflict ladder compares and
/// the lines that hold them.
#[derive(Debug, PartialEq)]
pub struct AiSummaryEntry {
    /// `noteBodyHash` of the body the summary describes.
    pub hash: String,
    /// When the summary was generated; `None` when the entry has no
    /// `generatedAt` key (it predates the field).
    pub generated_at: Option<GeneratedAt>,
    /// Byte range of the entry in the source: the `aiSummary:` line through
    /// its last indented line, without that line's terminator.
    pub span: Range<usize>,
}

/// An entry's `generatedAt` value.
#[derive(Debug, PartialEq)]
pub enum GeneratedAt {
    /// An instant as `Date.prototype.toISOString` writes it
    /// (`2026-01-02T03:04:05.678Z`), which sorts as text in time order.
    Instant(String),
    /// Anything else: not a string, or not that shape (a hand edit, two
    /// stamps run together).
    Invalid,
}

/// The note's `aiSummary` entry, or `None` when it has none that can be
/// replaced by lines: no frontmatter, a block that doesn't load, a value that
/// isn't a mapping with a string `text` and a string or integer `hash`, or an
/// entry that isn't a bare `aiSummary:` line followed by indented lines that
/// read back as the same summary on their own.
pub fn ai_summary_entry(source: &str) -> Option<AiSummaryEntry> {
    let block = split_block(source.as_bytes())?;
    let raw = &source[block.raw.clone()];
    let fields = summary_fields(raw)?;
    let lines = entry_lines(raw)?;
    // The lines alone must hold the whole summary: a scalar that runs on
    // past them (a blank line inside it, say) would leave part behind.
    if summary_fields(&raw[lines.clone()])? != fields {
        return None;
    }
    Some(AiSummaryEntry {
        hash: fields.hash,
        generated_at: fields.generated_at,
        span: block.raw.start + lines.start..block.raw.start + lines.end,
    })
}

/// What an entry holds, read like the zod schema. Nothing reads `text`, but
/// it must be a string, and it takes part in the lines' read-back check.
#[derive(Debug, PartialEq)]
struct Fields {
    text: String,
    hash: String,
    generated_at: Option<GeneratedAt>,
}

/// The summary's fields: `hash` may have loaded as an integer.
fn summary_fields(raw: &str) -> Option<Fields> {
    if !frontmatter_loads(raw) {
        return None;
    }
    let documents = Yaml::load_from_str(raw).ok()?;
    let summary = documents.first()?.as_mapping_get(KEY)?;
    let text = summary.as_mapping_get("text")?.as_str()?.to_string();
    let hash = summary.as_mapping_get("hash")?;
    let hash = match hash.as_str() {
        Some(hash) => hash.to_string(),
        None => hash.as_integer()?.to_string(),
    };
    let generated_at = summary
        .as_mapping_get("generatedAt")
        .map(|node| match node.as_str() {
            Some(value) if is_instant(value) => GeneratedAt::Instant(value.to_string()),
            _ => GeneratedAt::Invalid,
        });
    Some(Fields {
        text,
        hash,
        generated_at,
    })
}

/// Whether `value` has `toISOString`'s shape: `2026-01-02T03:04:05.678Z`.
fn is_instant(value: &str) -> bool {
    value.len() == 24
        && value.bytes().enumerate().all(|(index, byte)| match index {
            4 | 7 => byte == b'-',
            10 => byte == b'T',
            13 | 16 => byte == b':',
            19 => byte == b'.',
            23 => byte == b'Z',
            _ => byte.is_ascii_digit(),
        })
}

/// The entry's lines in `raw`: a top-level `aiSummary:` line with nothing
/// after the colon, then every following line indented by a space.
fn entry_lines(raw: &str) -> Option<Range<usize>> {
    let mut offset = 0;
    let mut lines: Option<Range<usize>> = None;
    for line in raw.split_inclusive('\n') {
        let content = line.trim_end_matches('\n').trim_end_matches('\r');
        if let Some(lines) = lines.as_mut() {
            if !content.starts_with(' ') {
                break;
            }
            lines.end = offset + content.len();
        } else if is_key_line(content) {
            lines = Some(offset..offset + content.len());
        }
        offset += line.len();
    }
    // A key line alone holds a null, not the mapping the fields came from.
    lines.filter(|lines| raw[lines.clone()].contains('\n'))
}

/// `aiSummary:` at the start of the line, with nothing after the colon.
fn is_key_line(content: &str) -> bool {
    content
        .strip_prefix(KEY)
        .and_then(|rest| rest.strip_prefix(':'))
        .is_some_and(|rest| rest.trim_matches([' ', '\t']).is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The block as the summary pass writes it: `text` folded at 80 columns,
    /// an all-digit `hash` quoted, `generatedAt` plain.
    const NOTE: &str = "---\ntitle: Example\naiSummary:\n  text: Plans a vegetable garden \
                        for the spring, from which seeds to start indoors to\n    how far apart \
                        to set the beds.\n  hash: \"0123456789012345\"\n  \
                        generatedAt: 2026-01-02T03:04:05.678Z\npinned: 3\n---\n\n# Example\n";

    #[test]
    fn reads_a_folded_entry_and_its_lines() {
        let entry = ai_summary_entry(NOTE).unwrap();
        assert_eq!(entry.hash, "0123456789012345");
        assert_eq!(
            entry.generated_at,
            Some(GeneratedAt::Instant("2026-01-02T03:04:05.678Z".to_string()))
        );
        let lines = &NOTE[entry.span];
        assert!(lines.starts_with("aiSummary:\n  text: Plans"), "{lines}");
        assert!(
            lines.ends_with("generatedAt: 2026-01-02T03:04:05.678Z"),
            "{lines}"
        );
        assert_eq!(
            summary_fields(lines).unwrap().text,
            "Plans a vegetable garden for the spring, from which seeds to start indoors to how \
             far apart to set the beds."
        );
    }

    #[test]
    fn the_entry_may_close_the_block() {
        let note = "---\naiSummary:\n  text: 短摘要。\n  hash: 89abcdef01234567\n---\n\nBody\n";
        let entry = ai_summary_entry(note).unwrap();
        assert_eq!(entry.generated_at, None);
        assert_eq!(
            &note[entry.span],
            "aiSummary:\n  text: 短摘要。\n  hash: 89abcdef01234567"
        );
    }

    #[test]
    fn an_integer_hash_reads_as_its_digits() {
        let note = "---\naiSummary:\n  text: Short.\n  hash: 1234567890123456\n---\n";
        assert_eq!(ai_summary_entry(note).unwrap().hash, "1234567890123456");
    }

    /// A `generatedAt` key whose value isn't a `toISOString` instant is
    /// invalid, not absent; a quoted instant is still one.
    #[test]
    fn a_generated_at_that_is_not_an_instant_is_invalid() {
        for (value, expected) in [
            ("12", GeneratedAt::Invalid),
            ("yesterday", GeneratedAt::Invalid),
            ("null", GeneratedAt::Invalid),
            (
                "2026-01-02T08:00:00.000Z 2026-01-02T09:30:00.000Z",
                GeneratedAt::Invalid,
            ),
            (
                "\"2026-01-02T08:00:00.000Z\"",
                GeneratedAt::Instant("2026-01-02T08:00:00.000Z".to_string()),
            ),
        ] {
            let note = format!(
                "---\naiSummary:\n  text: Short.\n  hash: abc\n  generatedAt: {value}\n---\n"
            );
            let entry = ai_summary_entry(&note).unwrap();
            assert_eq!(entry.generated_at, Some(expected), "{note}");
        }
    }

    #[test]
    fn crlf_lines_keep_their_terminators_outside_the_span() {
        let note = "---\r\naiSummary:\r\n  text: Short.\r\n  hash: abc\r\ntitle: T\r\n---\r\n";
        let entry = ai_summary_entry(note).unwrap();
        assert_eq!(
            &note[entry.span],
            "aiSummary:\r\n  text: Short.\r\n  hash: abc"
        );
    }

    #[test]
    fn entries_that_are_not_a_summary_block_are_none() {
        for note in [
            "# No frontmatter\n",
            "---\ntitle: No summary\n---\n",
            // Markers inside the block: the YAML doesn't load.
            "---\naiSummary:\n<<<<<<< this device\n  text: A\n=======\n  text: B\n>>>>>>> \
             other device\n  hash: abc\n---\n",
            // Not the schema's shape.
            "---\naiSummary: just a string\n---\n",
            "---\naiSummary:\n  text: [not, a, string]\n  hash: abc\n---\n",
            "---\naiSummary:\n  text: No hash.\n---\n",
            // The right shape, but not written as lines under the key.
            "---\naiSummary: {text: Flow., hash: abc}\n---\n",
            "---\n\"aiSummary\":\n  text: Quoted key.\n  hash: abc\n---\n",
        ] {
            assert_eq!(ai_summary_entry(note), None, "{note}");
        }
    }

    #[test]
    fn a_scalar_running_past_the_indented_lines_is_none() {
        // A blank line inside the folded text ends the indented run early;
        // the lines alone would hold only half the summary.
        let raw = "aiSummary:\n  hash: abc\n  text: First paragraph\n\n    second paragraph.";
        assert_eq!(
            summary_fields(raw).unwrap().text,
            "First paragraph\nsecond paragraph."
        );
        assert!(ai_summary_entry(&format!("---\n{raw}\n---\n")).is_none());
    }
}
