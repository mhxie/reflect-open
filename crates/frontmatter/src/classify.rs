//! The fail-closed privacy classifier: one decision for every Rust gate (the
//! CLI, commit-subject redaction, Git withholding), specified once and pinned
//! against the TS classifier by `fixtures/frontmatter-privacy.json`.
//!
//! Any `private` value the TS app could read as true classifies as `Private`
//! or `Unreadable`, and the TS side treats `Unreadable` as private too, so
//! every gate agrees on what may leave the device.

use std::fmt;

use crate::scalar::{classify_scalar, ValueClass};
use crate::scan::{line_scan_private, load, Load, NodeKind, Tree};
use crate::split::split_block;

/// How a note's frontmatter classifies for privacy. Only `Public` may reach
/// an external service or be published.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackupPrivacy {
    Public,
    /// The note is locked (`private: true` or an equivalent value).
    Private,
    /// The frontmatter can't be read with certainty; treated as locked.
    Unreadable(UnreadableReason),
}

impl BackupPrivacy {
    /// Whether the note may leave the device.
    pub fn is_public(self) -> bool {
        self == Self::Public
    }
}

/// Why a note's frontmatter is [`BackupPrivacy::Unreadable`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnreadableReason {
    /// The YAML doesn't parse (including duplicate keys and unknown aliases).
    ParseFailed,
    /// The block isn't a plain key/value mapping.
    NotAMapping,
    /// The block holds more than one YAML document.
    MultipleDocuments,
    /// Alias expansion exceeds the loading budget.
    AliasBudget,
    /// The block is larger than 256 KiB.
    TooLarge,
    /// `private` is set to something that is neither true nor false.
    UnrecognizedValue,
    /// A key spelled like `private` but not exactly (`Private`, `PRIVATE`,
    /// `"private "`) is set to something other than false: the app reads
    /// only `private`, so it can't tell whether the note was meant to be
    /// locked.
    PrivateKeyVariant,
    /// A byte-order mark precedes the fence, so the app sees no frontmatter
    /// while the block behind it locks the note.
    BomBeforeFence,
}

impl UnreadableReason {
    /// The reason's name in the shared fixture corpus and the TS classifier.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ParseFailed => "parseFailed",
            Self::NotAMapping => "notAMapping",
            Self::MultipleDocuments => "multipleDocuments",
            Self::AliasBudget => "aliasBudget",
            Self::TooLarge => "tooLarge",
            Self::UnrecognizedValue => "unrecognizedValue",
            Self::PrivateKeyVariant => "privateKeyVariant",
            Self::BomBeforeFence => "bomBeforeFence",
        }
    }
}

impl fmt::Display for UnreadableReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::ParseFailed => "its YAML doesn't parse",
            Self::NotAMapping => "it isn't a list of keys and values",
            Self::MultipleDocuments => "it holds more than one YAML document",
            Self::AliasBudget => "its aliases expand too far",
            Self::TooLarge => "it is larger than 256 KiB",
            Self::UnrecognizedValue => "its private value is neither true nor false",
            Self::PrivateKeyVariant => "a key spelled like private (such as Private) is set",
            Self::BomBeforeFence => "a byte-order mark precedes it",
        })
    }
}

/// Classify a note's raw bytes:
///
/// - **Fence:** `splitFrontmatter`'s rules; no block (or one that never
///   closes) is `Public`.
/// - **Byte-order mark:** the block behind a leading BOM is classified as
///   usual, but `Private` becomes `Unreadable(BomBeforeFence)`.
/// - **Line scan:** a column-0 `private:` line with a truthy value is
///   `Private`, whether or not the block loads.
/// - **Loaded block:** the root `private` value (tags unwrapped, aliases
///   resolved): true/1/1.0/yes/on is `Private`; false/0/null/no/off/empty or
///   no key is `Public`; anything else is `Unreadable(UnrecognizedValue)`. A
///   root key that is `private` only once ASCII-trimmed and case-folded
///   (`Private`, `PRIVATE`) is `Unreadable(PrivateKeyVariant)` unless its
///   value is falsy.
/// - **Block not loaded** (see the pre-scan; this includes a block holding a
///   NUL, a byte-order mark, a CR outside a CRLF, or another character outside
///   YAML's printable set): `Unreadable` when it contains `private` in any
///   ASCII case or a backslash (a YAML escape can spell the key), else
///   `Public`.
pub fn backup_privacy(bytes: &[u8]) -> BackupPrivacy {
    let (bom, source) = match bytes.strip_prefix(b"\xEF\xBB\xBF") {
        Some(rest) => (true, rest),
        None => (false, bytes),
    };
    let Some(block) = split_block(source) else {
        return BackupPrivacy::Public;
    };
    match classify_block(&source[block.raw]) {
        BackupPrivacy::Private if bom => {
            BackupPrivacy::Unreadable(UnreadableReason::BomBeforeFence)
        }
        privacy => privacy,
    }
}

