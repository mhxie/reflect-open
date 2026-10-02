//! PDF page sizes (`pdf_info`) and page PNGs for the `reflect-asset://`
//! protocol: CoreGraphics on macOS, `unsupported` elsewhere. The PDF is parsed
//! from bytes read through `ReadTarget::open`, never re-opened by path. PNGs
//! cache under `.reflect/cache/pdf-pages/<key>/<page>-<width>.png`, the key
//! hashing path, size, and mtime; [`sweep_page_cache`] bounds the cache.

use std::fs::{self, File, Metadata};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};

use reflect_graph_paths::LocalOnlyFolders;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::http::StatusCode;
use tauri::State;
use tokio::sync::Semaphore;

use super::resolve::{resolve_read, resolve_write, ReadTarget};
use super::GraphState;
use crate::error::{AppError, AppResult};

#[cfg(target_os = "macos")]
mod core_graphics;
#[cfg(target_os = "macos")]
use self::core_graphics as engine;

/// The query parameter that routes a `reflect-asset://` request here.
const PAGE_QUERY: &str = "reflect-preview=pdf-page";

/// Rendered widths in pixels. A requested width rounds up to the next bucket
/// (the last one caps it), so dragging an embed's resize handle swaps
/// between a few renders instead of re-rendering continuously.
const WIDTH_BUCKETS: [u32; 5] = [480, 960, 1440, 1920, 2560];

/// The largest PDF previewed: 200 MiB. CoreGraphics parses from an
/// in-memory copy, so this bounds what one read holds (two run at once at
/// most). Larger files answer `unsupported` and still open in the
/// default app.
const MAX_PDF_BYTES: u64 = 200 * 1024 * 1024;

/// The bitmap budget: 16 Mi pixels (64 MiB at 4 bytes per pixel). A page
/// with an extreme aspect ratio renders narrower than its bucket rather than
/// allocating gigabytes.
const MAX_RASTER_PIXELS: f64 = 16_777_216.0;

/// PDF reads (page sizes or a page render) running at once, across every
/// window and graph.
const MAX_CONCURRENT_RENDERS: usize = 2;

static RENDER_SLOTS: Semaphore = Semaphore::const_new(MAX_CONCURRENT_RENDERS);

/// The page cache, graph-relative.
const CACHE_DIR: &str = ".reflect/cache/pdf-pages";

/// Hashed into every cache key; bump it when rendering output changes so
/// earlier PNGs stop matching.
const CACHE_FORMAT: &str = "pdf-pages/v1";

/// The page cache's total size after the sweep at graph open: 512 MiB.
/// Between opens it may grow past this; only the sweep evicts.
const CACHE_CAP_BYTES: u64 = 512 * 1024 * 1024;

/// One page's size in PDF points (1/72 inch), as displayed: the crop box
/// with the page's `/Rotate` applied.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSize {
    pub width: f64,
    pub height: f64,
}

/// `pdf_info`'s reply: every page's displayed size, in page order.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfInfo {
    pub pages: Vec<PageSize>,
}

/// A page's crop box as the PDF stores it, before `/Rotate`. Only the
/// macOS engine reads one from a document.
#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct PageBox {
    width: f64,
    height: f64,
    /// `/Rotate` in degrees: a multiple of 90, possibly negative or past 360.
    rotation: i32,
}

impl PageBox {
    /// The size the page displays at: a quarter turn swaps the axes.
    fn displayed(self) -> Result<PageSize, PdfError> {
        let usable = |side: f64| side.is_finite() && side > 0.0;
        if !usable(self.width) || !usable(self.height) {
            return Err(PdfError::Invalid("a page has an empty crop box".into()));
        }
        let quarter_turned = matches!(self.rotation.rem_euclid(360), 90 | 270);
        Ok(if quarter_turned {
            PageSize {
                width: self.height,
                height: self.width,
            }
        } else {
            PageSize {
                width: self.width,
                height: self.height,
            }
        })
    }
}

/// Why a page size or render failed.
#[derive(Debug)]
pub(crate) enum PdfError {
    /// This platform has no PDF engine (everything but macOS).
    Unsupported,
    /// The file is over [`MAX_PDF_BYTES`].
    TooLarge(u64),
    /// Encrypted, and the empty password does not open it.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Locked,
    /// Not a PDF the engine can read, no pages, or a degenerate page box.
    Invalid(String),
    /// The requested page is past the last one.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    PageOutOfRange { page: usize, count: usize },
    /// Reading the file failed.
    Io(std::io::Error),
}

