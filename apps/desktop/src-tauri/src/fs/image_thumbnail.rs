//! Image thumbnails for the `reflect-asset://` protocol
//! (`?reflect-preview=thumb&width=W`): a raster attachment decoded, turned
//! upright per its EXIF orientation, downscaled to a width bucket, cropped to
//! the tallest shape a card shows, and encoded as JPEG — PNG when any pixel is
//! translucent. Thumbnails cache under
//! `.reflect/cache/thumbnails/<key>/<width>.thumb` (see `preview_cache`), so
//! only a file's first preview pays for the decode.
//!
//! Decoding uses the `image` crate's Rust codecs on bytes read through
//! `ReadTarget::open`, never re-opened by path. That keeps untrusted image
//! parsing out of native decoders in this unsandboxed process — images do
//! arrive unopened (web clips, archived X media, imports) — so the decode is
//! held to [`THUMBNAIL_FORMATS`] (the crate compiles in more codecs for other
//! dependencies), and its output buffer is reserved against
//! [`MAX_DECODED_BYTES`] from the header, before it is allocated. Only the GIF
//! codec holds its own buffers to what remains; PNG, JPEG, and WebP working
//! memory (progressive or multi-scan JPEG coefficients, up to four components
//! for CMYK; an animation canvas) comes on top, bringing one decode's peak to
//! as much as ~5× the budget. That worst case is what
//! [`MAX_CONCURRENT_RENDERS`] bounds. Anything
//! else, SVG included, is refused, and the frontend falls back to the
//! webview's own decode. The response is always an image this module encoded,
//! never the source bytes.

use std::fs::{File, Metadata};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::Instant;

use image::codecs::jpeg::JpegEncoder;
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use reflect_graph_paths::LocalOnlyFolders;
use tauri::http::StatusCode;
use tokio::sync::Semaphore;

use super::preview_cache;
use super::resolve::{resolve_write, ReadTarget};

/// The query parameter that routes a `reflect-asset://` request here.
const THUMB_QUERY: &str = "reflect-preview=thumb";

/// Thumbnail widths in pixels. A requested width rounds up to the next bucket
/// (the last one caps it), so a resized card swaps between a few cached
/// thumbnails. Must match `packages/core/src/graph/image-thumbnails.ts`.
const WIDTH_BUCKETS: [u32; 4] = [320, 640, 960, 1280];

/// The thumbnail cache, graph-relative.
const CACHE_DIR: &str = ".reflect/cache/thumbnails";

/// Hashed into every cache key; bump it when the output changes so stale
/// thumbnails miss instead of being served.
const CACHE_FORMAT: &str = "thumbnails/v1";

/// Cache entries hold a JPEG or a PNG, told apart by their signature.
const CACHE_EXTENSION: &str = "thumb";

/// The thumbnail cache's total size after the sweep at graph open: 256 MiB.
/// Between opens it may grow past this; only the sweep evicts.
const CACHE_CAP_BYTES: u64 = 256 * 1024 * 1024;

/// The formats thumbnailed: exactly what the passive-preview raster filter
/// allows. Format detection is by content, never by extension.
const THUMBNAIL_FORMATS: [ImageFormat; 4] = [
    ImageFormat::Png,
    ImageFormat::Jpeg,
    ImageFormat::Gif,
    ImageFormat::WebP,
];

/// The largest side a decoder may report: JPEG's own maximum. The pixel count
/// is held by [`MAX_DECODED_BYTES`], so a long, narrow full-page screenshot
/// (1440×18000) thumbnails like any photo of the same size.
const MAX_IMAGE_SIDE: u32 = 65_535;

/// The largest file thumbnailed (64 MiB; 32 MiB on iOS). Larger files answer
/// `413`, and the passive raster fallback refuses them too
/// ([`passive_fallback_allowed`]).
#[cfg(not(target_os = "ios"))]
pub(crate) const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
#[cfg(target_os = "ios")]
pub(crate) const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

