//! Line-ending normalization that never changes a note's privacy verdict.

use reflect_graph_paths::normalize_line_endings;

use crate::classify::backup_privacy;

/// `text` with `\n` line endings ([`normalize_line_endings`]), unless that
/// would change its [`backup_privacy`] verdict: a lone `\r` can hide or
/// reveal a closing fence or a `private:` line, and normalizing such a note
/// could unlock it. That text is returned as is, so every reader sees the
/// verdict the bytes on disk carry.
pub fn normalize_line_endings_keeping_privacy(text: String) -> String {
    if !text.contains('\r') {
        return text;
    }
    let normalized = normalize_line_endings(text.clone());
    if backup_privacy(text.as_bytes()) == backup_privacy(normalized.as_bytes()) {
        normalized
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_unless_the_verdict_would_change() {
        for (source, expected) in [
            ("a\r\nb\rc", "a\nb\nc"),
            (
                "---\r\nprivate: true\r\n---\r\nsecret",
                "---\nprivate: true\n---\nsecret",
            ),
            // A lone CR keeps this block from loading, so it is withheld;
            // normalized, it would read `private: false` and be public.
            (
                "---\ntitle: x\rprivate: false\n---\nsecret",
                "---\ntitle: x\rprivate: false\n---\nsecret",
            ),
            // Normalized, the CR before `---` would close the block early and
            // leave the lock in the body.
            (
                "---\ntitle: x\r---\rprivate: true\n---\nsecret",
                "---\ntitle: x\r---\rprivate: true\n---\nsecret",
            ),
        ] {
            let actual = normalize_line_endings_keeping_privacy(source.to_string());
            assert_eq!(actual, expected, "{source:?}");
            assert_eq!(
                backup_privacy(source.as_bytes()),
                backup_privacy(actual.as_bytes())
            );
        }
    }
}
