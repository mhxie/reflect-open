//! The lookup half of the `reflect-asset://<generation>/x-media/<post>/<hash>`
//! route: which archived X media file a request names, waiting for its shared
//! download to publish a complete file. The shell owns the scheme handler,
//! the `Range` header and the file read.

use std::path::PathBuf;

use reflect_graph_io::graph_for;
use reflect_graph_io::x_archive_store as archive;

use crate::Core;

/// HTTP status for a malformed request path.
pub const STATUS_BAD_REQUEST: u16 = 400;
/// HTTP status for a request the graph session refuses.
pub const STATUS_FORBIDDEN: u16 = 403;
/// HTTP status for a post or resource the archive does not hold.
pub const STATUS_NOT_FOUND: u16 = 404;
/// HTTP status for a file path that cannot be resolved.
pub const STATUS_INTERNAL_ERROR: u16 = 500;
/// HTTP status for a failed media download.
pub const STATUS_BAD_GATEWAY: u16 = 502;

/// One validated X media request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XMediaRequest {
    pub generation: u64,
    pub post_id: String,
    pub hash: String,
}

/// A downloaded X media file, ready to read.
#[derive(Debug, Clone)]
pub struct XMediaFile {
    /// The graph root the file lives under, as `assets/x/<receipt.name>`.
    pub root: PathBuf,
    pub receipt: archive::Receipt,
}

/// Parses `<generation>/x-media/<post>/<hash>` (already percent-decoded), or
/// returns the HTTP status to refuse it with.
pub fn parse_x_media_path(path: &str) -> Result<XMediaRequest, u16> {
    let segments: Vec<_> = path.split('/').collect();
    if segments.len() != 4 || segments[1] != "x-media" {
        return Err(STATUS_BAD_REQUEST);
    }
    let Ok(generation) = segments[0].parse::<u64>() else {
        return Err(STATUS_BAD_REQUEST);
    };
    let post_id = segments[2].to_string();
    let hash = segments[3].to_string();
    if !archive::valid_id(&post_id) || !archive::valid_hash(&hash) {
        return Err(STATUS_BAD_REQUEST);
    }
    Ok(XMediaRequest {
        generation,
        post_id,
        hash,
    })
}

impl Core {
    /// Finds the archived media `request` names and waits until its shared
    /// download publishes a complete file, or returns the HTTP status to
    /// refuse it with.
    pub async fn x_media_file(&self, request: XMediaRequest) -> Result<XMediaFile, u16> {
        let XMediaRequest {
            generation,
            post_id,
            hash,
        } = request;
        let Ok((root, local_only)) = graph_for(&self.graph, Some(generation)) else {
            return Err(STATUS_FORBIDDEN);
        };
        let lookup_root = root.clone();
        let source = self
            .spawn_blocking(move || archive::resource_url(&lookup_root, &post_id, &hash))
            .await;
        let Ok(source) = source else {
            return Err(STATUS_NOT_FOUND);
        };
        // Keep this request pending until the shared download publishes a complete file.
        let Ok(receipt) = super::x_download::download(root.clone(), local_only, source).await
        else {
            return Err(STATUS_BAD_GATEWAY);
        };
        Ok(XMediaFile { root, receipt })
    }
}

#[cfg(all(test, unix))]
mod command_tests {
    use super::*;

    /// Command tier: the protocol hands the open graph's folders to the
    /// download, so with `assets/` linked into a real local-only folder an
    /// uncached resource is refused before any fetch. Every download slot is
    /// held, so nothing can fetch: the control session without folders gets
    /// past the guard and waits for a slot.
    #[test]
    fn the_media_protocol_takes_the_folders_from_the_open_graph() {
        use std::time::Duration;
        let url = "https://pbs.twimg.com/media/never-fetched.jpg";
        let hash = archive::hash_url(url).unwrap();
        for configured in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().canonicalize().unwrap();
            std::fs::create_dir_all(root.join("people/secure/x")).unwrap();
            std::os::unix::fs::symlink(root.join("people/secure"), root.join("assets")).unwrap();
            let post = serde_json::json!({ "data": { "id": "123", "author": { "avatar": url } } });
            std::fs::write(root.join("people/secure/x/post-123.json"), post.to_string()).unwrap();
            let core = crate::test_support::core();
            {
                let mut inner = core.graph.0.lock().unwrap();
                inner.generation = 1;
                inner.root = Some(root.clone());
                inner.set_local_only(if configured {
                    reflect_graph_paths::LocalOnlyFolders::new(["secure"], None)
                } else {
                    None
                });
            }
            let request = parse_x_media_path(&format!("1/x-media/123/{hash}")).unwrap();
            core.runtime.block_on(async {
                let _slots = super::super::x_download::hold_every_slot().await;
                let wait = if configured { 10_000 } else { 300 };
                let served =
                    tokio::time::timeout(Duration::from_millis(wait), core.x_media_file(request))
                        .await;
                if configured {
                    let refused = served.expect("refused before any fetch");
                    assert_eq!(refused.err(), Some(STATUS_BAD_GATEWAY));
                } else {
                    assert!(served.is_err(), "past the guard, waiting for a slot");
                }
            });
            let files = std::fs::read_dir(root.join("people/secure/x")).unwrap();
            assert_eq!(files.count(), 1, "only the post");
        }
    }
}