/// The largest decoded image, in bytes: 160 MiB, which admits a 50-megapixel
/// photo (RGB), and 96 MiB on iOS, a 24-megapixel one with room to spare.
/// Reserved from the header before the buffer is allocated; a larger image is
/// refused here and by the passive raster fallback alike.
#[cfg(not(target_os = "ios"))]
const MAX_DECODED_BYTES: u64 = 160 * 1024 * 1024;
#[cfg(target_os = "ios")]
const MAX_DECODED_BYTES: u64 = 96 * 1024 * 1024;

const JPEG_QUALITY: u8 = 82;

/// The tallest shape a thumbnail keeps, as height over width: a card clamps
/// its preview to this ratio and crops the rest (`MAX_RATIO` in the
/// frontend's `attachments/attachment-media.ts`), so a longer image is
/// cropped to its middle, where a card shows it.
const MAX_HEIGHT_RATIO: f64 = 1.8;

/// Thumbnail renders running at once, across every window and graph. With a
/// decode's peak at up to ~5× [`MAX_DECODED_BYTES`] (a multi-scan CMYK JPEG
/// reaches about 4.7×, its source bytes included, so the bound has ~10%
/// headroom), a crafted file's worst case stays near 1.6 GiB on desktop and
/// 480 MiB on iOS (one at a time); ordinary photos peak far lower.
#[cfg(not(target_os = "ios"))]
const MAX_CONCURRENT_RENDERS: usize = 2;
#[cfg(target_os = "ios")]
const MAX_CONCURRENT_RENDERS: usize = 1;

static RENDER_SLOTS: Semaphore = Semaphore::const_new(MAX_CONCURRENT_RENDERS);

/// Why a thumbnail could not be produced.
#[derive(Debug)]
pub(crate) enum ThumbnailError {
    /// The file is over [`MAX_IMAGE_BYTES`].
    TooLarge(u64),
    /// Not an image in [`THUMBNAIL_FORMATS`], or not one the codec can read.
    Invalid(String),
    /// The decoded image would exceed [`MAX_IMAGE_SIDE`] or [`MAX_DECODED_BYTES`]
    /// (the crate's limit errors).
    OverBudget(String),
    /// Reading the file failed.
    Io(std::io::Error),
}

impl std::fmt::Display for ThumbnailError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge(size) => write!(
                formatter,
                "thumbnails are limited to {} MB; this file is {} MB",
                MAX_IMAGE_BYTES >> 20,
                size.div_ceil(1 << 20)
            ),
            Self::Invalid(message) => write!(formatter, "cannot thumbnail this image: {message}"),
            Self::OverBudget(detail) => {
                write!(formatter, "past the thumbnail decode budget: {detail}")
            }
            Self::Io(err) => write!(formatter, "reading the image failed: {err}"),
        }
    }
}

impl From<std::io::Error> for ThumbnailError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err)
    }
}

impl From<image::ImageError> for ThumbnailError {
    fn from(err: image::ImageError) -> Self {
        match err {
            image::ImageError::Limits(limit) => Self::OverBudget(limit.to_string()),
            other => Self::Invalid(other.to_string()),
        }
    }
}

impl ThumbnailError {
    /// The protocol status for this failure.
    pub(crate) fn status(&self) -> StatusCode {
        match self {
            Self::TooLarge(_) | Self::OverBudget(_) => StatusCode::PAYLOAD_TOO_LARGE,
            Self::Invalid(_) => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::Io(err) => match err.kind() {
                std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
                std::io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            },
        }
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

/// A thumbnail request, from the protocol query `reflect-preview=thumb&width=W`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ThumbnailRequest {
    /// The width bucket to render at, in pixels.
    bucket: u32,
}

impl ThumbnailRequest {
    /// `None` when the query does not ask for a thumbnail; `Some(Err)` when it
    /// does but `width` is missing, zero, or malformed. The first `width` wins.
    pub(crate) fn from_query(query: Option<&str>) -> Option<Result<Self, StatusCode>> {
        let parameters: Vec<&str> = query?.split('&').collect();
        if !parameters.contains(&THUMB_QUERY) {
            return None;
        }
        let width = parameters
            .iter()
            .find_map(|parameter| parameter.strip_prefix("width")?.strip_prefix('='))
            .and_then(|width| width.parse::<u32>().ok());
        Some(match width {
            Some(width) if width > 0 => Ok(Self {
                bucket: width_bucket(width),
            }),
            _ => Err(StatusCode::BAD_REQUEST),
        })
    }
}

/// An encoded thumbnail and its content type.
#[derive(Debug)]
pub(crate) struct Thumbnail {
    pub(crate) bytes: Vec<u8>,
    pub(crate) mime: &'static str,
}

/// The content type of encoded thumbnail bytes, or `None` for anything this
/// module does not produce.
fn thumbnail_mime(bytes: &[u8]) -> Option<&'static str> {
    if preview_cache::is_png(bytes) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else {
        None
    }
}

