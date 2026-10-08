//! Settings sections keyed by graph root, shared by the desktop app (which
//! writes them) and the CLI (which reads the local-only folders back).

use std::path::Path;

/// The settings-document key holding every graph's local-only configuration.
pub const LOCAL_ONLY_SETTINGS_KEY: &str = "localOnlyFolders";

/// The key among `keys` that configures the graph at `root`: the exact root
/// string or, failing that, one naming the same folder (recents may hold a
/// non-canonical spelling). An exact key wins over a canonical match, so two
/// spellings of one folder resolve the same way on every surface.
pub fn graph_settings_key<'key>(
    keys: impl IntoIterator<Item = &'key String>,
    root: &Path,
) -> Option<&'key String> {
    let exact = root.to_str();
    let mut canonical = None;
    for key in keys {
        if exact == Some(key.as_str()) {
            return Some(key);
        }
        if canonical.is_none() && same_folder(key, root) {
            canonical = Some(key);
        }
    }
    canonical
}

/// Whether a settings key names the folder at `root`: spelled alike, or
/// canonically equal.
pub fn same_folder(key: &str, root: &Path) -> bool {
    Path::new(key) == root
        || match (Path::new(key).canonicalize(), root.canonicalize()) {
            (Ok(key), Ok(root)) => key == root,
            _ => false,
        }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_exact_key_wins_over_an_earlier_canonical_match() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("graph");
        std::fs::create_dir(&root).unwrap();
        let alias = format!("{}/./graph", dir.path().display());
        let exact = root.display().to_string();
        let keys = [alias.clone(), exact.clone()];

        assert_eq!(graph_settings_key(&keys, &root), Some(&exact));
        assert_eq!(graph_settings_key(&keys[..1], &root), Some(&alias));
        assert_eq!(graph_settings_key(&[], &root), None);
    }
}