impl From<std::io::Error> for PdfError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err)
    }
}

impl From<PdfError> for AppError {
    fn from(err: PdfError) -> Self {
        match err {
            PdfError::Unsupported => {
                AppError::unsupported("PDF previews are only available on macOS")
            }
            PdfError::TooLarge(size) => AppError::unsupported(format!(
                "PDF previews are limited to {} MB; this file is {} MB",
                MAX_PDF_BYTES >> 20,
                size.div_ceil(1 << 20),
            )),
            PdfError::Locked => AppError::locked("the PDF is password-protected"),
            PdfError::Invalid(message) => AppError::invalid(message),
            PdfError::PageOutOfRange { page, count } => {
                AppError::not_found(format!("page {page} is past the last page ({count})"))
            }
            PdfError::Io(err) => err.into(),
        }
    }
}

impl PdfError {
    /// The protocol status for this failure.
    pub(crate) fn status(&self) -> StatusCode {
        match self {
            Self::Unsupported => StatusCode::NOT_IMPLEMENTED,
            Self::TooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            Self::Locked => StatusCode::LOCKED,
            Self::Invalid(_) => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::PageOutOfRange { .. } => StatusCode::NOT_FOUND,
            Self::Io(err) => match err.kind() {
                std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
                std::io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            },
        }
    }
}

/// The stand-in engine for targets without CoreGraphics: callers refuse
/// before any IO, so these are never reached at runtime.
#[cfg(not(target_os = "macos"))]
mod engine {
    use super::{PageBox, PageRequest, PdfError};

    pub(super) const SUPPORTED: bool = false;

    pub(super) fn page_boxes(_bytes: &[u8]) -> Result<Vec<PageBox>, PdfError> {
        Err(PdfError::Unsupported)
    }

    pub(super) fn render_png(_bytes: &[u8], _request: PageRequest) -> Result<Vec<u8>, PdfError> {
        Err(PdfError::Unsupported)
    }
}

/// The bucket a requested width renders at: the smallest bucket at least as
/// wide, or the largest.
fn width_bucket(requested: u32) -> u32 {
    WIDTH_BUCKETS
        .into_iter()
        .find(|bucket| *bucket >= requested)
        .unwrap_or(WIDTH_BUCKETS[WIDTH_BUCKETS.len() - 1])
}

/// The bitmap size for `page` rendered `bucket` pixels wide, scaled down
/// uniformly when it would exceed [`MAX_RASTER_PIXELS`]. Sides round to the
/// nearest pixel, or down when the budget binds so it holds; never zero.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn raster_size(page: PageSize, bucket: u32) -> (usize, usize) {
    let fit = f64::from(bucket) / page.width;
    let budget = (MAX_RASTER_PIXELS / (page.width * page.height)).sqrt();
    let (scale, snap): (f64, fn(f64) -> f64) = if fit <= budget {
        (fit, f64::round)
    } else {
        (budget, f64::floor)
    };
    let side = |points: f64| (snap(points * scale) as usize).max(1);
    (side(page.width), side(page.height))
}

/// A page render request, from the protocol query
/// `reflect-preview=pdf-page&page=N&width=W`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PageRequest {
    /// 1-based page number.
    page: usize,
    /// The width bucket to render at, in pixels.
    bucket: u32,
}

impl PageRequest {
    /// `None` when the query does not ask for a PDF page (an ordinary asset
    /// read); `Some(Err)` when it does but `page` or `width` is missing,
    /// zero, or malformed. The first occurrence of each parameter wins.
    pub(crate) fn from_query(query: Option<&str>) -> Option<Result<Self, StatusCode>> {
        let parameters: Vec<&str> = query?.split('&').collect();
        if !parameters.contains(&PAGE_QUERY) {
            return None;
        }
        let value = |name: &str| {
            parameters
                .iter()
                .find_map(|parameter| parameter.strip_prefix(name)?.strip_prefix('='))
        };
        let page = value("page").and_then(|page| page.parse::<usize>().ok());
        let width = value("width").and_then(|width| width.parse::<u32>().ok());
        Some(match (page, width) {
            (Some(page), Some(width)) if page > 0 && width > 0 => Ok(Self {
                page,
                bucket: width_bucket(width),
            }),
            _ => Err(StatusCode::BAD_REQUEST),
        })
    }
}