fn is_thumbnail(bytes: &[u8]) -> bool {
    thumbnail_mime(bytes).is_some()
}

/// The cheap half of a thumbnail request.
pub(crate) enum ThumbnailLookup {
    /// The thumbnail was cached.
    Cached(Thumbnail),
    /// The thumbnail must be rendered ([`ThumbnailRender::run`]).
    Render(ThumbnailRender),
}

/// A thumbnail render: where the image is and the version the lookup saw.
/// The file is opened again only once a render slot is free, so a queue of
/// renders waiting for one holds no file handles.
pub(crate) struct ThumbnailRender {
    target: ReadTarget,
    len: u64,
    modified_ms: Option<u64>,
    request: ThumbnailRequest,
    /// Where to cache the thumbnail; `None` when the cache is unavailable.
    cache: Option<CacheEntry>,
}

struct CacheEntry {
    root: PathBuf,
    path: PathBuf,
}

/// Open the image a read target names and check it can be thumbnailed: a
/// regular file within [`MAX_IMAGE_BYTES`].
fn open_image(target: &ReadTarget) -> Result<(File, Metadata), ThumbnailError> {
    let file = target.open()?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(ThumbnailError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "not a file",
        )));
    }
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(ThumbnailError::TooLarge(metadata.len()));
    }
    Ok((file, metadata))
}

/// Read an opened image, refusing one that grew past [`MAX_IMAGE_BYTES`]
/// since it was checked.
fn read_image(file: File, expected_len: u64) -> Result<Vec<u8>, ThumbnailError> {
    let mut bytes = Vec::with_capacity(expected_len.min(MAX_IMAGE_BYTES) as usize);
    file.take(MAX_IMAGE_BYTES + 1).read_to_end(&mut bytes)?;
    let len = bytes.len() as u64;
    if len > MAX_IMAGE_BYTES {
        return Err(ThumbnailError::TooLarge(len));
    }
    Ok(bytes)
}

/// The graph-relative cache path for one thumbnail.
fn cache_rel_path(rel: &str, size: u64, modified_ms: u64, request: ThumbnailRequest) -> String {
    format!(
        "{CACHE_DIR}/{}/{}.{CACHE_EXTENSION}",
        preview_cache::cache_key(CACHE_FORMAT, rel, size, modified_ms),
        request.bucket
    )
}

/// Resolve a thumbnail request to its cached image or to the render that
/// produces it. Runs on the blocking pool after the protocol's generation
/// check and read guard (`target`); `rel` is the image's graph-relative path.
pub(crate) fn lookup_thumbnail(
    root: &Path,
    local_only: Option<&LocalOnlyFolders>,
    rel: &str,
    target: ReadTarget,
    request: ThumbnailRequest,
) -> Result<ThumbnailLookup, ThumbnailError> {
    let (file, metadata) = open_image(&target)?;
    drop(file);
    let modified_ms = super::modified_ms(&metadata);
    let cache = modified_ms.and_then(|modified_ms| {
        let entry = cache_rel_path(rel, metadata.len(), modified_ms, request);
        match resolve_write(root, &entry, local_only) {
            Ok(path) => Some(CacheEntry {
                root: root.to_path_buf(),
                path,
            }),
            Err(err) => {
                tracing::warn!(?err, "thumbnail cache unavailable");
                None
            }
        }
    });
    let cached = cache
        .as_ref()
        .and_then(|entry| preview_cache::read_cached(&entry.path, is_thumbnail));
    if let Some(bytes) = cached {
        if let Some(mime) = thumbnail_mime(&bytes) {
            tracing::debug!(path = rel, bucket = request.bucket, "thumbnail cache hit");
            return Ok(ThumbnailLookup::Cached(Thumbnail { bytes, mime }));
        }
    }
    tracing::debug!(path = rel, bucket = request.bucket, "thumbnail cache miss");
    Ok(ThumbnailLookup::Render(ThumbnailRender {
        target,
        len: metadata.len(),
        modified_ms,
        request,
        cache,
    }))
}