fn classify_block(raw: &[u8]) -> BackupPrivacy {
    let Ok(text) = std::str::from_utf8(raw) else {
        return not_loaded(&String::from_utf8_lossy(raw), UnreadableReason::ParseFailed);
    };
    if text.trim().is_empty() {
        return BackupPrivacy::Public;
    }
    match load(text) {
        Load::NotLoaded(reason) => not_loaded(text, reason),
        Load::Loaded(_) if line_scan_private(text) => BackupPrivacy::Private,
        Load::Loaded(tree) => root_privacy(&tree),
    }
}

fn not_loaded(text: &str, reason: UnreadableReason) -> BackupPrivacy {
    if line_scan_private(text) {
        BackupPrivacy::Private
    } else if text.to_ascii_lowercase().contains("private") || text.contains('\\') {
        BackupPrivacy::Unreadable(reason)
    } else {
        BackupPrivacy::Public
    }
}

/// The root mapping's `private` value. Alias keys can repeat the key without
/// a duplicate-key error, so every `private` key counts, most restrictive
/// first. A key that only folds to `private` never locks the note, but any
/// value other than a falsy one makes it unreadable.
fn root_privacy(tree: &Tree) -> BackupPrivacy {
    let mut privacy = BackupPrivacy::Public;
    for (key, value) in tree.root_pairs() {
        let NodeKind::Scalar(key) = tree.resolve(key) else {
            continue;
        };
        let exact = key.text == "private";
        if !exact && !is_private_key_variant(&key.text) {
            continue;
        }
        let class = match tree.resolve(value) {
            NodeKind::Scalar(scalar) => classify_scalar(scalar),
            _ => ValueClass::Unrecognized,
        };
        match class {
            ValueClass::Private if exact => return BackupPrivacy::Private,
            ValueClass::Public => {}
            ValueClass::Private | ValueClass::Unrecognized => {
                privacy = BackupPrivacy::Unreadable(if exact {
                    UnreadableReason::UnrecognizedValue
                } else {
                    UnreadableReason::PrivateKeyVariant
                });
            }
        }
    }
    privacy
}

