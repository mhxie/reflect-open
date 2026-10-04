//! The on-disk caches behind the `reflect-asset://` protocol's rendered
//! previews (PDF pages, image thumbnails): entries live under
//! `.reflect/cache/<kind>/<key>/<file>`, the key hashing the source file's
//! path, size, and mtime so an edited file misses; a hit refreshes the entry's
//! mtime and [`sweep_cache_dir`] evicts least-recently-used entries past a cap
//! when a graph opens. Rebuildable runtime state: deleting any of it costs
//! only a re-render.

use std::fs::{self, File};
use std::io::Read;
use std::path::Path;
use std::time::SystemTime;

use sha2::{Digest, Sha256};

/// The PNG file signature.
pub(super) const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// Does `bytes` start like a PNG?
pub(super) fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(PNG_SIGNATURE)
}

/// The cache key for one version of one source file: a SHA-256 prefix over
/// the cache `format` (bumped when output changes), graph-relative path,
/// size, and mtime.
pub(super) fn cache_key(format: &str, rel: &str, size: u64, modified_ms: u64) -> String {
    let digest = Sha256::digest(format!("{format}\0{rel}\0{size}\0{modified_ms}"));
    digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A cached entry's bytes, or `None` when there is none or `accepts` rejects
/// them (a truncated or foreign file). A hit refreshes the entry's mtime: the
/// sweep evicts least-recently-used first, and access times are not
/// dependable on macOS.
pub(super) fn read_cached(path: &Path, accepts: fn(&[u8]) -> bool) -> Option<Vec<u8>> {
    let mut file = File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    if !accepts(&bytes) {
        return None;
    }
    if let Err(err) = file.set_modified(SystemTime::now()) {
        tracing::debug!(%err, path = %path.display(), "failed to refresh a cached preview");
    }
    Some(bytes)
}

/// Bound the cache at `cache_dir` (graph-relative): past `cap` bytes, delete
/// the least-recently-used `*.<extension>` entries until the rest fit, then
/// any emptied key directories. Best-effort — nothing here can fail a graph
/// open.
pub(super) fn sweep_cache_dir(root: &Path, cache_dir: &str, extension: &str, cap: u64) {
    // `.reflect/` itself is vetted at open; below it nothing symlinked is
    // followed, so a planted link cannot point the sweep's deletes elsewhere.
    let is_real_dir =
        |path: &Path| fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir());
    let cache = root.join(cache_dir);
    if !is_real_dir(&cache) || !cache.parent().is_some_and(is_real_dir) {
        return;
    }
    let Ok(keys) = fs::read_dir(&cache) else {
        return;
    };
    let mut entries = Vec::new();
    let mut total = 0u64;
    let mut key_dirs = Vec::new();
    for key in keys.flatten() {
        let key = key.path();
        if !is_real_dir(&key) {
            continue;
        }
        if let Ok(files) = fs::read_dir(&key) {
            for file in files.flatten() {
                let path = file.path();
                let Ok(metadata) = fs::symlink_metadata(&path) else {
                    continue;
                };
                if !metadata.is_file() || path.extension().is_none_or(|ext| ext != extension) {
                    continue;
                }
                total += metadata.len();
                let used = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                entries.push((used, metadata.len(), path));
            }
        }
        key_dirs.push(key);
    }
    if total <= cap {
        return;
    }
    let before = total;
    entries.sort_by_key(|(used, _, _)| *used);
    for (_, len, path) in entries {
        if total <= cap {
            break;
        }
        match fs::remove_file(&path) {
            Ok(()) => total -= len,
            Err(err) => {
                tracing::debug!(%err, path = %path.display(), "failed to evict a cached preview");
            }
        }
    }
    for key in key_dirs {
        // Only empties go: `remove_dir` refuses a directory with entries.
        let _ = fs::remove_dir(key);
    }
    tracing::debug!(
        cache_dir,
        before,
        after = total,
        cap,
        "swept a preview cache"
    );
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    /// Write `bytes` at `rel` under `cache_dir`, last used `age_secs` ago.
    fn entry(root: &Path, cache_dir: &str, rel: &str, bytes: &[u8], age_secs: u64) -> PathBuf {
        let path = root.join(cache_dir).join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(SystemTime::now() - std::time::Duration::from_secs(age_secs))
            .unwrap();
        path
    }

    #[test]
    fn sweeps_only_its_own_entries_least_recently_used_first() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let cache = ".reflect/cache/thumbnails";
        let oldest = entry(root, cache, "a/320.thumb", &[0; 400], 300);
        let newer = entry(root, cache, "b/640.thumb", &[0; 400], 200);
        let newest = entry(root, cache, "a/640.thumb", &[0; 400], 100);
        let foreign = entry(root, cache, "c/notes.png", &[0; 4000], 400);

        sweep_cache_dir(root, cache, "thumb", 900);

        assert!(!oldest.exists());
        assert!(newer.exists() && newest.exists());
        assert!(
            foreign.exists(),
            "only the cache's own extension is an entry"
        );
    }

    #[test]
    fn a_hit_refreshes_the_entry_and_a_rejected_one_misses() {
        let dir = tempfile::tempdir().unwrap();
        let path = entry(dir.path(), "cache", "key/1.png", PNG_SIGNATURE, 3600);
        let before = fs::metadata(&path).unwrap().modified().unwrap();

        assert_eq!(read_cached(&path, is_png).as_deref(), Some(PNG_SIGNATURE));
        assert!(fs::metadata(&path).unwrap().modified().unwrap() > before);
        assert_eq!(read_cached(&path, |_| false), None);
    }
}