impl ThumbnailRender {
    /// Render once one of the render slots is free, on the blocking pool, and
    /// cache the result (best-effort: a failed cache write still answers).
    pub(crate) async fn run(self) -> Result<Thumbnail, ThumbnailError> {
        let _slot = RENDER_SLOTS
            .acquire()
            .await
            .expect("render semaphore stays open");
        tauri::async_runtime::spawn_blocking(move || self.render())
            .await
            .map_err(|err| ThumbnailError::Io(std::io::Error::other(err.to_string())))?
    }

    fn render(self) -> Result<Thumbnail, ThumbnailError> {
        let started = Instant::now();
        // A request for the same thumbnail that waited ahead of this one (a
        // card scrolled away and back) may have cached it meanwhile.
        if let Some(entry) = &self.cache {
            if let Some(bytes) = preview_cache::read_cached(&entry.path, is_thumbnail) {
                if let Some(mime) = thumbnail_mime(&bytes) {
                    return Ok(Thumbnail { bytes, mime });
                }
            }
        }
        let (file, metadata) = open_image(&self.target)?;
        // A file rewritten while the render waited is rendered as it is now,
        // but never cached under the key of the version the lookup saw.
        let unchanged =
            metadata.len() == self.len && super::modified_ms(&metadata) == self.modified_ms;
        let cache = if unchanged { self.cache } else { None };
        let bytes = read_image(file, metadata.len())?;
        let thumbnail = render_thumbnail(&bytes, self.request.bucket)?;
        tracing::debug!(
            bucket = self.request.bucket,
            image_bytes = metadata.len(),
            thumbnail_bytes = thumbnail.bytes.len(),
            elapsed_ms = started.elapsed().as_millis() as u64,
            "rendered a thumbnail"
        );
        if let Some(entry) = cache {
            if let Err(err) =
                super::io::atomic_write_bytes(&entry.root, &entry.path, &thumbnail.bytes)
            {
                tracing::warn!(?err, path = %entry.path.display(), "failed to cache a thumbnail");
            }
        }
        Ok(thumbnail)
    }
}

/// A decoder for `bytes` held to the thumbnail formats and decode budget:
/// `OverBudget` when the header declares an image past
/// [`MAX_IMAGE_SIDE`] or [`MAX_DECODED_BYTES`], before anything is decoded.
fn budgeted_decoder(bytes: &[u8]) -> Result<impl ImageDecoder + '_, ThumbnailError> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    if !reader
        .format()
        .is_some_and(|format| THUMBNAIL_FORMATS.contains(&format))
    {
        return Err(ThumbnailError::Invalid(
            "not an image format thumbnails read".into(),
        ));
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_SIDE);
    limits.max_image_height = Some(MAX_IMAGE_SIDE);
    limits.max_alloc = Some(MAX_DECODED_BYTES);
    reader.limits(limits.clone());
    let mut decoder = reader.into_decoder()?;
    // What `ImageReader::decode` does and `from_decoder` skips: reserve the
    // output buffer from the header and hand the decoder what remains, which
    // the GIF codec holds its frame buffer to (the others do not count theirs).
    limits.reserve(decoder.total_bytes())?;
    decoder.set_limits(limits)?;
    Ok(decoder)
}