/// Whether `text` is `private` once ASCII-trimmed and ASCII-case-folded.
fn is_private_key_variant(text: &str) -> bool {
    text.trim_matches(|character: char| character.is_ascii_whitespace())
        .eq_ignore_ascii_case("private")
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;
    use crate::scan::MAX_BLOCK_BYTES;

    fn classify(block: &str) -> BackupPrivacy {
        backup_privacy(format!("---\n{block}\n---\nbody\n").as_bytes())
    }

    const PRIVATE: BackupPrivacy = BackupPrivacy::Private;
    const PUBLIC: BackupPrivacy = BackupPrivacy::Public;

    fn unreadable(reason: UnreadableReason) -> BackupPrivacy {
        BackupPrivacy::Unreadable(reason)
    }

    #[test]
    fn tagged_values_unwrap() {
        assert_eq!(classify("private: !x true"), PRIVATE);
        assert_eq!(classify("private: !custom true"), PRIVATE);
        assert_eq!(classify("private: !!bool yes"), PRIVATE);
        assert_eq!(
            classify("private: !!bool no"),
            unreadable(UnreadableReason::UnrecognizedValue)
        );
        assert_eq!(classify("private: !!int 0x1"), PRIVATE);
        assert_eq!(classify("private: !!int 0o1"), PRIVATE);
        assert_eq!(
            classify("!custom {private: true}"),
            unreadable(UnreadableReason::NotAMapping)
        );
    }

    #[test]
    fn escaped_and_tabbed_keys_fail_closed() {
        assert_eq!(classify("\"\\u0070rivate\": true"), PRIVATE);
        // saphyr rejects a tab after the colon; the backslash keeps the
        // escaped spelling withheld.
        assert_eq!(
            classify("\"\\u0070rivate\":\ttrue"),
            unreadable(UnreadableReason::ParseFailed)
        );
        assert_eq!(classify("private:\ttrue"), PRIVATE);
    }

    #[test]
    fn yaml_1_1_words_are_unrecognized() {
        assert_eq!(
            classify("%YAML 1.1\n--- #c\nprivate: y"),
            unreadable(UnreadableReason::UnrecognizedValue)
        );
    }

    #[test]
    fn duplicate_keys_in_either_order_are_private() {
        assert_eq!(classify("private: true\nprivate: false"), PRIVATE);
        assert_eq!(classify("private: false\nprivate: true"), PRIVATE);
    }

    #[test]
    fn structure_decides_which_private_key_counts() {
        assert_eq!(classify("base: &t true\nprivate: *t"), PRIVATE);
        assert_eq!(classify("{private: true}"), PRIVATE);
        assert_eq!(classify("meta: {private: true}"), PUBLIC);
        assert_eq!(classify("k: &k private\n*k : true"), PRIVATE);
        assert_eq!(classify("? |-\n  private\n: true"), PRIVATE);
    }

    #[test]
    fn unrecognized_values_are_unreadable() {
        for value in ["2", "maybe", "[true]", "{a: 1}", "y"] {
            assert_eq!(
                classify(&format!("private: {value}")),
                unreadable(UnreadableReason::UnrecognizedValue),
                "{value}"
            );
        }
    }

    #[test]
    fn a_byte_order_mark_before_a_locking_fence_is_unreadable() {
        assert_eq!(
            backup_privacy(b"\xEF\xBB\xBF---\nprivate: true\n---\nbody"),
            unreadable(UnreadableReason::BomBeforeFence)
        );
        assert_eq!(
            backup_privacy(b"\xEF\xBB\xBF---\ntitle: x\n---\nbody"),
            PUBLIC
        );
    }

    #[test]
    fn an_unterminated_fence_is_public() {
        assert_eq!(
            backup_privacy(b"---\ntitle: Never Closed\nmy private thoughts\n"),
            PUBLIC
        );
    }

    #[test]
    fn a_block_that_does_not_load_falls_back_to_the_line_scan() {
        assert_eq!(classify("private: true\ntitle: [unclosed"), PRIVATE);
        assert_eq!(
            classify("private: no\ntitle: [unclosed"),
            unreadable(UnreadableReason::ParseFailed)
        );
        assert_eq!(
            classify("title: \"C:\\notes\"\ntags: [unclosed"),
            unreadable(UnreadableReason::ParseFailed)
        );
        assert_eq!(classify("title: [unclosed"), PUBLIC);
    }

    #[test]
    fn an_alias_bomb_returns_quickly_without_loading() {
        let mut bomb = String::from("private: false\na: &a [\"lol\",\"lol\",\"lol\",\"lol\",\"lol\",\"lol\",\"lol\",\"lol\",\"lol\"]\n");
        let names = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];
        for pair in names.windows(2) {
            let refs = vec![format!("*{}", pair[0]); 9].join(",");
            bomb.push_str(&format!("{}: &{} [{refs}]\n", pair[1], pair[1]));
        }
        assert_eq!(bomb.matches('*').count(), 90);
        assert!(bomb.len() < 500, "{}", bomb.len());
        let started = Instant::now();
        // Loaded, `private: false` would be public; not loaded, it's withheld.
        assert_eq!(classify(&bomb), unreadable(UnreadableReason::AliasBudget));
        assert!(started.elapsed() < Duration::from_millis(250));
    }

    #[test]
    fn an_oversized_block_is_never_parsed() {
        let padding = "# padding\n".repeat(MAX_BLOCK_BYTES / 10 + 1);
        assert_eq!(
            classify(&format!("private: false\n{padding}")),
            unreadable(UnreadableReason::TooLarge)
        );
        assert_eq!(classify(&format!("private: true\n{padding}")), PRIVATE);
        assert_eq!(classify(&format!("title: x\n{padding}")), PUBLIC);
    }

    #[test]
    fn a_non_utf8_block_falls_back_to_the_line_scan() {
        assert_eq!(backup_privacy(b"---\nprivate: true\n\xff\n---\n"), PRIVATE);
        assert_eq!(
            backup_privacy(b"---\nprivate: no\n\xff\n---\n"),
            unreadable(UnreadableReason::ParseFailed)
        );
        // A valid block in front of a non-UTF-8 body classifies normally.
        assert_eq!(
            backup_privacy(b"---\nprivate: true\n---\n\xff\xfe"),
            PRIVATE
        );
    }

    /// saphyr ends its input at a NUL and keeps a byte-order mark in the first
    /// key, where yaml (and so the app) reads on: a `private: true` behind
    /// either stays withheld because neither side loads the block.
    #[test]
    fn a_lock_behind_a_nul_or_a_byte_order_mark_stays_withheld() {
        for block in [
            "\u{feff}private: true",
            "\u{feff}&a private: !!bool yes",
            "\u{feff}{private: true}",
            "title: x # \0\nprivate:\n  yes",
            "title: x\0\n? private\n: true",
            "title: x\0\nprivate: >-\n  on",
            "title: x\0\n\"\\u0070rivate\": true",
            "k: &k private\ntitle: x\0\n*k : true",
        ] {
            assert_eq!(
                classify(block),
                unreadable(UnreadableReason::ParseFailed),
                "{block:?}"
            );
        }
        // The fence's own byte-order mark keeps its reason; one inside the
        // block is a character the block can't hold.
        assert_eq!(
            backup_privacy(b"\xEF\xBB\xBF---\n\xEF\xBB\xBFprivate: true\n---\n"),
            unreadable(UnreadableReason::ParseFailed)
        );
        // A refused block that never mentions `private` stays public.
        assert_eq!(classify("title: x\u{7}y"), PUBLIC);
    }

    #[test]
    fn ordinary_values_classify_as_expected() {
        assert_eq!(backup_privacy(b"# no frontmatter\n"), PUBLIC);
        assert_eq!(backup_privacy(b"---\n---\nbody"), PUBLIC);
        assert_eq!(classify("title: Plain"), PUBLIC);
        assert_eq!(classify("private: false"), PUBLIC);
        assert_eq!(classify("private:"), PUBLIC);
        assert_eq!(classify("private: 1.0"), PRIVATE);
        assert_eq!(classify("private: \"yes\""), PRIVATE);
        assert_eq!(classify("private: on"), PRIVATE);
    }
}
