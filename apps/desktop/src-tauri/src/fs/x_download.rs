use super::x_archive_store as archive;
use crate::error::{AppError, AppResult as Result};
use reflect_graph_paths::LocalOnlyFolders;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

type Download = tokio::sync::OnceCell<Result<archive::Receipt>>;
type Downloads = Mutex<HashMap<PathBuf, Arc<Download>>>;
fn downloads() -> &'static Downloads {
    static DOWNLOADS: OnceLock<Downloads> = OnceLock::new();
    DOWNLOADS.get_or_init(Default::default)
}

/// Concurrent callers share success and failure. A later request may retry.
async fn shared_download(
    key: PathBuf,
    action: impl std::future::Future<Output = Result<archive::Receipt>>,
) -> Result<archive::Receipt> {
    let entry = downloads()
        .lock()
        .expect("downloads")
        .entry(key.clone())
        .or_default()
        .clone();
    let result = entry.get_or_init(|| action).await.clone();
    let mut pending = downloads().lock().expect("downloads");
    if pending
        .get(&key)
        .is_some_and(|current| Arc::ptr_eq(current, &entry))
    {
        pending.remove(&key);
    }
    result
}

fn network(error: reqwest::Error) -> AppError {
    AppError::Network {
        message: error.to_string(),
    }
}

// Bound network transfers across every graph/post, while retaining per-URL sharing.
const MAX_CONCURRENT_DOWNLOADS: usize = 4;
static DOWNLOAD_SLOTS: tokio::sync::Semaphore =
    tokio::sync::Semaphore::const_new(MAX_CONCURRENT_DOWNLOADS);

/// Hold every download slot: a download that gets past its guards then
/// waits instead of fetching, which keeps command-tier tests offline.
#[cfg(test)]
pub(super) async fn hold_every_slot() -> tokio::sync::SemaphorePermit<'static> {
    DOWNLOAD_SLOTS
        .acquire_many(MAX_CONCURRENT_DOWNLOADS as u32)
        .await
        .expect("download semaphore stays open")
}

fn client() -> Result<reqwest::Client> {
    static CLIENT: OnceLock<Result<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(180))
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    if attempt.previous().len() >= 5 || !allowed(attempt.url()) {
                        attempt.error("unsupported-media-redirect")
                    } else {
                        attempt.follow()
                    }
                }))
                .build()
                .map_err(network)
        })
        .clone()
}

fn allowed(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && matches!(url.host_str(), Some("pbs.twimg.com" | "video.twimg.com"))
}

/// Start or join one download. Only the final validated file is visible in
/// assets/x. Writes go through the write guard with the graph's local-only
/// folders, so an `assets/` aliased into one is refused before anything is
/// fetched.
pub async fn download(
    root: PathBuf,
    local_only: Option<Arc<LocalOnlyFolders>>,
    url: String,
) -> Result<archive::Receipt> {
    let hash = archive::hash_url(&url)?;
    shared_download(root.join(&hash), download_once(root, local_only, url, hash)).await
}

/// The `assets/x` directory media lands in, through the write guard.
fn media_directory(root: &Path, local_only: Option<&LocalOnlyFolders>) -> Result<PathBuf> {
    super::resolve::resolve_write(root, "assets/x", local_only)
}