/// Whether the passive raster fallback (`?reflect-preview=raster&budget=thumb`,
/// requested when a thumbnail fails) may hand `bytes` to the webview: never
/// past the size ([`MAX_IMAGE_BYTES`]) or decode budget a thumbnail is held
/// to, so an image refused a thumbnail for its size is not decoded in full by
/// the webview instead. Bytes the thumbnail codecs cannot read pass: the
/// webview may still decode them.
pub(crate) fn passive_fallback_allowed(bytes: &[u8]) -> bool {
    bytes.len() as u64 <= MAX_IMAGE_BYTES
        && !matches!(budgeted_decoder(bytes), Err(ThumbnailError::OverBudget(_)))
}

/// Decode `bytes`, scale the image down to `bucket` pixels wide as displayed
/// (never up), crop it to the tallest shape a card shows, turn it upright,
/// and encode it. Downscaling and cropping before orienting keep the
/// orientation's copy thumbnail-sized.
fn render_thumbnail(bytes: &[u8], bucket: u32) -> Result<Thumbnail, ThumbnailError> {
    let mut decoder = budgeted_decoder(bytes)?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let image = downscale(DynamicImage::from_decoder(decoder)?, bucket, orientation);
    let mut image = crop_tall(image, orientation);
    image.apply_orientation(orientation);
    encode(&image)
}

/// Whether `orientation` swaps the stored width and height.
fn is_quarter_turned(orientation: Orientation) -> bool {
    matches!(
        orientation,
        Orientation::Rotate90
            | Orientation::Rotate270
            | Orientation::Rotate90FlipH
            | Orientation::Rotate270FlipH
    )
}

/// Scale `image` so that, once `orientation` is applied, it is at most
/// `bucket` pixels wide: after a quarter turn, today's height is the width.
fn downscale(image: DynamicImage, bucket: u32, orientation: Orientation) -> DynamicImage {
    let quarter_turned = is_quarter_turned(orientation);
    if quarter_turned && image.height() > bucket {
        image.thumbnail(u32::MAX, bucket)
    } else if !quarter_turned && image.width() > bucket {
        image.thumbnail(bucket, u32::MAX)
    } else {
        image
    }
}

/// Crop `image` to its middle so that, once `orientation` is applied, it is at
/// most [`MAX_HEIGHT_RATIO`] times as tall as it is wide. A centered crop
/// commutes with every orientation, so it can run before the turn.
fn crop_tall(image: DynamicImage, orientation: Orientation) -> DynamicImage {
    let quarter_turned = is_quarter_turned(orientation);
    let (displayed_width, displayed_height) = if quarter_turned {
        (image.height(), image.width())
    } else {
        (image.width(), image.height())
    };
    let max_height = (f64::from(displayed_width) * MAX_HEIGHT_RATIO).ceil() as u32;
    if displayed_height <= max_height {
        return image;
    }
    let offset = (displayed_height - max_height) / 2;
    if quarter_turned {
        image.crop_imm(offset, 0, max_height, image.height())
    } else {
        image.crop_imm(0, offset, image.width(), max_height)
    }
}

/// JPEG for an opaque image; PNG when any pixel is translucent, which JPEG
/// cannot carry.
fn encode(image: &DynamicImage) -> Result<Thumbnail, ThumbnailError> {
    let translucent =
        image.color().has_alpha() && image.to_rgba8().pixels().any(|pixel| pixel.0[3] < u8::MAX);
    let mut bytes = Vec::new();
    if translucent {
        image.write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)?;
        return Ok(Thumbnail {
            bytes,
            mime: "image/png",
        });
    }
    JpegEncoder::new_with_quality(&mut bytes, JPEG_QUALITY).encode_image(&image.to_rgb8())?;
    Ok(Thumbnail {
        bytes,
        mime: "image/jpeg",
    })
}

/// Bound the thumbnail cache when a graph opens (see [`CACHE_CAP_BYTES`]).
pub(super) fn sweep_thumbnail_cache(root: &Path) {
    preview_cache::sweep_cache_dir(root, CACHE_DIR, CACHE_EXTENSION, CACHE_CAP_BYTES);
}

#[cfg(test)]
mod tests {
    use std::fs;

    use image::{Rgb, RgbImage, Rgba, RgbaImage};

    use super::super::resolve::resolve_read;
    use super::*;

    fn png(image: &DynamicImage) -> Vec<u8> {
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .unwrap();
        bytes
    }

