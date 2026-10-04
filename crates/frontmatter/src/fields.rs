//! Tolerant, read-only frontmatter fields — the Rust mirror of
//! `parseFrontmatter` (`packages/core/src/markdown/frontmatter.ts`) and the
//! field coercions in `model.ts`, restricted to `id`, `title`, and `aliases`.
//! A block the pre-scan refuses degrades to "no frontmatter", exactly where
//! TS degrades it; privacy is [`crate::backup_privacy`]'s alone.

use saphyr::{LoadableYamlNode, Yaml};

use crate::scan::{load, Load};
use crate::split::split_block;

/// The frontmatter fields the native readers need.
#[derive(Debug, Default, PartialEq)]
pub struct Frontmatter {
    /// The durable note identity (Plan 17's ULID); string-only, like `title`.
    pub id: Option<String>,
    pub title: Option<String>,
    pub aliases: Vec<String>,
}

/// `aliases` must be a sequence of strings; any other shape (or any non-string
/// element) degrades to no aliases, matching the zod `.catch([])`.
fn coerce_aliases(node: &Yaml) -> Vec<String> {
    let Some(sequence) = node.as_sequence() else {
        return Vec::new();
    };
    let mut aliases = Vec::with_capacity(sequence.len());
    for item in sequence {
        match item.as_str() {
            Some(alias) => aliases.push(alias.to_string()),
            None => return Vec::new(),
        }
    }
    aliases
}

/// Parse the YAML from [`crate::split_frontmatter`]. Never fails: a block
/// that doesn't load yields defaults, like the TS `parseFrontmatter`. The
/// pre-scan runs first, so saphyr never expands an alias bomb.
pub fn parse_frontmatter(raw: Option<&str>) -> Frontmatter {
    let Some(raw) = raw else {
        return Frontmatter::default();
    };
    if raw.trim().is_empty() || !matches!(load(raw), Load::Loaded(_)) {
        return Frontmatter::default();
    }
    let Ok(documents) = Yaml::load_from_str(raw) else {
        return Frontmatter::default();
    };
    let Some(document) = documents.first() else {
        return Frontmatter::default();
    };
    Frontmatter {
        // `id` and `title` must be strings (the TS `stringField`); other
        // types are ignored.
        id: document
            .as_mapping_get("id")
            .and_then(|node| node.as_str())
            .map(str::to_string),
        title: document
            .as_mapping_get("title")
            .and_then(|node| node.as_str())
            .map(str::to_string),
        aliases: document
            .as_mapping_get("aliases")
            .map(coerce_aliases)
            .unwrap_or_default(),
    }
}

/// A note's frontmatter `id`, read from its raw bytes. A note whose block
/// isn't UTF-8, doesn't load, or sits behind a byte-order mark has none, as
/// in the app.
pub fn frontmatter_id(bytes: &[u8]) -> Option<String> {
    let block = split_block(bytes)?;
    let raw = std::str::from_utf8(&bytes[block.raw]).ok()?;
    parse_frontmatter(Some(raw)).id
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::split::split_frontmatter;

    fn parse(source: &str) -> Frontmatter {
        parse_frontmatter(split_frontmatter(source).raw)
    }

    #[test]
    fn id_is_string_only_like_title() {
        let parsed = parse("---\nid: 01hzy3v9k2m4n6p8q0r2s4t6vw\n---\n");
        assert_eq!(parsed.id.as_deref(), Some("01hzy3v9k2m4n6p8q0r2s4t6vw"));

        // The TS `stringField` ignores non-strings; a numeric id is no id.
        assert_eq!(parse("---\nid: 42\n---\n").id, None);
        assert_eq!(parse("---\ntitle: no id here\n---\n").id, None);
    }

    /// Parity with the zod schema: bad aliases degrade to none; bad YAML
    /// degrades to defaults instead of failing the note.
    #[test]
    fn tolerant_parsing_degrades_gracefully() {
        assert_eq!(parse("---\naliases: [a, b]\n---\n").aliases, vec!["a", "b"]);
        assert!(parse("---\naliases: nope\n---\n").aliases.is_empty());
        assert!(parse("---\naliases: [ok, [nested]]\n---\n")
            .aliases
            .is_empty());
        assert_eq!(parse("---\n[broken yaml\n---\n"), Frontmatter::default());
        assert_eq!(
            parse("---\n- a list\n- not a map\n---\n"),
            Frontmatter::default()
        );
        assert_eq!(parse("---\ntitle: 123\n---\n").title, None);
    }

    /// Where TS refuses a block (a second document, a repeated key, a merge
    /// key), Rust reads no fields either, so derived titles stay in parity.
    #[test]
    fn blocks_the_pre_scan_refuses_yield_defaults() {
        assert_eq!(
            parse("---\ntitle: First\n--- second\n---\n"),
            Frontmatter::default()
        );
        assert_eq!(
            parse("---\ntitle: A\ntitle: B\n---\n"),
            Frontmatter::default()
        );
        assert_eq!(
            parse("---\n<<: {x: 1}\ntitle: Merged\n---\n"),
            Frontmatter::default()
        );
    }

    #[test]
    fn frontmatter_id_reads_raw_bytes() {
        assert_eq!(
            frontmatter_id(b"---\nid: abc\n---\n\xff body").as_deref(),
            Some("abc")
        );
        assert_eq!(frontmatter_id(b"\xEF\xBB\xBF---\nid: abc\n---\n"), None);
        assert_eq!(frontmatter_id(b"---\nid: [abc\n---\n"), None);
        assert_eq!(frontmatter_id(b"no frontmatter"), None);
    }
}