/// Open the PDF a read target names and check it can be previewed: a regular
/// file within [`MAX_PDF_BYTES`].
fn open_pdf(target: &ReadTarget) -> Result<(File, Metadata), PdfError> {
    let file = target.open()?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(PdfError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "not a file",
        )));
    }
    if metadata.len() > MAX_PDF_BYTES {
        return Err(PdfError::TooLarge(metadata.len()));
    }
    Ok((file, metadata))
}

/// Read an opened PDF, refusing one that grew past [`MAX_PDF_BYTES`] since
/// it was checked.
fn read_pdf(file: File, expected_len: u64) -> Result<Vec<u8>, PdfError> {
    read_capped(file, expected_len, MAX_PDF_BYTES)
}

fn read_capped(file: File, expected_len: u64, cap: u64) -> Result<Vec<u8>, PdfError> {
    let mut bytes = Vec::with_capacity(expected_len.min(cap) as usize);
    file.take(cap + 1).read_to_end(&mut bytes)?;
    let len = bytes.len() as u64;
    if len > cap {
        return Err(PdfError::TooLarge(len));
    }
    Ok(bytes)
}

/// Every page's displayed size in points. Path rules match `asset_open`
/// (local-only folders included: nothing leaves the device). Fails with
/// `unsupported` (not macOS, or too large), `locked`, or `invalid`.
#[tauri::command]
pub async fn pdf_info(
    path: String,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<PdfInfo> {
    super::ensure_readable_attachment_path(&path)?;
    let (root, local_only) = super::graph_for(&state, Some(generation))?;
    if !engine::SUPPORTED {
        return Err(PdfError::Unsupported.into());
    }
    let _slot = RENDER_SLOTS
        .acquire()
        .await
        .expect("render semaphore stays open");
    crate::blocking::run_blocking(move || {
        let target = resolve_read(&root, &path, local_only.as_deref())?;
        let (file, metadata) = open_pdf(&target)?;
        let bytes = read_pdf(file, metadata.len())?;
        let pages = engine::page_boxes(&bytes)?
            .into_iter()
            .map(PageBox::displayed)
            .collect::<Result<_, _>>()?;
        Ok(PdfInfo { pages })
    })
    .await
}

/// The cheap half of a page request.
pub(crate) enum PageLookup {
    /// The page was cached.
    Cached(Vec<u8>),
    /// The page must be rendered ([`PageRender::run`]).
    Render(PageRender),
}

/// A page render, holding the PDF opened (and checked) by the lookup.
pub(crate) struct PageRender {
    file: File,
    len: u64,
    request: PageRequest,
    /// Where to cache the PNG; `None` when the cache is unavailable.
    cache: Option<CacheEntry>,
}

struct CacheEntry {
    root: PathBuf,
    path: PathBuf,
}

/// Resolve a page request to its cached PNG or to the render that produces
/// it. Runs on the blocking pool after the protocol's generation check and
/// read guard (`target`); `rel` is the PDF's graph-relative path.
pub(crate) fn lookup_page(
    root: &Path,
    local_only: Option<&LocalOnlyFolders>,
    rel: &str,
    target: &ReadTarget,
    request: PageRequest,
) -> Result<PageLookup, PdfError> {
    if !engine::SUPPORTED {
        return Err(PdfError::Unsupported);
    }
    let (file, metadata) = open_pdf(target)?;
    let cache = super::modified_ms(&metadata).and_then(|modified_ms| {
        let entry = cache_rel_path(rel, metadata.len(), modified_ms, request);
        match resolve_write(root, &entry, local_only) {
            Ok(path) => Some(CacheEntry {
                root: root.to_path_buf(),
                path,
            }),
            Err(err) => {
                tracing::warn!(?err, "PDF page cache unavailable");
                None
            }
        }
    });
    if let Some(png) = cache.as_ref().and_then(|entry| read_cached(&entry.path)) {
        tracing::debug!(
            path = rel,
            page = request.page,
            bucket = request.bucket,
            "PDF page cache hit"
        );
        return Ok(PageLookup::Cached(png));
    }
    tracing::debug!(
        path = rel,
        page = request.page,
        bucket = request.bucket,
        "PDF page cache miss"
    );
    Ok(PageLookup::Render(PageRender {
        file,
        len: metadata.len(),
        request,
        cache,
    }))
}

impl PageRender {
    /// Render once one of the render slots is free, on the blocking pool,
    /// and cache the PNG (best-effort: a failed cache write still answers).
    pub(crate) async fn run(self) -> Result<Vec<u8>, PdfError> {
        let _slot = RENDER_SLOTS
            .acquire()
            .await
            .expect("render semaphore stays open");
        tauri::async_runtime::spawn_blocking(move || self.render())
            .await
            .map_err(|err| PdfError::Io(std::io::Error::other(err.to_string())))?
    }

    fn render(self) -> Result<Vec<u8>, PdfError> {
        let started = Instant::now();
        let bytes = read_pdf(self.file, self.len)?;
        let png = engine::render_png(&bytes, self.request)?;
        tracing::debug!(
            page = self.request.page,
            bucket = self.request.bucket,
            pdf_bytes = self.len,
            png_bytes = png.len(),
            elapsed_ms = started.elapsed().as_millis() as u64,
            "rendered PDF page"
        );
        if let Some(entry) = self.cache {
            if let Err(err) = super::io::atomic_write_bytes(&entry.root, &entry.path, &png) {
                tracing::warn!(?err, path = %entry.path.display(), "failed to cache a PDF page");
            }
        }
        Ok(png)
    }
}

/// The cache key for one version of one PDF: a SHA-256 prefix over the
/// cache format, graph-relative path, size, and mtime.
fn cache_key(rel: &str, size: u64, modified_ms: u64) -> String {
    let digest = Sha256::digest(format!("{CACHE_FORMAT}\0{rel}\0{size}\0{modified_ms}"));
    digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The graph-relative cache path for one rendered page.
fn cache_rel_path(rel: &str, size: u64, modified_ms: u64, request: PageRequest) -> String {
    format!(
        "{CACHE_DIR}/{}/{}-{}.png",
        cache_key(rel, size, modified_ms),
        request.page,
        request.bucket
    )
}

/// A cached PNG, or `None` when there is none (or it is not a PNG). A hit
/// refreshes the entry's mtime: the sweep evicts least-recently-used first,
/// and access times are not dependable on macOS.
fn read_cached(path: &Path) -> Option<Vec<u8>> {
    const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    let mut file = File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    if !bytes.starts_with(PNG_SIGNATURE) {
        return None;
    }
    if let Err(err) = file.set_modified(SystemTime::now()) {
        tracing::debug!(%err, "failed to refresh a cached PDF page");
    }
    Some(bytes)
}

/// Bound the page cache when a graph opens: past [`CACHE_CAP_BYTES`], delete
/// the least-recently-used PNGs until the rest fit. Best-effort — nothing
/// here can fail the open.
pub(super) fn sweep_page_cache(root: &Path) {
    sweep_cache_dir(root, CACHE_CAP_BYTES);
}

fn sweep_cache_dir(root: &Path, cap: u64) {
    // `.reflect/` itself is vetted at open; below it nothing symlinked is
    // followed, so a planted link cannot point the sweep's deletes elsewhere.
    let is_real_dir =
        |path: &Path| fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir());
    let cache = root.join(CACHE_DIR);
    if !is_real_dir(&cache) || !cache.parent().is_some_and(is_real_dir) {
        return;
    }
    let Ok(documents) = fs::read_dir(&cache) else {
        return;
    };
    let mut pages = Vec::new();
    let mut total = 0u64;
    let mut document_dirs = Vec::new();
    for document in documents.flatten() {
        let document = document.path();
        if !is_real_dir(&document) {
            continue;
        }
        if let Ok(entries) = fs::read_dir(&document) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Ok(metadata) = fs::symlink_metadata(&path) else {
                    continue;
                };
                if !metadata.is_file() || path.extension().is_none_or(|ext| ext != "png") {
                    continue;
                }
                total += metadata.len();
                let used = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                pages.push((used, metadata.len(), path));
            }
        }
        document_dirs.push(document);
    }
    if total <= cap {
        return;
    }
    let before = total;
    pages.sort_by_key(|(used, _, _)| *used);
    for (_, len, path) in pages {
        if total <= cap {
            break;
        }
        match fs::remove_file(&path) {
            Ok(()) => total -= len,
            Err(err) => tracing::debug!(%err, path = %path.display(), "failed to evict a PDF page"),
        }
    }
    for document in document_dirs {
        // Only empties go: `remove_dir` refuses a directory with entries.
        let _ = fs::remove_dir(document);
    }
    tracing::debug!(before, after = total, cap, "swept the PDF page cache");
}