    fn request(width: u32) -> ThumbnailRequest {
        ThumbnailRequest::from_query(Some(&format!("reflect-preview=thumb&width={width}")))
            .unwrap()
            .unwrap()
    }

    #[test]
    fn widths_round_up_to_a_bucket_and_cap_at_the_largest() {
        assert_eq!(width_bucket(1), 320);
        assert_eq!(width_bucket(320), 320);
        assert_eq!(width_bucket(321), 640);
        assert_eq!(width_bucket(5000), 1280);
    }

    #[test]
    fn parses_only_the_explicit_thumbnail_query() {
        assert_eq!(ThumbnailRequest::from_query(None), None);
        assert_eq!(
            ThumbnailRequest::from_query(Some("reflect-preview=raster")),
            None
        );
        assert_eq!(
            ThumbnailRequest::from_query(Some("width=500&reflect-preview=thumb")),
            Some(Ok(ThumbnailRequest { bucket: 640 }))
        );
        for bad in [
            "reflect-preview=thumb",
            "reflect-preview=thumb&width=0",
            "reflect-preview=thumb&width=wide",
        ] {
            assert_eq!(
                ThumbnailRequest::from_query(Some(bad)),
                Some(Err(StatusCode::BAD_REQUEST)),
                "{bad}"
            );
        }
    }

    #[test]
    fn scales_an_opaque_image_down_to_the_bucket_as_jpeg() {
        let source = DynamicImage::ImageRgb8(RgbImage::from_pixel(2000, 1000, Rgb([200, 30, 30])));
        let thumbnail = render_thumbnail(&png(&source), 640).unwrap();

        assert_eq!(thumbnail.mime, "image/jpeg");
        assert_eq!(thumbnail_mime(&thumbnail.bytes), Some("image/jpeg"));
        let decoded = image::load_from_memory(&thumbnail.bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (640, 320));
    }

    #[test]
    fn never_scales_up_and_keeps_translucency_as_png() {
        let mut source = RgbaImage::from_pixel(100, 50, Rgba([0, 0, 0, 255]));
        source.put_pixel(0, 0, Rgba([0, 0, 0, 0]));
        let thumbnail = render_thumbnail(&png(&DynamicImage::ImageRgba8(source)), 640).unwrap();

        assert_eq!(thumbnail.mime, "image/png");
        let decoded = image::load_from_memory(&thumbnail.bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (100, 50));
    }

    #[test]
    fn an_opaque_alpha_channel_still_encodes_as_jpeg() {
        let source = DynamicImage::ImageRgba8(RgbaImage::from_pixel(10, 10, Rgba([1, 2, 3, 255])));
        assert_eq!(
            render_thumbnail(&png(&source), 320).unwrap().mime,
            "image/jpeg"
        );
    }

