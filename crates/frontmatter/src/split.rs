//! Carving the leading `---` block off a note — the Rust mirror of
//! `splitFrontmatter` (`packages/core/src/markdown/frontmatter.ts`).
//!
//! The fences are ASCII, so the split runs on bytes: the classifier needs it
//! for blobs that aren't valid UTF-8, and every offset it returns is also a
//! char boundary of a `&str` source.

use std::ops::Range;

/// Result of carving a leading `---` block off the source.
pub struct FrontmatterSplit<'source> {
    /// YAML text between the fences, or `None` when there's no block.
    pub raw: Option<&'source str>,
    /// Everything after the closing fence (the markdown body).
    pub body: &'source str,
}

/// Where a frontmatter block sits in the source bytes.
pub(crate) struct Block {
    /// The YAML text between the fences.
    pub(crate) raw: Range<usize>,
    /// Where the markdown body starts.
    pub(crate) body_start: usize,
}

/// Carve a leading YAML frontmatter block off `source`. Mirrors
/// `splitFrontmatter`: the opening fence must be the very first line; an
/// unterminated block is tolerated as plain body.
pub fn split_frontmatter(source: &str) -> FrontmatterSplit<'_> {
    match split_block(source.as_bytes()) {
        Some(block) => FrontmatterSplit {
            raw: Some(&source[block.raw]),
            body: &source[block.body_start..],
        },
        None => FrontmatterSplit {
            raw: None,
            body: source,
        },
    }
}

/// Locate the frontmatter block in `source`, or `None` when the first line
/// isn't a fence or the block never closes.
pub(crate) fn split_block(source: &[u8]) -> Option<Block> {
    let open_len = fence_line_len(source)?;
    let rest = &source[open_len..];

    // Empty frontmatter: the closing fence sits immediately after the opener.
    if let Some(close_len) = fence_line_len(rest) {
        return Some(Block {
            raw: open_len..open_len,
            body_start: open_len + close_len,
        });
    }
    // Otherwise the closing fence starts right after a newline. The raw block
    // excludes that newline (and a preceding `\r`), matching the TS regex.
    let mut search_from = 0;
    while let Some(newline_at) = rest[search_from..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|at| search_from + at)
    {
        let line_start = newline_at + 1;
        if let Some(close_len) = fence_line_len(&rest[line_start..]) {
            let raw_end = if newline_at > 0 && rest[newline_at - 1] == b'\r' {
                newline_at - 1
            } else {
                newline_at
            };
            return Some(Block {
                raw: open_len..open_len + raw_end,
                body_start: open_len + line_start + close_len,
            });
        }
        search_from = line_start;
    }
    None
}

/// Length of a fence line (`---[ \t]*` then newline-or-EOF) at the start of
/// `text`, or `None` if `text` doesn't begin with one.
fn fence_line_len(text: &[u8]) -> Option<usize> {
    let rest = text.strip_prefix(b"---")?;
    let mut index = 0;
    while index < rest.len() && (rest[index] == b' ' || rest[index] == b'\t') {
        index += 1;
    }
    match rest.get(index) {
        None => Some(3 + index),
        Some(b'\n') => Some(3 + index + 1),
        Some(b'\r') if rest.get(index + 1) == Some(&b'\n') => Some(3 + index + 2),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_a_block_and_preserves_the_body() {
        let split = split_frontmatter("---\ntitle: Foo\n---\nbody text\n");
        assert_eq!(split.raw, Some("title: Foo"));
        assert_eq!(split.body, "body text\n");
    }

    #[test]
    fn no_fence_means_no_frontmatter() {
        let split = split_frontmatter("# Just a note\n---\nnot frontmatter\n");
        assert_eq!(split.raw, None);
        assert!(split.body.starts_with("# Just a note"));
    }

    /// Parity with `splitFrontmatter`: an unterminated fence is body, and an
    /// empty block (`---` directly followed by `---`) is valid.
    #[test]
    fn tolerates_unterminated_and_empty_blocks() {
        let unterminated = split_frontmatter("---\ntitle: Foo\nno closing fence");
        assert_eq!(unterminated.raw, None);
        let empty = split_frontmatter("---\n---\nbody");
        assert_eq!(empty.raw, Some(""));
        assert_eq!(empty.body, "body");
    }

    #[test]
    fn windows_line_endings_split_cleanly() {
        let split = split_frontmatter("---\r\ntitle: Foo\r\n---\r\nbody");
        assert_eq!(split.raw, Some("title: Foo"));
        assert_eq!(split.body, "body");
    }

    /// A leading byte-order mark hides the fence, exactly as it does from the
    /// TS regex: the note has no frontmatter as far as the split is concerned.
    #[test]
    fn a_byte_order_mark_hides_the_fence() {
        let split = split_frontmatter("\u{feff}---\ntitle: Foo\n---\nbody");
        assert_eq!(split.raw, None);
    }

    #[test]
    fn splits_bytes_that_are_not_utf8() {
        let source = b"---\nprivate: true\n---\n\xff\xfe body";
        let block = split_block(source).expect("a block");
        assert_eq!(&source[block.raw], b"private: true");
        assert_eq!(&source[block.body_start..], b"\xff\xfe body");
    }
}
