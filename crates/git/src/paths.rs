//! The paths a pull never writes.
//!
//! libgit2 checks names only at checkout and on insert, never when it parses
//! a fetched tree, and it knows nothing of `.reflect`. So before a pull
//! writes anything it checks every path the other device changed: an empty,
//! `.`, or `..` component, a `.git` component (in any spelling the volume
//! folds onto it, or behind HFS-ignorable code points), a first component
//! that folds onto the graph's own `.reflect` folder without being spelled
//! `.reflect` (the checkout leaves `.reflect` itself alone), a backslash, a
//! leading slash, or invalid UTF-8 pauses sync before anything is touched.

use unicase::UniCase;
use unicode_normalization::UnicodeNormalization;

use reflect_types::{AppError, AppResult};

/// The graph's own runtime folder (the index, the capture spool, staging),
/// which no commit ever carries. The checkout excludes it by this spelling.
const RUNTIME_DIR: &str = ".reflect";

/// Refuse, before anything is written, a path the pull must never act on.
/// `path` is the raw tree path, so invalid UTF-8 is caught, not replaced.
pub(super) fn ensure_writable_path(path: &[u8]) -> AppResult<()> {
    let refuse = |why: &str| {
        Err(AppError::io(format!(
            "Sync paused: the backup holds a path Reflect never writes ({why}): {:?}. Nothing was \
             changed. Remove that path from the backup repository, then sync again.",
            String::from_utf8_lossy(path)
        )))
    };
    let Ok(text) = std::str::from_utf8(path) else {
        return refuse("it is not valid UTF-8");
    };
    if text.starts_with('/') {
        return refuse("it is absolute");
    }
    if text.contains('\\') {
        return refuse("it holds a backslash");
    }
    for (position, component) in text.split('/').enumerate() {
        if component.is_empty() {
            return refuse("it has an empty component");
        }
        if component == "." || component == ".." {
            return refuse("it has a `.` or `..` component");
        }
        if opens(component, ".git") {
            return refuse("it names a `.git` folder");
        }
        if position == 0 && component != RUNTIME_DIR && opens(component, RUNTIME_DIR) {
            return refuse("it is inside Reflect's own `.reflect` folder");
        }
    }
    Ok(())
}

/// Whether `component` opens the entry named `reserved` (lowercase ASCII)
/// on a volume that folds case and normalization ([`fold`]: `.GIT`, and
/// `.reﬂect` with the `ﬂ` ligature on APFS), also once the code points HFS+
/// ignores in names are removed (`.g\u{200c}it` opens `.git` there).
fn opens(component: &str, reserved: &str) -> bool {
    let visible: String = component
        .chars()
        .filter(|character| !is_hfs_ignorable(*character))
        .collect();
    fold(&visible) == reserved
}

/// The code points HFS+ drops from file names (Git's `next_hfs_char`).
fn is_hfs_ignorable(character: char) -> bool {
    matches!(
        character,
        '\u{200c}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{206a}'..='\u{206f}' | '\u{feff}'
    )
}

/// `path` folded the way APFS compares names: canonically decomposed, then
/// case-folded the full Unicode way and decomposed again. `Plan.md` and
/// `plan.md`, the NFC and NFD spellings of `café.md`, and `straße.md` and
/// `strasse.md` are each one name there, so each folds to one key. Used
/// where a name the volume aliases must count as taken; folding slightly
/// more than a given volume does only costs a copy its first number.
pub(super) fn fold(path: &str) -> String {
    let decomposed: String = path.nfd().collect();
    UniCase::unicode(decomposed)
        .to_folded_case()
        .nfd()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(path: &[u8]) -> bool {
        match ensure_writable_path(path) {
            Ok(()) => false,
            Err(AppError::Io { message, .. }) => {
                assert!(message.starts_with("Sync paused:"), "{message}");
                true
            }
            Err(other) => panic!("expected a pause, got {other:?}"),
        }
    }

    #[test]
    fn unsafe_tree_paths_are_refused() {
        for path in [
            "..",
            ".",
            "notes/../escape.md",
            "notes/./a.md",
            "notes//a.md",
            "notes/",
            "/etc/passwd",
            "notes\\a.md",
            ".git",
            ".GIT/config",
            "notes/.Git/hooks/post-checkout",
            ".g\u{200c}it/config",
            "\u{feff}.git",
            ".git\u{206f}",
            ".REFLECT/tmp",
            ".Reflect/inbox/p.jpg",
            // `ﬂ` (U+FB02) case-folds to `fl`: APFS opens `.reflect` here.
            ".re\u{fb02}ect/inbox/evil.json",
            ".re\u{200c}flect/index.sqlite",
        ] {
            assert!(refused(path.as_bytes()), "{path:?}");
        }
        assert!(refused(b"notes/\xff.md"));
    }

    #[test]
    fn ordinary_tree_paths_pass() {
        for path in [
            "notes/a.md",
            ".gitignore",
            ".github/workflows/ci.yml",
            "notes/git",
            "notes/x.git",
            "notes/caf\u{e9}.md",
            "daily/2026-10-04.md",
            // The checkout leaves the runtime folder itself alone.
            ".reflect/index.sqlite",
            // Only the graph's own `.reflect` is reserved.
            "notes/.reflect/a.md",
            ".reflections/a.md",
            "reflect/a.md",
        ] {
            assert!(!refused(path.as_bytes()), "{path:?}");
        }
    }

    #[test]
    fn names_fold_the_way_apfs_compares_them() {
        assert_eq!(fold("notes/Plan.md"), fold("notes/plan.md"));
        assert_eq!(fold("notes/caf\u{e9}.md"), fold("notes/cafe\u{301}.md"));
        assert_eq!(fold("notes/CAF\u{c9}.md"), fold("notes/cafe\u{301}.md"));
        assert_eq!(fold("notes/stra\u{df}e.md"), fold("notes/strasse.md"));
        assert_eq!(fold(".re\u{fb02}ect"), ".reflect");
        assert_ne!(fold("notes/plan.md"), fold("notes/plan-2.md"));
        assert_ne!(fold("notes/cafe.md"), fold("notes/caf\u{e9}.md"));
    }
}