    #[test]
    fn refuses_svg_and_other_non_raster_bytes() {
        for bytes in [
            &b"<svg xmlns='http://www.w3.org/2000/svg'/>"[..],
            b"not an image",
        ] {
            let err = render_thumbnail(bytes, 320).unwrap_err();
            assert_eq!(err.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        }
    }

    /// A GIF that declares a `width`×`height` canvas and carries no pixel
    /// data: all a decoder needs to report its size.
    fn gif_header(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = b"GIF89a".to_vec();
        bytes.extend(width.to_le_bytes());
        bytes.extend(height.to_le_bytes());
        // A two-color global table, then one full-canvas image descriptor.
        bytes.extend([0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x2c, 0, 0, 0, 0]);
        bytes.extend(width.to_le_bytes());
        bytes.extend(height.to_le_bytes());
        bytes.extend([0, 2, 0, 0x3b]);
        bytes
    }

    #[test]
    fn refuses_images_past_the_decode_budget_from_the_header() {
        // 8000², 16000², and 20000² RGBA (~244 MiB to ~1.5 GiB) are inside
        // the side limit but past the byte budget. None may reach allocation.
        for (width, height) in [(8_000, 8_000), (16_000, 16_000), (20_000, 20_000)] {
            let err = render_thumbnail(&gif_header(width, height), 320).unwrap_err();
            assert!(
                matches!(err, ThumbnailError::OverBudget(_)),
                "{width}×{height}: {err}"
            );
            assert_eq!(err.status(), StatusCode::PAYLOAD_TOO_LARGE);
        }
    }

    #[test]
    fn admits_an_ordinary_24_megapixel_photo_past_the_budget() {
        // A 6000×4000 canvas (~92 MiB as RGBA) clears the budget on every
        // target; this header carries no pixels, so the decode itself fails.
        let err = render_thumbnail(&gif_header(6_000, 4_000), 320).unwrap_err();
        assert!(matches!(err, ThumbnailError::Invalid(_)), "{err}");
    }

    /// A long full-page screenshot is past the old 16384 px side limit but
    /// within the byte budget (~99 MiB as RGBA): it thumbnails like a photo.
    #[cfg(not(target_os = "ios"))]
    #[test]
    fn admits_a_long_screenshot_within_the_budget() {
        let header = gif_header(1_440, 18_000);
        let err = render_thumbnail(&header, 320).unwrap_err();
        assert!(matches!(err, ThumbnailError::Invalid(_)), "{err}");
        assert!(passive_fallback_allowed(&header));
    }

    #[test]
    fn the_passive_fallback_refuses_what_thumbnails_refuse_for_size() {
        assert!(!passive_fallback_allowed(&gif_header(16_000, 16_000)));
        // Unreadable to the thumbnail codecs: the webview may still decode it.
        assert!(passive_fallback_allowed(b"not an image"));
        let source = DynamicImage::ImageRgb8(RgbImage::new(10, 10));
        assert!(passive_fallback_allowed(&png(&source)));
    }

    #[test]
    fn crops_a_tall_image_to_its_middle_at_the_card_ratio() {
        let mut source = RgbImage::from_pixel(100, 1000, Rgb([0, 0, 0]));
        // A white middle band: the crop keeps the middle.
        for x in 0..100 {
            for y in 495..505 {
                source.put_pixel(x, y, Rgb([255, 255, 255]));
            }
        }
        let thumbnail = render_thumbnail(&png(&DynamicImage::ImageRgb8(source)), 320).unwrap();
        let decoded = image::load_from_memory(&thumbnail.bytes).unwrap().to_rgb8();
        assert_eq!(decoded.dimensions(), (100, 180));
        assert!(decoded.get_pixel(50, 90).0[0] > 200);

        // After a quarter turn the stored width is the displayed height.
        let wide = DynamicImage::ImageRgb8(RgbImage::new(1000, 100));
        let mut cropped = crop_tall(wide, Orientation::Rotate90);
        cropped.apply_orientation(Orientation::Rotate90);
        assert_eq!((cropped.width(), cropped.height()), (100, 180));
        // Wide and ordinary shapes are untouched.
        let photo = crop_tall(
            DynamicImage::ImageRgb8(RgbImage::new(400, 300)),
            Orientation::NoTransforms,
        );
        assert_eq!((photo.width(), photo.height()), (400, 300));
    }

    /// The desktop budget admits a 50-megapixel RGB photo, checked at compile time.
    #[cfg(not(target_os = "ios"))]
    const _: () = assert!(8_160 * 6_120 * 3 <= MAX_DECODED_BYTES);

    #[test]
    fn refuses_formats_outside_the_allowlist() {
        // Valid 1×1 images in formats the crate may have codecs for (compiled
        // in for another dependency): thumbnails never use them.
        let mut bmp = b"BM".to_vec();
        for field in [58u32, 0, 54, 40, 1, 1] {
            bmp.extend(field.to_le_bytes());
        }
        bmp.extend(1u16.to_le_bytes());
        bmp.extend(24u16.to_le_bytes());
        bmp.extend([0; 24]);
        bmp.extend([0, 0, 255, 0]);
        // An icon whose one entry is an embedded PNG.
        let embedded = png(&DynamicImage::ImageRgb8(RgbImage::new(1, 1)));
        let mut ico = vec![0, 0, 1, 0, 1, 0, 1, 1, 0, 0];
        ico.extend(1u16.to_le_bytes());
        ico.extend(32u16.to_le_bytes());
        ico.extend((embedded.len() as u32).to_le_bytes());
        ico.extend(22u32.to_le_bytes());
        ico.extend(embedded);

        for (bytes, format) in [(bmp, ImageFormat::Bmp), (ico, ImageFormat::Ico)] {
            assert_eq!(image::guess_format(&bytes).unwrap(), format);
            let err = render_thumbnail(&bytes, 320).unwrap_err();
            assert_eq!(
                err.status(),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "{format:?}"
            );
        }
    }

    #[test]
    fn downscales_to_the_displayed_width_before_orienting() {
        let landscape = || DynamicImage::ImageRgb8(RgbImage::new(200, 100));
        let upright = |orientation| {
            let mut image = downscale(landscape(), 64, orientation);
            image.apply_orientation(orientation);
            (image.width(), image.height())
        };
        assert_eq!(upright(Orientation::NoTransforms), (64, 32));
        assert_eq!(upright(Orientation::Rotate90), (64, 128));
        assert_eq!(upright(Orientation::Rotate270FlipH), (64, 128));
        // Never scaled up.
        let small = downscale(landscape(), 640, Orientation::Rotate90);
        assert_eq!((small.width(), small.height()), (200, 100));
    }

    #[test]
    fn statuses_tell_the_failures_apart() {
        assert_eq!(
            ThumbnailError::TooLarge(1).status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        assert_eq!(
            ThumbnailError::Io(std::io::ErrorKind::NotFound.into()).status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn renders_once_then_serves_the_cached_thumbnail() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::create_dir_all(root.join(".reflect")).unwrap();
        let source = DynamicImage::ImageRgb8(RgbImage::from_pixel(1000, 500, Rgb([10, 20, 30])));
        fs::write(root.join("assets/photo.png"), png(&source)).unwrap();

        let lookup = || {
            let target = resolve_read(root, "assets/photo.png", None).unwrap();
            lookup_thumbnail(root, None, "assets/photo.png", target, request(500)).unwrap()
        };
        let ThumbnailLookup::Render(render) = lookup() else {
            panic!("a first request renders");
        };
        let rendered = render.render().unwrap();
        let ThumbnailLookup::Cached(cached) = lookup() else {
            panic!("a second request hits the cache");
        };
        assert_eq!(cached.bytes, rendered.bytes);
        assert_eq!(cached.mime, "image/jpeg");
    }

    #[test]
    fn a_file_rewritten_while_queued_renders_fresh_and_is_not_cached() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::create_dir_all(root.join(".reflect")).unwrap();
        let first = DynamicImage::ImageRgb8(RgbImage::from_pixel(100, 50, Rgb([10, 20, 30])));
        fs::write(root.join("assets/photo.png"), png(&first)).unwrap();
        let target = resolve_read(root, "assets/photo.png", None).unwrap();
        let ThumbnailLookup::Render(render) =
            lookup_thumbnail(root, None, "assets/photo.png", target, request(320)).unwrap()
        else {
            panic!("a first request renders");
        };
        // Rewritten at another size before the render slot frees up.
        let second = DynamicImage::ImageRgb8(RgbImage::from_fn(80, 40, |column, row| {
            Rgb([(column * 3) as u8, (row * 6) as u8, 7])
        }));
        assert_ne!(png(&first).len(), png(&second).len());
        fs::write(root.join("assets/photo.png"), png(&second)).unwrap();

        let rendered = render.render().unwrap();
        let decoded = image::load_from_memory(&rendered.bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (80, 40));
        let cache = root.join(CACHE_DIR);
        let cached = fs::read_dir(&cache)
            .map(|keys| {
                keys.flatten()
                    .flat_map(|key| fs::read_dir(key.path()).into_iter().flatten().flatten())
                    .count()
            })
            .unwrap_or(0);
        assert_eq!(cached, 0, "the stale key must not be filled");
    }

    #[test]
    fn the_sweep_tolerates_a_graph_without_a_cache() {
        let dir = tempfile::tempdir().unwrap();
        sweep_thumbnail_cache(dir.path());
        sweep_thumbnail_cache(&dir.path().join("missing"));
    }
}
