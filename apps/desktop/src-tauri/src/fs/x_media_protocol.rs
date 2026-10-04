use super::x_archive_store as archive;
use super::GraphState;
use std::borrow::Cow;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeResponder};

fn error(status: StatusCode) -> Response<Cow<'static, [u8]>> {
    let builder = Response::builder()
        .status(status)
        .header("Cache-Control", "no-store");
    builder
        .body(Cow::Borrowed(&[] as &[u8]))
        .expect("valid response")
}
fn range(header: Option<&str>, length: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(header) = header else {
        return Ok(None);
    };
    let ranges = http_range_header::parse_range_header(header)
        .and_then(|parsed| parsed.validate(length))
        .map_err(|_| ())?;
    if ranges.len() != 1 {
        return Ok(None);
    }
    Ok(Some((*ranges[0].start(), *ranges[0].end())))
}
pub fn handle<R: Runtime>(
    app: AppHandle<R>,
    request: Request<Vec<u8>>,
    path: String,
    responder: UriSchemeResponder,
) {
    tauri::async_runtime::spawn(async move {
        let response = serve(app, request, path).await;
        responder.respond(response);
    });
}
async fn serve<R: Runtime>(
    app: AppHandle<R>,
    request: Request<Vec<u8>>,
    path: String,
) -> Response<Cow<'static, [u8]>> {
    let segments: Vec<_> = path.split('/').collect();
    if segments.len() != 4 || segments[1] != "x-media" {
        return error(StatusCode::BAD_REQUEST);
    }
    let Ok(generation) = segments[0].parse::<u64>() else {
        return error(StatusCode::BAD_REQUEST);
    };
    let post = segments[2].to_string();
    let hash = segments[3].to_string();
    if !archive::valid_id(&post) || !archive::valid_hash(&hash) {
        return error(StatusCode::BAD_REQUEST);
    }
    if request.method() != "GET" {
        return error(StatusCode::METHOD_NOT_ALLOWED);
    }
    let Ok((root, local_only)) = super::graph_for(&app.state::<GraphState>(), Some(generation))
    else {
        return error(StatusCode::FORBIDDEN);
    };
    let lookup_root = root.clone();
    let source = tauri::async_runtime::spawn_blocking(move || {
        archive::resource_url(&lookup_root, &post, &hash)
    })
    .await;
    let Ok(Ok(source)) = source else {
        return error(StatusCode::NOT_FOUND);
    };
    // Keep this request pending until the shared download publishes a complete file.
    let Ok(receipt) = super::x_download::download(root.clone(), local_only, source).await else {
        return error(StatusCode::BAD_GATEWAY);
    };
    let selected = match range(
        request
            .headers()
            .get("Range")
            .and_then(|value| value.to_str().ok()),
        receipt.bytes,
    ) {
        Ok(range) => range,
        Err(()) => {
            return Response::builder()
                .status(416)
                .header("Content-Range", format!("bytes */{}", receipt.bytes))
                .header("Cache-Control", "no-store")
                .body(Cow::Borrowed(&[] as &[u8]))
                .expect("valid response")
        }
    };
    let (start, end) = selected.unwrap_or((0, receipt.bytes - 1));
    let count = end - start + 1;
    let name = receipt.name.clone();
    let body = tauri::async_runtime::spawn_blocking(move || -> crate::error::AppResult<Vec<u8>> {
        let path = super::resolve::resolve(&root, &format!("assets/x/{name}"))?;
        let mut file = File::open(path)?;
        if file.metadata()?.len() != receipt.bytes {
            return Err(crate::error::AppError::io("file-changed"));
        }
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = vec![0; count as usize];
        file.read_exact(&mut bytes)?;
        Ok(bytes)
    })
    .await
    .unwrap_or_else(|error| Err(crate::error::AppError::io(error.to_string())));
    let Ok(bytes) = body else {
        return error(StatusCode::INTERNAL_SERVER_ERROR);
    };
    let mut builder = Response::builder()
        .status(if selected.is_some() { 206 } else { 200 })
        .header("Content-Type", receipt.mime)
        .header("Content-Length", count)
        .header("Accept-Ranges", "bytes")
        .header("Cache-Control", "no-store");
    if selected.is_some() {
        builder = builder.header(
            "Content-Range",
            format!("bytes {start}-{end}/{}", receipt.bytes),
        );
    }
    builder.body(Cow::Owned(bytes)).expect("valid response")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn supports_video_ranges_and_rejects_unsatisfiable_ranges() {
        assert_eq!(range(Some("bytes=2-4"), 10), Ok(Some((2, 4))));
        assert_eq!(range(Some("bytes=-3"), 10), Ok(Some((7, 9))));
        assert_eq!(range(Some("bytes=7-"), 10), Ok(Some((7, 9))));
        assert!(range(Some("bytes=10-"), 10).is_err());
    }

    /// Command tier: the protocol hands the open graph's folders to the
    /// download, so with `assets/` linked into a real local-only folder an
    /// uncached resource is refused before any fetch. Every download slot is
    /// held, so nothing can fetch: the control session without folders gets
    /// past the guard and waits for a slot.
    #[cfg(unix)]
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
            let app = tauri::test::mock_builder()
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .expect("mock app");
            app.manage(GraphState::default());
            {
                let state = app.state::<GraphState>();
                let mut inner = state.0.lock().unwrap();
                inner.generation = 1;
                inner.root = Some(root.clone());
                inner.set_local_only(if configured {
                    reflect_graph_paths::LocalOnlyFolders::new(["secure"], None)
                } else {
                    None
                });
            }
            let request = Request::builder()
                .method("GET")
                .uri(format!("reflect-x-media://localhost/1/x-media/123/{hash}"))
                .body(Vec::new())
                .unwrap();
            let path = format!("1/x-media/123/{hash}");
            tauri::async_runtime::block_on(async {
                let _slots = super::super::x_download::hold_every_slot().await;
                let wait = if configured { 10_000 } else { 300 };
                let served = tokio::time::timeout(
                    Duration::from_millis(wait),
                    serve(app.handle().clone(), request, path),
                )
                .await;
                if configured {
                    let response = served.expect("refused before any fetch");
                    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
                } else {
                    assert!(served.is_err(), "past the guard, waiting for a slot");
                }
            });
            let files = std::fs::read_dir(root.join("people/secure/x")).unwrap();
            assert_eq!(files.count(), 1, "only the post");
        }
    }
}
