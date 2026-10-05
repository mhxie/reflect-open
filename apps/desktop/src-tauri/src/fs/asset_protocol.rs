//! The `reflect-asset://` custom protocol: serves graph `assets/` files to
//! the webview **off the UI thread**.
//!
//! WebKit delivers custom-scheme requests on the main thread and wry invokes
//! the handler inline, so Tauri's built-in synchronous `asset:` protocol
//! froze the app for the duration of every uncached image read. On iOS that
//! was seconds: a first read can also wait for iCloud to materialize a
//! dataless file. This handler does the blocking file IO on the async
//! runtime's blocking pool and responds when the bytes are ready, so a slow
//! read costs the image a pop-in, never the app a freeze.
//!
//! URL shape: `reflect-asset://localhost/<generation>/<graph-relative path>`,
//! built by `convertFileSrc(…, 'reflect-asset')` in the frontend (which
//! percent-encodes the whole path into one segment). The generation pins the
//! request to the graph session that issued it, exactly like mutating
//! commands — a request racing a graph switch is refused, never resolved
//! against the new graph. The path must be a supported attachment and passes
//! the shared symlink-aware read guard before any IO (which grants the one
//! local-only hop, `resolve::resolve_read`).
//! Passive previews append `?reflect-preview=raster`; those responses are
//! served only when byte sniffing identifies PNG, JPEG, GIF, or WebP content,
//! so an SVG renamed with a raster extension cannot load subresources there.
//! A card's fallback after a failed thumbnail adds `&budget=thumb`, which
//! also refuses (`413`) an image past the thumbnail size or decode budget,
//! so the webview never decodes in full what the shell would not.
//!
//! `?reflect-preview=pdf-page&page=N&width=W` passes the same checks and
//! answers with a page PNG rendered by `pdf_render`; the PDF's own bytes
//! never reach the webview.
//!
//! `?reflect-preview=thumb&width=W` passes the same checks and answers with
//! a downscaled JPEG or PNG that `image_thumbnail` decodes and re-encodes;
//! the image's own bytes never reach the webview either.

use std::borrow::Cow;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;

use reflect_graph_paths::LocalOnlyFolders;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::utils::mime_type::MimeType;
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use super::image_thumbnail::{self, ThumbnailError, ThumbnailLookup, ThumbnailRequest};
use super::pdf_render::{self, PageLookup, PageRequest, PdfError};
use super::resolve::ReadTarget;
use super::GraphState;

/// The scheme name, shared with the `lib.rs` registration. The frontend and
/// the CSP `img-src` grant in `tauri.conf.json` spell it out literally.
pub(crate) const SCHEME: &str = "reflect-asset";
const PREVIEW_RASTER_QUERY: &str = "reflect-preview=raster";
/// Holds a passive raster preview to the thumbnail budget (see the module docs).
const THUMBNAIL_BUDGET_QUERY: &str = "budget=thumb";

/// Protocol entry point (`register_asynchronous_uri_scheme_protocol`). Runs
/// on the webview's calling thread — on WebKit, the app's main thread — so it
/// only moves the request onto the blocking pool; all IO happens there.
pub(crate) fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    // Skip the leading `/`; the remainder is one percent-encoded segment.
    let request_path = percent_encoding::percent_decode(&request.uri().path().as_bytes()[1..])
        .decode_utf8_lossy()
        .into_owned();
    if request_path.split('/').nth(1) == Some("x-media") {
        super::x_media_protocol::handle(app, request, request_path, responder);
        return;
    }
    let method_allowed = request.method() == tauri::http::Method::GET;
    if let Some(page) = PageRequest::from_query(request.uri().query()) {
        tauri::async_runtime::spawn(async move {
            let response = match page {
                _ if !method_allowed => status_response(StatusCode::METHOD_NOT_ALLOWED),
                Err(status) => status_response(status),
                Ok(page) => pdf_page_response(app, request_path, page).await,
            };
            responder.respond(response);
        });
        return;
    }
    if let Some(thumbnail) = ThumbnailRequest::from_query(request.uri().query()) {
        tauri::async_runtime::spawn(async move {
            let response = match thumbnail {
                _ if !method_allowed => status_response(StatusCode::METHOD_NOT_ALLOWED),
                Err(status) => status_response(status),
                Ok(thumbnail) => thumbnail_response(app, request_path, thumbnail).await,
            };
            responder.respond(response);
        });
        return;
    }
    let preview_raster_only = requests_preview_raster(request.uri().query());
    let thumbnail_budget =
        preview_raster_only && has_query_parameter(request.uri().query(), THUMBNAIL_BUDGET_QUERY);
    tauri::async_runtime::spawn_blocking(move || {
        if !method_allowed {
            responder.respond(status_response(StatusCode::METHOD_NOT_ALLOWED));
            return;
        }
        responder.respond(response_for(
            &app,
            &request_path,
            preview_raster_only,
            thumbnail_budget,
        ));
    });
}