async fn download_once(
    root: PathBuf,
    local_only: Option<Arc<LocalOnlyFolders>>,
    url: String,
    hash: String,
) -> Result<archive::Receipt> {
    let cache_root = root.clone();
    let cache_hash = hash.clone();
    if let Some(receipt) =
        tauri::async_runtime::spawn_blocking(move || archive::find_cache(&cache_root, &cache_hash))
            .await
            .map_err(|error| AppError::io(error.to_string()))??
    {
        return Ok(receipt);
    }
    let remote = reqwest::Url::parse(&url).map_err(|error| AppError::parse(error.to_string()))?;
    if !allowed(&remote) {
        return Err(AppError::parse("unsupported-media-url"));
    }
    let directory = media_directory(&root, local_only.as_deref())?;
    let _slot = DOWNLOAD_SLOTS
        .acquire()
        .await
        .expect("download semaphore stays open");
    let client = client()?;
    let mut response = client
        .get(remote)
        .send()
        .await
        .map_err(network)?
        .error_for_status()
        .map_err(network)?;
    // Enforce the same limit with or without a trustworthy Content-Length.
    let limit = archive::MEDIA_MAX_BYTES;
    if response.content_length().is_some_and(|bytes| bytes > limit) {
        return Err(AppError::parse("media-too-large"));
    }
    tokio::fs::create_dir_all(&directory).await?;

    let temporary = tempfile::Builder::new()
        .prefix(".part-")
        .tempfile_in(archive::temporary_directory(&root)?)?;
    let mut file = tokio::fs::File::from_std(temporary.reopen()?);
    let mut bytes = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(network)? {
        bytes += chunk.len() as u64;
        if bytes > limit {
            return Err(AppError::parse("media-too-large"));
        }
        file.write_all(&chunk).await?;
    }
    file.sync_all().await?;
    drop(file);
    tauri::async_runtime::spawn_blocking(move || {
        let (extension, mime, bytes) = archive::sniff(temporary.path())?;
        let name = format!("url_sha256_{hash}.{extension}");
        let path = super::resolve::resolve_write(
            &root,
            &format!("assets/x/{name}"),
            local_only.as_deref(),
        )?;
        temporary.persist(path).map_err(|error| error.error)?;
        #[cfg(unix)]
        std::fs::File::open(directory)?.sync_all()?;
        Ok(archive::Receipt { name, mime, bytes })
    })
    .await
    .map_err(|error| AppError::io(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The aliased-assets fixture: `assets/` links into a real local-only
    /// folder inside the graph.
    #[cfg(unix)]
    fn aliased_assets() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("people/secure")).unwrap();
        std::os::unix::fs::symlink(root.join("people/secure"), root.join("assets")).unwrap();
        (dir, root)
    }

    #[cfg(unix)]
    #[test]
    fn media_never_lands_in_a_local_only_folder_through_an_aliased_assets() {
        for configured in [true, false] {
            let (_dir, root) = aliased_assets();
            let folders = LocalOnlyFolders::new(["secure"], None);
            let folders = if configured { folders } else { None };
            // Control: without the folders the alias is an ordinary folder.
            assert_eq!(
                media_directory(&root, folders.as_ref()).is_ok(),
                !configured
            );
        }
        // The download refuses before fetching anything.
        let (_dir, root) = aliased_assets();
        let folders = LocalOnlyFolders::new(["secure"], None).map(Arc::new);
        let refused = tauri::async_runtime::block_on(download(
            root.clone(),
            folders,
            "https://pbs.twimg.com/media/never-fetched.jpg".into(),
        ));
        let message = format!("{:?}", refused.expect_err("refused"));
        assert!(message.contains("local-only"), "{message}");
        assert_eq!(
            std::fs::read_dir(root.join("people/secure"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn restricts_downloads_to_anonymous_https_cdn_urls() {
        for url in [
            "https://pbs.twimg.com/a.png",
            "https://video.twimg.com/a.mp4",
        ] {
            assert!(allowed(&reqwest::Url::parse(url).unwrap()));
        }
        for url in [
            "http://pbs.twimg.com/a.png",
            "https://pbs.twimg.com.evil.test/a.png",
            "https://user:password@pbs.twimg.com/a.png",
            "https://pbs.twimg.com:444/a.png",
            "https://127.0.0.1/a.png",
        ] {
            assert!(!allowed(&reqwest::Url::parse(url).unwrap()));
        }
    }

    #[test]
    fn concurrent_callers_share_failure_and_later_calls_retry() {
        tauri::async_runtime::block_on(async {
            let key = tempfile::tempdir().unwrap();
            let key = key.path().join("shared-failure");
            let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let release = Arc::new(tokio::sync::Notify::new());
            let mut tasks = Vec::new();
            for _ in 0..20 {
                let key = key.clone();
                let calls = calls.clone();
                let release = release.clone();
                tasks.push(tauri::async_runtime::spawn(async move {
                    shared_download(key, async {
                        calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        release.notified().await;
                        Err(AppError::Network {
                            message: "offline".into(),
                        })
                    })
                    .await
                }));
            }
            // Wait until every caller owns the same pending entry before releasing it.
            loop {
                let ready = downloads()
                    .lock()
                    .unwrap()
                    .get(&key)
                    .is_some_and(|entry| Arc::strong_count(entry) == 21);
                if ready {
                    break;
                }
                tokio::task::yield_now().await;
            }
            release.notify_one();
            for task in tasks {
                assert!(matches!(task.await.unwrap(), Err(AppError::Network { .. })));
            }
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
            assert!(!downloads().lock().unwrap().contains_key(&key));
            let _ = shared_download(key, async {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Err(AppError::Network {
                    message: "retry".into(),
                })
            })
            .await;
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        });
    }

    #[test]
    fn returns_completed_media_offline_without_requesting_the_source() {
        let root = tempfile::tempdir().unwrap();
        // A non-CDN URL could never be downloaded, but an existing valid cache is usable.
        let url = "https://offline.invalid/photo.png";
        let hash = archive::hash_url(url).unwrap();
        let directory = root.path().join("assets/x");
        std::fs::create_dir_all(&directory).unwrap();
        let name = format!("url_sha256_{hash}.png");
        std::fs::write(directory.join(&name), b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR").unwrap();
        let receipt =
            tauri::async_runtime::block_on(download(root.path().to_owned(), None, url.into()))
                .unwrap();
        assert_eq!(receipt.name, name);
        assert_eq!(receipt.mime, "image/png");
        assert_eq!(std::fs::read_dir(directory).unwrap().count(), 1);
    }
    #[test]
    fn queued_download_waits_for_capacity_but_offline_cache_does_not() {
        tauri::async_runtime::block_on(async {
            let root = tempfile::tempdir().unwrap();
            let permits = DOWNLOAD_SLOTS
                .acquire_many(MAX_CONCURRENT_DOWNLOADS as u32)
                .await
                .unwrap();
            let pending = download(
                root.path().to_owned(),
                None,
                "https://pbs.twimg.com/waits-for-capacity.png".into(),
            );
            assert!(tokio::time::timeout(Duration::from_millis(50), pending)
                .await
                .is_err());
            let url = "https://pbs.twimg.com/cached.png";
            let hash = archive::hash_url(url).unwrap();
            let directory = root.path().join("assets/x");
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(
                directory.join(format!("url_sha256_{hash}.png")),
                b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR",
            )
            .unwrap();
            let receipt = tokio::time::timeout(
                Duration::from_secs(2),
                download(root.path().to_owned(), None, url.into()),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(receipt.mime, "image/png");
            drop(permits);
        });
    }
}
