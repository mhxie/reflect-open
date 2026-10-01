//! The downloadable whisper.cpp models and where they sit in the hf-hub cache.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

/// Hugging Face repo hosting whisper.cpp's GGML conversions (MIT).
pub const MODEL_REPO: &str = "ggerganov/whisper.cpp";

/// One downloadable model. `id` is the stable identifier settings store; the
/// frontend catalog (`packages/core/src/ai/local-transcription.ts`) mirrors
/// the ids with display names and sizes.
pub struct ModelSpec {
    pub id: &'static str,
    pub file: &'static str,
}

/// The catalog, default first: full-precision large-v3 turbo, then smaller
/// quantizations of it, then the quantized non-turbo model for the languages
/// where turbo's four-layer decoder trails.
pub const MODELS: [ModelSpec; 4] = [
    ModelSpec {
        id: "large-v3-turbo",
        file: "ggml-large-v3-turbo.bin",
    },
    ModelSpec {
        id: "large-v3-turbo-q8_0",
        file: "ggml-large-v3-turbo-q8_0.bin",
    },
    ModelSpec {
        id: "large-v3-turbo-q5_0",
        file: "ggml-large-v3-turbo-q5_0.bin",
    },
    ModelSpec {
        id: "large-v3-q5_0",
        file: "ggml-large-v3-q5_0.bin",
    },
];

/// The newest `ggml-large-v<N>` generation the catalog covers.
pub const CATALOG_GENERATION: u32 = 3;

pub fn model_spec(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|model| model.id == id)
}

/// The hf-hub cache directory of the model repo.
fn repo_dir(cache_dir: &Path) -> PathBuf {
    cache_dir.join(format!("models--{}", MODEL_REPO.replace('/', "--")))
}

/// A cached copy of one model file. `etag` is the blob's name: the file's
/// LFS SHA-256, which the update check compares against upstream.
pub struct CachedModel {
    pub path: PathBuf,
    pub etag: String,
}

/// The newest cached copy of `file` across every snapshot. hf-hub's own
/// lookup only follows `refs/main`, which moves whenever *any* file of the
/// repo is downloaded, so a model fetched at an older commit would read as
/// missing there.
pub fn find_cached(cache_dir: &Path, file: &str) -> Option<CachedModel> {
    let mut newest: Option<(SystemTime, CachedModel)> = None;
    for (pointer, blob) in pointers(cache_dir, file) {
        let Ok(metadata) = fs::metadata(&blob) else {
            continue;
        };
        let Some(etag) = blob.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        if newest.as_ref().is_none_or(|(seen, _)| modified > *seen) {
            let copy = CachedModel {
                path: pointer,
                etag: etag.to_string(),
            };
            newest = Some((modified, copy));
        }
    }
    newest.map(|(_, copy)| copy)
}

/// Remove cached copies of `file` (snapshot pointers and their blobs),
/// sparing the one whose etag is `keep` — an update prunes the superseded
/// weights, a delete removes everything.
pub fn remove_cached(cache_dir: &Path, file: &str, keep: Option<&str>) -> std::io::Result<()> {
    for (pointer, blob) in pointers(cache_dir, file) {
        let etag = blob.file_name().and_then(|name| name.to_str());
        if keep.is_some() && etag == keep {
            continue;
        }
        remove_if_present(&blob)?;
        remove_if_present(&pointer)?;
    }
    Ok(())
}

/// `(pointer, blob)` for every snapshot that links `file`.
fn pointers(cache_dir: &Path, file: &str) -> Vec<(PathBuf, PathBuf)> {
    let Ok(snapshots) = fs::read_dir(repo_dir(cache_dir).join("snapshots")) else {
        return Vec::new();
    };
    snapshots
        .flatten()
        .filter_map(|snapshot| {
            let pointer = snapshot.path().join(file);
            let target = fs::read_link(&pointer).ok()?;
            // A relative link resolves against the pointer's own directory.
            let blob = snapshot.path().join(target);
            Some((pointer, blob))
        })
        .collect()
}

fn remove_if_present(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err),
        _ => Ok(()),
    }
}

/// Whether `etag` has the shape of a SHA-256 digest (LFS files); only those
/// can be verified against the downloaded bytes.
pub fn is_sha256(etag: &str) -> bool {
    etag.len() == 64 && etag.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Lowercase hex SHA-256 of a file, streamed so gigabyte models never sit
/// in memory.
pub fn file_sha256(path: &Path) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache_with(files: &[(&str, &str, &str)]) -> tempfile::TempDir {
        let cache = tempfile::tempdir().unwrap();
        let repo = repo_dir(cache.path());
        for (commit, file, etag) in files {
            let blobs = repo.join("blobs");
            fs::create_dir_all(&blobs).unwrap();
            fs::write(blobs.join(etag), etag.as_bytes()).unwrap();
            let snapshot = repo.join("snapshots").join(commit);
            fs::create_dir_all(&snapshot).unwrap();
            std::os::unix::fs::symlink(format!("../../blobs/{etag}"), snapshot.join(file)).unwrap();
        }
        cache
    }

    #[test]
    fn finds_a_model_downloaded_at_an_older_commit() {
        let cache = cache_with(&[
            ("old", "ggml-large-v3-turbo.bin", "aaa"),
            ("new", "ggml-large-v3-q5_0.bin", "bbb"),
        ]);
        let found = find_cached(cache.path(), "ggml-large-v3-turbo.bin").unwrap();
        assert_eq!(found.etag, "aaa");
        assert!(found
            .path
            .ends_with("snapshots/old/ggml-large-v3-turbo.bin"));
        assert!(find_cached(cache.path(), "ggml-large-v3-turbo-q8_0.bin").is_none());
    }

    #[test]
    fn remove_keeps_only_the_requested_etag() {
        let cache = cache_with(&[
            ("old", "ggml-large-v3-turbo.bin", "aaa"),
            ("new", "ggml-large-v3-turbo.bin", "ccc"),
            ("new", "ggml-large-v3-q5_0.bin", "bbb"),
        ]);
        remove_cached(cache.path(), "ggml-large-v3-turbo.bin", Some("ccc")).unwrap();
        assert_eq!(
            find_cached(cache.path(), "ggml-large-v3-turbo.bin")
                .unwrap()
                .etag,
            "ccc"
        );
        remove_cached(cache.path(), "ggml-large-v3-turbo.bin", None).unwrap();
        assert!(find_cached(cache.path(), "ggml-large-v3-turbo.bin").is_none());
        assert!(find_cached(cache.path(), "ggml-large-v3-q5_0.bin").is_some());
    }

    #[test]
    fn hashes_files_and_recognizes_lfs_etags() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.bin");
        fs::write(&path, b"abc").unwrap();
        let digest = file_sha256(&path).unwrap();
        assert_eq!(
            digest,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(is_sha256(&digest));
        assert!(!is_sha256("\"not-a-digest\""));
    }

    #[test]
    fn catalog_ids_are_unique_and_the_default_is_first() {
        assert_eq!(MODELS[0].id, "large-v3-turbo");
        for (index, model) in MODELS.iter().enumerate() {
            assert!(MODELS[index + 1..].iter().all(|other| other.id != model.id));
            assert_eq!(model_spec(model.id).unwrap().file, model.file);
        }
    }
}