fn response_for<R: Runtime>(
    app: &AppHandle<R>,
    request_path: &str,
    preview_raster_only: bool,
    thumbnail_budget: bool,
) -> Response<Cow<'static, [u8]>> {
    let served = if thumbnail_budget {
        serve_within_thumbnail_budget(app, request_path)
    } else {
        serve(app, request_path)
    };
    match served {
        Ok((mime, bytes)) => {
            if preview_raster_only && !is_preview_safe_raster_mime(&mime) {
                return status_response(StatusCode::UNSUPPORTED_MEDIA_TYPE);
            }
            Response::builder()
                .header(header::CONTENT_TYPE, mime)
                .header(header::CONTENT_LENGTH, bytes.len())
                .body(Cow::Owned(bytes))
                .unwrap_or_else(|_| status_response(StatusCode::INTERNAL_SERVER_ERROR))
        }
        Err(status) => {
            tracing::warn!(path = request_path, %status, "asset protocol refused a request");
            status_response(status)
        }
    }
}

fn requests_preview_raster(query: Option<&str>) -> bool {
    has_query_parameter(query, PREVIEW_RASTER_QUERY)
}

fn has_query_parameter(query: Option<&str>, expected: &str) -> bool {
    query.is_some_and(|query| query.split('&').any(|parameter| parameter == expected))
}

fn is_preview_safe_raster_mime(mime: &str) -> bool {
    matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    )
}

fn status_response(status: StatusCode) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .body(Cow::Borrowed(&[][..]))
        .expect("a status-only response always builds")
}

/// A request resolved against the graph session it was issued for.
struct Located {
    root: PathBuf,
    local_only: Option<Arc<LocalOnlyFolders>>,
    /// The graph-relative path as requested.
    rel: String,
    target: ReadTarget,
}

/// The shared front half of every request: the generation pin, then the
/// symlink-aware read guard (which grants the one local-only hop). File IO,
/// so it runs on the blocking pool.
fn locate<R: Runtime>(app: &AppHandle<R>, request_path: &str) -> Result<Located, StatusCode> {
    let (generation, rel) = parse_request_path(request_path)?;
    let state = app.state::<GraphState>();
    let (root, local_only) =
        super::graph_for(&state, Some(generation)).map_err(|_| StatusCode::FORBIDDEN)?;
    let target = super::resolve::resolve_read(&root, rel, local_only.as_deref())
        .map_err(|_| StatusCode::FORBIDDEN)?;
    Ok(Located {
        root,
        local_only,
        rel: rel.to_owned(),
        target,
    })
}