/// Hand-assembled PDFs and helpers for the rendering, command, and protocol
/// tests (rendering runs on macOS only).
#[cfg(all(test, target_os = "macos"))]
pub(crate) mod fixtures {
    use super::PageRequest;

    /// A minimal, valid PDF: one page per `(page dictionary entries, content
    /// stream)`, with a computed cross-reference table.
    pub(crate) fn pdf(pages: &[(&str, &str)]) -> Vec<u8> {
        let first_page = 3;
        let kids: Vec<String> = (0..pages.len())
            .map(|index| format!("{} 0 R", first_page + 2 * index))
            .collect();
        let mut objects = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
            format!(
                "<< /Type /Pages /Kids [{}] /Count {} >>",
                kids.join(" "),
                pages.len()
            ),
        ];
        for (index, (entries, content)) in pages.iter().enumerate() {
            let contents = first_page + 2 * index + 1;
            objects.push(format!(
                "<< /Type /Page /Parent 2 0 R {entries} /Contents {contents} 0 R >>"
            ));
            objects.push(format!(
                "<< /Length {} >>\nstream\n{content}\nendstream",
                content.len()
            ));
        }
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", index + 1).as_bytes());
        }
        let xref = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
        out.extend_from_slice(b"0000000000 65535 f \n");
        for offset in offsets {
            out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        out
    }

    /// Page 1: 200×100 pt, all black. Page 2: the same page turned a
    /// quarter clockwise, its left half black. Page 3: a 200×100 pt crop of
    /// a larger page, black inside the crop and red outside it.
    pub(crate) fn sample() -> Vec<u8> {
        pdf(&[
            ("/MediaBox [0 0 200 100]", "0 0 0 rg 0 0 200 100 re f"),
            (
                "/MediaBox [0 0 200 100] /Rotate 90",
                "0 0 0 rg 0 0 100 100 re f",
            ),
            (
                "/MediaBox [0 0 400 400] /CropBox [100 100 300 200]",
                "1 0 0 rg 0 0 400 400 re f 0 0 0 rg 100 100 200 100 re f",
            ),
        ])
    }

    /// The page request a frontend URL for `page` at `width` pixels makes.
    pub(crate) fn request(page: usize, width: u32) -> PageRequest {
        PageRequest::from_query(Some(&format!(
            "reflect-preview=pdf-page&page={page}&width={width}"
        )))
        .unwrap()
        .unwrap()
    }

    pub(crate) fn decode(png: &[u8]) -> image::RgbImage {
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
        image::load_from_memory(png)
            .expect("a decodable PNG")
            .to_rgb8()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widths_round_up_to_a_bucket_and_cap_at_the_largest() {
        assert_eq!(width_bucket(1), 480);
        assert_eq!(width_bucket(480), 480);
        assert_eq!(width_bucket(481), 960);
        assert_eq!(width_bucket(1000), 1440);
        assert_eq!(width_bucket(1920), 1920);
        assert_eq!(width_bucket(2000), 2560);
        assert_eq!(width_bucket(u32::MAX), 2560);
    }

    #[test]
    fn parses_only_the_explicit_page_query() {
        assert_eq!(PageRequest::from_query(None), None);
        assert_eq!(
            PageRequest::from_query(Some("reflect-preview=raster")),
            None
        );
        assert_eq!(
            PageRequest::from_query(Some("page=1&width=480&reflect-preview=pdf-pages")),
            None
        );
        assert_eq!(
            PageRequest::from_query(Some("reflect-preview=pdf-page&page=3&width=700")),
            Some(Ok(PageRequest {
                page: 3,
                bucket: 960
            }))
        );
        // A hover card's raster-only marker still gets the page.
        assert_eq!(
            PageRequest::from_query(Some(
                "reflect-preview=pdf-page&page=1&width=480&reflect-preview=raster"
            )),
            Some(Ok(PageRequest {
                page: 1,
                bucket: 480
            }))
        );
        // Order is free; the first occurrence wins.
        assert_eq!(
            PageRequest::from_query(Some("width=5000&page=1&reflect-preview=pdf-page&page=2")),
            Some(Ok(PageRequest {
                page: 1,
                bucket: 2560
            }))
        );
    }

    #[test]
    fn rejects_a_page_query_with_a_bad_page_or_width() {
        for query in [
            "reflect-preview=pdf-page",
            "reflect-preview=pdf-page&page=1",
            "reflect-preview=pdf-page&width=480",
            "reflect-preview=pdf-page&page=0&width=480",
            "reflect-preview=pdf-page&page=1&width=0",
            "reflect-preview=pdf-page&page=-1&width=480",
            "reflect-preview=pdf-page&page=one&width=480",
            "reflect-preview=pdf-page&page=1&width=4294967296",
            "reflect-preview=pdf-page&pages=1&width=480",
        ] {
            assert_eq!(
                PageRequest::from_query(Some(query)),
                Some(Err(StatusCode::BAD_REQUEST)),
                "{query}"
            );
        }
    }

    #[test]
    fn quarter_turns_swap_the_displayed_axes() {
        let letter = |rotation| PageBox {
            width: 612.0,
            height: 792.0,
            rotation,
        };
        let portrait = PageSize {
            width: 612.0,
            height: 792.0,
        };
        let landscape = PageSize {
            width: 792.0,
            height: 612.0,
        };
        for (rotation, expected) in [
            (0, portrait),
            (90, landscape),
            (180, portrait),
            (270, landscape),
            (360, portrait),
            (450, landscape),
            (-90, landscape),
            (-180, portrait),
        ] {
            assert_eq!(
                letter(rotation).displayed().unwrap(),
                expected,
                "{rotation}"
            );
        }
    }

    #[test]
    fn a_degenerate_crop_box_is_invalid() {
        for (width, height) in [(0.0, 792.0), (612.0, -1.0), (f64::NAN, 792.0)] {
            let page = PageBox {
                width,
                height,
                rotation: 0,
            };
            assert!(matches!(page.displayed(), Err(PdfError::Invalid(_))));
        }
    }

    #[test]
    fn rasters_fill_the_bucket_width_within_the_pixel_budget() {
        let letter = PageSize {
            width: 612.0,
            height: 792.0,
        };
        assert_eq!(raster_size(letter, 480), (480, 621));
        assert_eq!(raster_size(letter, 2560), (2560, 3313));
        // A tall strip scales down uniformly instead of allocating gigabytes.
        let strip = PageSize {
            width: 10.0,
            height: 14_400.0,
        };
        let (width, height) = raster_size(strip, 2560);
        assert!((width * height) as f64 <= MAX_RASTER_PIXELS);
        assert!(width < 2560);
        let aspect = height as f64 / width as f64;
        assert!((aspect - 1440.0).abs() < 1440.0 * 0.01, "{aspect}");
        // A sliver never rounds to zero.
        let sliver = PageSize {
            width: 14_400.0,
            height: 0.5,
        };
        assert_eq!(raster_size(sliver, 480), (480, 1));
    }

    #[test]
    fn cache_keys_change_with_the_file_and_paths_stay_in_the_cache_dir() {
        let key = cache_key("assets/paper.pdf", 1000, 42);
        assert_eq!(key.len(), 32);
        assert!(key.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(key, cache_key("assets/paper.pdf", 1000, 42));
        assert_ne!(key, cache_key("assets/paper.pdf", 1001, 42));
        assert_ne!(key, cache_key("assets/paper.pdf", 1000, 43));
        assert_ne!(key, cache_key("assets/other.pdf", 1000, 42));
        let request = PageRequest {
            page: 12,
            bucket: 960,
        };
        assert_eq!(
            cache_rel_path("assets/paper.pdf", 1000, 42, request),
            format!(".reflect/cache/pdf-pages/{key}/12-960.png")
        );
    }

    #[test]
    fn protocol_statuses_tell_the_failures_apart() {
        let not_found = std::io::Error::from(std::io::ErrorKind::NotFound);
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let cases = [
            (PdfError::Unsupported, StatusCode::NOT_IMPLEMENTED),
            (PdfError::TooLarge(1), StatusCode::PAYLOAD_TOO_LARGE),
            (PdfError::Locked, StatusCode::LOCKED),
            (
                PdfError::Invalid("x".into()),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ),
            (
                PdfError::PageOutOfRange { page: 3, count: 2 },
                StatusCode::NOT_FOUND,
            ),
            (PdfError::Io(not_found), StatusCode::NOT_FOUND),
            (PdfError::Io(denied), StatusCode::FORBIDDEN),
        ];
        for (error, status) in cases {
            assert_eq!(error.status(), status, "{error:?}");
        }
    }

    #[test]
    fn command_errors_carry_the_typed_kinds() {
        let kind = |error: PdfError| {
            serde_json::to_value(AppError::from(error)).unwrap()["kind"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        assert_eq!(kind(PdfError::Unsupported), "unsupported");
        assert_eq!(kind(PdfError::TooLarge(MAX_PDF_BYTES + 1)), "unsupported");
        assert_eq!(
            serde_json::to_value(AppError::from(PdfError::TooLarge(MAX_PDF_BYTES + 1))).unwrap()
                ["message"],
            "PDF previews are limited to 200 MB; this file is 201 MB"
        );
        assert_eq!(kind(PdfError::Locked), "locked");
        assert_eq!(kind(PdfError::Invalid("not a PDF".into())), "invalid");
        assert_eq!(
            kind(PdfError::Io(std::io::ErrorKind::NotFound.into())),
            "notFound"
        );
    }

    #[test]
    fn oversized_files_are_refused_before_and_while_reading() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        fs::create_dir_all(root.join("assets")).unwrap();
        let path = root.join("assets/big.pdf");
        fs::write(&path, b"%PDF-1.4").unwrap();
        let target = resolve_read(&root, "assets/big.pdf", None).unwrap();
        let (file, metadata) = open_pdf(&target).unwrap();
        assert_eq!(read_pdf(file, metadata.len()).unwrap(), b"%PDF-1.4");

        // Sparse: the size check refuses it without reading a byte.
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(MAX_PDF_BYTES + 1)
            .unwrap();
        assert!(matches!(
            open_pdf(&target),
            Err(PdfError::TooLarge(len)) if len == MAX_PDF_BYTES + 1
        ));
        // A file that grows between the check and the read is caught too.
        let small = root.join("assets/small.pdf");
        fs::write(&small, b"0123456789").unwrap();
        assert!(matches!(
            read_capped(File::open(&small).unwrap(), 4, 8),
            Err(PdfError::TooLarge(9))
        ));
        assert!(matches!(
            open_pdf(&resolve_read(&root, "assets", None).unwrap()),
            Err(PdfError::Io(err)) if err.kind() == std::io::ErrorKind::NotFound
        ));
    }

    /// Write `len` bytes of PNG-signed junk at `rel` under the cache, last
    /// used `age_secs` ago.
    fn cached_page(root: &Path, rel: &str, len: usize, age_secs: u64) -> PathBuf {
        let path = root.join(CACHE_DIR).join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.resize(len, 0);
        fs::write(&path, bytes).unwrap();
        let used = SystemTime::now() - std::time::Duration::from_secs(age_secs);
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(used)
            .unwrap();
        path
    }

    #[test]
    fn a_cache_hit_refreshes_the_entry_and_rejects_non_png_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let page = cached_page(dir.path(), "key/1-480.png", 100, 3600);
        let before = fs::metadata(&page).unwrap().modified().unwrap();
        assert_eq!(read_cached(&page).unwrap().len(), 100);
        assert!(fs::metadata(&page).unwrap().modified().unwrap() > before);

        fs::write(&page, b"<svg/>").unwrap();
        assert_eq!(read_cached(&page), None);
        assert_eq!(read_cached(&dir.path().join("missing.png")), None);
    }

    #[test]
    fn the_sweep_evicts_least_recently_used_pages_down_to_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let oldest = cached_page(root, "a/1-480.png", 400, 400);
        let older = cached_page(root, "b/1-480.png", 400, 300);
        let newer = cached_page(root, "a/2-480.png", 400, 200);
        let newest = cached_page(root, "c/1-960.png", 400, 100);
        let stray = root.join(CACHE_DIR).join("c/notes.txt");
        fs::write(&stray, vec![0; 4000]).unwrap();

        sweep_cache_dir(root, 1600);
        assert!(oldest.exists() && newest.exists(), "under the cap: no-op");

        sweep_cache_dir(root, 900);
        assert!(!oldest.exists());
        assert!(!older.exists());
        assert!(newer.exists() && newest.exists());
        assert!(stray.exists(), "only PNGs are cache entries");
        assert!(!root.join(CACHE_DIR).join("b").exists(), "empty dirs go");
        assert!(root.join(CACHE_DIR).join("a").exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_sweep_never_follows_a_symlinked_cache() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let victim = cached_page(outside.path(), "key/1-480.png", 400, 400);
        let cache = dir.path().join(CACHE_DIR);
        fs::create_dir_all(cache.parent().unwrap()).unwrap();
        symlink(outside.path().join(CACHE_DIR), &cache).unwrap();
        sweep_cache_dir(dir.path(), 0);
        assert!(victim.exists());

        // A symlinked document directory inside a real cache is skipped too.
        fs::remove_file(&cache).unwrap();
        fs::create_dir_all(&cache).unwrap();
        symlink(victim.parent().unwrap(), cache.join("key")).unwrap();
        sweep_cache_dir(dir.path(), 0);
        assert!(victim.exists());
    }

    #[test]
    fn the_sweep_tolerates_a_graph_without_a_cache() {
        let dir = tempfile::tempdir().unwrap();
        sweep_page_cache(dir.path());
        sweep_page_cache(&dir.path().join("missing"));
    }

    /// Command tier: page sizes for every page; `asset_open`'s path rules,
    /// local-only folders included; typed failures.
    #[cfg(target_os = "macos")]
    #[test]
    fn pdf_info_reports_every_page_under_the_asset_open_rules() {
        use std::os::unix::fs::symlink;
        use tauri::Manager;
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let (root, raw) = (base.join("graph"), base.join("raw"));
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::create_dir_all(root.join("finance")).unwrap();
        fs::create_dir_all(raw.join("finance/secure")).unwrap();
        fs::write(root.join("assets/paper.pdf"), fixtures::sample()).unwrap();
        fs::write(root.join("assets/fake.pdf"), b"\x89PNG\r\n\x1a\n").unwrap();
        fs::write(raw.join("finance/secure/scan.pdf"), fixtures::sample()).unwrap();
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
        let info = |path: &str, generation| {
            tauri::async_runtime::block_on(pdf_info(
                path.into(),
                generation,
                app.state::<GraphState>(),
            ))
        };

        assert_eq!(
            serde_json::to_value(info("assets/paper.pdf", 4).unwrap()).unwrap(),
            serde_json::json!({ "pages": [
                { "width": 200.0, "height": 100.0 },
                { "width": 100.0, "height": 200.0 },
                { "width": 200.0, "height": 100.0 },
            ] })
        );
        assert_eq!(info("finance/secure/scan.pdf", 4).unwrap().pages.len(), 3);
        assert!(matches!(
            info("assets/fake.pdf", 4),
            Err(AppError::Invalid { .. })
        ));
        assert!(matches!(
            info("assets/missing.pdf", 4),
            Err(AppError::NotFound { .. })
        ));
        assert!(matches!(
            info("notes/paper.md", 4),
            Err(AppError::Traversal { .. })
        ));
        assert!(matches!(
            info("assets/paper.pdf", 3),
            Err(AppError::Io { .. })
        ));
    }

    /// Off macOS the command refuses before any IO: the path need not exist.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn other_platforms_answer_unsupported() {
        use tauri::Manager;
        let dir = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        app.manage(GraphState::default());
        {
            let state = app.state::<GraphState>();
            let mut inner = state.0.lock().unwrap();
            inner.generation = 1;
            inner.root = Some(dir.path().to_path_buf());
        }
        let info = tauri::async_runtime::block_on(pdf_info(
            "assets/missing.pdf".into(),
            1,
            app.state::<GraphState>(),
        ));
        assert!(matches!(info, Err(AppError::Unsupported { .. })));
        let target = resolve_read(dir.path(), "assets/missing.pdf", None).unwrap();
        let request = PageRequest {
            page: 1,
            bucket: 480,
        };
        assert!(matches!(
            lookup_page(dir.path(), None, "assets/missing.pdf", &target, request),
            Err(PdfError::Unsupported)
        ));
        assert!(matches!(
            engine::page_boxes(b""),
            Err(PdfError::Unsupported)
        ));
        assert!(matches!(
            engine::render_png(b"", request),
            Err(PdfError::Unsupported)
        ));
    }
}