fn io_status(err: &std::io::Error) -> StatusCode {
    match err.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
        std::io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// [`serve`], refusing (`413`) a file past the thumbnail size budget before
/// reading it, and an image whose header is past the decode budget after.
fn serve_within_thumbnail_budget<R: Runtime>(
    app: &AppHandle<R>,
    request_path: &str,
) -> Result<(String, Vec<u8>), StatusCode> {
    let located = locate(app, request_path)?;
    let file = located.target.open().map_err(|err| io_status(&err))?;
    let len = file.metadata().map_err(|err| io_status(&err))?.len();
    if len > image_thumbnail::MAX_IMAGE_BYTES {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let mut bytes = Vec::with_capacity(len as usize);
    file.take(image_thumbnail::MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|err| io_status(&err))?;
    if !image_thumbnail::passive_fallback_allowed(&bytes) {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let mime = MimeType::parse(&bytes, &located.rel);
    Ok((mime, bytes))
}

fn serve<R: Runtime>(
    app: &AppHandle<R>,
    request_path: &str,
) -> Result<(String, Vec<u8>), StatusCode> {
    let located = locate(app, request_path)?;
    // On an iCloud graph this read blocks until the file is materialized on
    // the device — acceptable here on the blocking pool, and exactly the wait
    // that must never happen on the UI thread.
    let mut bytes = Vec::new();
    located
        .target
        .open()
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .map_err(|err| io_status(&err))?;
    let mime = MimeType::parse(&bytes, &located.rel);
    Ok((mime, bytes))
}

async fn pdf_page_response<R: Runtime>(
    app: AppHandle<R>,
    request_path: String,
    page: PageRequest,
) -> Response<Cow<'static, [u8]>> {
    match serve_pdf_page(app, request_path.clone(), page).await {
        // Set explicitly: sniffing would go by the `.pdf` path.
        Ok(png) => Response::builder()
            .header(header::CONTENT_TYPE, "image/png")
            .header(header::CONTENT_LENGTH, png.len())
            .body(Cow::Owned(png))
            .unwrap_or_else(|_| status_response(StatusCode::INTERNAL_SERVER_ERROR)),
        Err(status) => {
            tracing::warn!(path = request_path, %status, "asset protocol refused a PDF page");
            status_response(status)
        }
    }
}

/// One rendered PDF page as PNG bytes. The cheap half (resolve, stat, cache
/// lookup) runs straight away on the blocking pool; a render waits for one
/// of `pdf_render`'s render slots, so a note full of PDFs cannot saturate
/// the CPU while cached pages keep loading.
async fn serve_pdf_page<R: Runtime>(
    app: AppHandle<R>,
    request_path: String,
    page: PageRequest,
) -> Result<Vec<u8>, StatusCode> {
    let lookup = tauri::async_runtime::spawn_blocking(move || {
        let located = locate(&app, &request_path)?;
        pdf_render::lookup_page(
            &located.root,
            located.local_only.as_deref(),
            &located.rel,
            &located.target,
            page,
        )
        .map_err(page_status)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)??;
    match lookup {
        PageLookup::Cached(png) => Ok(png),
        PageLookup::Render(render) => render.run().await.map_err(page_status),
    }
}

/// The status for a failed page, keeping the reason in the debug log (the
/// status alone cannot tell a corrupt PDF from an unreadable page).
fn page_status(err: PdfError) -> StatusCode {
    tracing::debug!(error = ?err, "PDF page failed");
    err.status()
}

async fn thumbnail_response<R: Runtime>(
    app: AppHandle<R>,
    request_path: String,
    request: ThumbnailRequest,
) -> Response<Cow<'static, [u8]>> {
    match serve_thumbnail(app, request_path.clone(), request).await {
        // Set from the encoded bytes: sniffing would go by the source path.
        Ok(thumbnail) => Response::builder()
            .header(header::CONTENT_TYPE, thumbnail.mime)
            .header(header::CONTENT_LENGTH, thumbnail.bytes.len())
            .body(Cow::Owned(thumbnail.bytes))
            .unwrap_or_else(|_| status_response(StatusCode::INTERNAL_SERVER_ERROR)),
        Err(status) => {
            tracing::debug!(path = request_path, %status, "asset protocol refused a thumbnail");
            status_response(status)
        }
    }
}

/// One image thumbnail. The cheap half (resolve, stat, cache lookup) runs
/// straight away on the blocking pool; a render waits for one of
/// `image_thumbnail`'s render slots, so a screen of new images cannot
/// saturate the CPU while cached thumbnails keep loading.
async fn serve_thumbnail<R: Runtime>(
    app: AppHandle<R>,
    request_path: String,
    request: ThumbnailRequest,
) -> Result<image_thumbnail::Thumbnail, StatusCode> {
    let lookup = tauri::async_runtime::spawn_blocking(move || {
        let located = locate(&app, &request_path)?;
        image_thumbnail::lookup_thumbnail(
            &located.root,
            located.local_only.as_deref(),
            &located.rel,
            located.target,
            request,
        )
        .map_err(thumbnail_status)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)??;
    match lookup {
        ThumbnailLookup::Cached(thumbnail) => Ok(thumbnail),
        ThumbnailLookup::Render(render) => render.run().await.map_err(thumbnail_status),
    }
}

/// The status for a failed thumbnail, keeping the reason in the debug log.
fn thumbnail_status(err: ThumbnailError) -> StatusCode {
    tracing::debug!(error = %err, "thumbnail failed");
    err.status()
}

/// Split `<generation>/<graph-relative path>` and vet the path shape. Any
/// supported attachment anywhere in the vault qualifies, mirroring
/// `asset_open`: an adopted vault keeps its images beside its notes. Notes,
/// hidden components, and traversal shapes stay forbidden.
fn parse_request_path(request_path: &str) -> Result<(u64, &str), StatusCode> {
    let (generation, rel) = request_path
        .split_once('/')
        .ok_or(StatusCode::BAD_REQUEST)?;
    let generation: u64 = generation.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    super::ensure_readable_attachment_path(rel).map_err(|_| StatusCode::FORBIDDEN)?;
    Ok((generation, rel))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_generation_pinned_asset_path() {
        assert_eq!(
            parse_request_path("3/assets/cat.png").unwrap(),
            (3, "assets/cat.png"),
        );
        assert_eq!(
            parse_request_path("12/assets/sub dir/photo 1.jpeg").unwrap(),
            (12, "assets/sub dir/photo 1.jpeg"),
        );
        assert_eq!(
            parse_request_path("3/Projects/Media/cat.png").unwrap(),
            (3, "Projects/Media/cat.png"),
        );
    }

    #[test]
    fn rejects_malformed_requests() {
        assert_eq!(
            parse_request_path("assets/cat.png").unwrap_err(),
            StatusCode::BAD_REQUEST,
        );
        assert_eq!(
            parse_request_path("3").unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            parse_request_path("nope/assets/cat.png").unwrap_err(),
            StatusCode::BAD_REQUEST,
        );
    }

    #[test]
    fn rejects_notes_hidden_and_traversal_paths() {
        assert_eq!(
            parse_request_path("3/notes/secret.md").unwrap_err(),
            StatusCode::FORBIDDEN,
        );
        assert_eq!(
            parse_request_path("3/.obsidian/cat.png").unwrap_err(),
            StatusCode::FORBIDDEN,
        );
        assert_eq!(
            parse_request_path("3/../cat.png").unwrap_err(),
            StatusCode::FORBIDDEN,
        );
        assert_eq!(
            parse_request_path("3/assets").unwrap_err(),
            StatusCode::FORBIDDEN,
        );
        assert_eq!(
            parse_request_path("3/assets/").unwrap_err(),
            StatusCode::FORBIDDEN,
        );
    }

    /// Command tier: `serve` takes the folders from `GraphState`, follows an
    /// allowed link one hop for display, and refuses a symlink inside the
    /// raw store; the control session without folders refuses the link.
    #[cfg(unix)]
    #[test]
    fn serves_a_local_only_attachment_through_its_link_and_nothing_past_it() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let (root, raw, elsewhere) = (base.join("graph"), base.join("raw"), base.join("elsewhere"));
        std::fs::create_dir_all(root.join("finance")).unwrap();
        std::fs::create_dir_all(raw.join("finance/secure")).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(raw.join("finance/secure/scan.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        std::fs::write(elsewhere.join("leak.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        symlink(raw.join("finance/secure"), root.join("finance/secure")).unwrap();
        symlink(&elsewhere, raw.join("finance/secure/alias")).unwrap();

        for configured in [true, false] {
            let app = tauri::test::mock_builder()
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .expect("mock app");
            app.manage(GraphState::default());
            {
                let state = app.state::<GraphState>();
                let mut inner = state.0.lock().unwrap();
                inner.generation = 4;
                inner.root = Some(root.clone());
                inner.set_local_only(configured.then(|| {
                    reflect_graph_paths::LocalOnlyFolders::new(["secure"], Some(&raw)).unwrap()
                }));
            }
            let served = serve(app.handle(), "4/finance/secure/scan.png");
            if configured {
                let (mime, bytes) = served.expect("served through the link");
                assert_eq!(mime, "image/png");
                assert_eq!(bytes, b"\x89PNG\r\n\x1a\n");
                assert_eq!(
                    serve(app.handle(), "4/finance/secure/alias/leak.png").unwrap_err(),
                    StatusCode::FORBIDDEN
                );
            } else {
                assert_eq!(served.unwrap_err(), StatusCode::FORBIDDEN);
            }
            // A stale generation is refused either way.
            assert_eq!(
                serve(app.handle(), "3/finance/secure/scan.png").unwrap_err(),
                StatusCode::FORBIDDEN
            );
        }
    }

    /// Command tier: a PDF page comes back as a PNG with its own content
    /// type, lands in the page cache, and a repeat is served from there;
    /// a local-only PDF renders through its link; failures map to statuses.
    #[cfg(target_os = "macos")]
    #[test]
    fn serves_rendered_pdf_pages_as_png_and_repeats_from_the_pdf_page_cache() {
        use super::super::pdf_render::fixtures::{decode, request, sample};
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let (root, raw) = (base.join("graph"), base.join("raw"));
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::create_dir_all(root.join("finance")).unwrap();
        std::fs::create_dir_all(raw.join("finance/secure")).unwrap();
        std::fs::write(root.join("assets/paper.pdf"), sample()).unwrap();
        std::fs::write(root.join("assets/fake.pdf"), b"\x89PNG\r\n\x1a\n").unwrap();
        std::fs::write(raw.join("finance/secure/scan.pdf"), sample()).unwrap();
        symlink(raw.join("finance/secure"), root.join("finance/secure")).unwrap();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        app.manage(GraphState::default());
        {
            let state = app.state::<GraphState>();
            let mut inner = state.0.lock().unwrap();
            inner.generation = 4;
            inner.root = Some(root.clone());
            inner.set_local_only(Some(LocalOnlyFolders::new(["secure"], Some(&raw)).unwrap()));
        }
        let serve_page = |path: &str, page| {
            tauri::async_runtime::block_on(serve_pdf_page(
                app.handle().clone(),
                path.to_owned(),
                page,
            ))
        };
        let cached_pages = || -> Vec<std::path::PathBuf> {
            let cache = root.join(".reflect/cache/pdf-pages");
            let Ok(documents) = std::fs::read_dir(cache) else {
                return Vec::new();
            };
            documents
                .flatten()
                .flat_map(|document| std::fs::read_dir(document.path()).unwrap().flatten())
                .map(|entry| entry.path())
                .collect()
        };

        let response = tauri::async_runtime::block_on(pdf_page_response(
            app.handle().clone(),
            "4/assets/paper.pdf".into(),
            request(1, 300),
        ));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        let png = response.body().to_vec();
        assert_eq!(decode(&png).dimensions(), (480, 240));
        let cached = cached_pages();
        assert_eq!(cached.len(), 1);
        assert!(cached[0].ends_with("1-480.png"));
        assert_eq!(std::fs::read(&cached[0]).unwrap(), png);

        // A repeat (any width in the same bucket) is the cached entry.
        let marker = b"\x89PNG\r\n\x1a\nmarker".to_vec();
        std::fs::write(&cached[0], &marker).unwrap();
        assert_eq!(
            serve_page("4/assets/paper.pdf", request(1, 480)).unwrap(),
            marker
        );

        let local = serve_page("4/finance/secure/scan.pdf", request(2, 960)).unwrap();
        assert_eq!(decode(&local).dimensions(), (960, 1920));
        assert_eq!(cached_pages().len(), 2);

        for (path, page, status) in [
            ("4/assets/paper.pdf", request(4, 480), StatusCode::NOT_FOUND),
            (
                "4/assets/missing.pdf",
                request(1, 480),
                StatusCode::NOT_FOUND,
            ),
            (
                "4/assets/fake.pdf",
                request(1, 480),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ),
            ("3/assets/paper.pdf", request(1, 480), StatusCode::FORBIDDEN),
            ("4/notes/paper.md", request(1, 480), StatusCode::FORBIDDEN),
        ] {
            assert_eq!(serve_page(path, page).unwrap_err(), status, "{path}");
        }
    }

    /// Command tier: an image thumbnail comes back re-encoded under its own
    /// content type, a repeat is served from the cache, and the generation
    /// pin, path guard, and decoder refusals map to statuses.
    #[test]
    fn serves_cached_image_thumbnails_under_the_asset_rules() {
        use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("assets")).unwrap();
        let mut png = Vec::new();
        DynamicImage::ImageRgb8(RgbImage::from_pixel(1200, 600, Rgb([9, 9, 9])))
            .write_to(&mut std::io::Cursor::new(&mut png), ImageFormat::Png)
            .unwrap();
        std::fs::write(root.join("assets/photo.png"), png).unwrap();
        std::fs::write(root.join("assets/drawing.png"), b"<svg/>").unwrap();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        app.manage(GraphState::default());
        {
            let state = app.state::<GraphState>();
            let mut inner = state.0.lock().unwrap();
            inner.generation = 4;
            inner.root = Some(root.clone());
        }
        let thumb = |width: u32| {
            ThumbnailRequest::from_query(Some(&format!("reflect-preview=thumb&width={width}")))
                .unwrap()
                .unwrap()
        };
        let serve_thumb = |path: &str, width| {
            tauri::async_runtime::block_on(serve_thumbnail(
                app.handle().clone(),
                path.to_owned(),
                thumb(width),
            ))
        };

        let response = tauri::async_runtime::block_on(thumbnail_response(
            app.handle().clone(),
            "4/assets/photo.png".into(),
            thumb(600),
        ));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/jpeg");
        let decoded = image::load_from_memory(response.body()).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (640, 320));

        let cache = root.join(".reflect/cache/thumbnails");
        let cached: Vec<_> = std::fs::read_dir(&cache)
            .unwrap()
            .flatten()
            .flat_map(|key| std::fs::read_dir(key.path()).unwrap().flatten())
            .map(|entry| entry.path())
            .collect();
        assert_eq!(cached.len(), 1);
        assert!(cached[0].ends_with("640.thumb"));
        // A repeat in the same bucket is the cached entry.
        let marker = b"\xff\xd8\xffmarker".to_vec();
        std::fs::write(&cached[0], &marker).unwrap();
        assert_eq!(
            serve_thumb("4/assets/photo.png", 500).unwrap().bytes,
            marker
        );

        for (path, status) in [
            ("4/assets/drawing.png", StatusCode::UNSUPPORTED_MEDIA_TYPE),
            ("4/assets/missing.png", StatusCode::NOT_FOUND),
            ("3/assets/photo.png", StatusCode::FORBIDDEN),
            ("4/notes/photo.md", StatusCode::FORBIDDEN),
        ] {
            assert_eq!(serve_thumb(path, 320).unwrap_err(), status, "{path}");
        }

        // A card's raster fallback is held to the thumbnail budget: an image
        // whose header declares a canvas past it is refused, never read out
        // for the webview to decode in full; a plain raster read still is.
        let mut huge = b"GIF89a".to_vec();
        huge.extend(16_000u16.to_le_bytes());
        huge.extend(16_000u16.to_le_bytes());
        huge.extend([0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x2c, 0, 0, 0, 0]);
        huge.extend(16_000u16.to_le_bytes());
        huge.extend(16_000u16.to_le_bytes());
        huge.extend([0, 2, 0, 0x3b]);
        std::fs::write(root.join("assets/huge.gif"), huge).unwrap();
        assert_eq!(
            serve_within_thumbnail_budget(app.handle(), "4/assets/huge.gif").unwrap_err(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        assert!(serve(app.handle(), "4/assets/huge.gif").is_ok());
        let (mime, _) = serve_within_thumbnail_budget(app.handle(), "4/assets/photo.png").unwrap();
        assert_eq!(mime, "image/png");
        assert!(has_query_parameter(
            Some("reflect-preview=raster&budget=thumb&v=1-2"),
            THUMBNAIL_BUDGET_QUERY
        ));
    }

    #[test]
    fn recognizes_only_the_explicit_preview_raster_query() {
        assert!(requests_preview_raster(Some("reflect-preview=raster")));
        assert!(requests_preview_raster(Some(
            "cache=1&reflect-preview=raster"
        )));
        assert!(!requests_preview_raster(None));
        assert!(!requests_preview_raster(Some("reflect-preview=svg")));
    }

    #[test]
    fn preview_raster_filter_uses_sniffed_content_not_the_filename() {
        let disguised_svg = br#"<svg xmlns="http://www.w3.org/2000/svg"></svg>"#;
        let svg_mime = MimeType::parse(disguised_svg, "assets/disguised.png");
        assert_ne!(svg_mime, "image/png");
        assert!(!is_preview_safe_raster_mime(&svg_mime));

        let png_signature = b"\x89PNG\r\n\x1a\n";
        let png_mime = MimeType::parse(png_signature, "assets/image.bin");
        assert_eq!(png_mime, "image/png");
        assert!(is_preview_safe_raster_mime(&png_mime));
    }
}
