//! The macOS PDF engine: CoreGraphics parses the document from bytes the
//! caller already read and rasterizes one page into an sRGB bitmap; ImageIO
//! encodes it as PNG. Nothing here opens a file.
//!
//! CoreGraphics parses in Reflect's own, unsandboxed process: acceptable
//! while every PDF in a graph is one the user added themselves. Move this
//! engine into a sandboxed helper once PDFs can arrive unopened (a clipper,
//! an automated import, a shared graph) or a CoreGraphics PDF flaw is
//! exploited in the wild.

use std::ptr::NonNull;

use objc2_core_foundation::{CFData, CFMutableData, CFRetained, CFString, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    kCGColorSpaceSRGB, CGBitmapContextCreate, CGBitmapContextCreateImage, CGColorSpace, CGContext,
    CGDataProvider, CGImage, CGImageAlphaInfo, CGInterpolationQuality, CGPDFBox, CGPDFDocument,
    CGPDFPage,
};
use objc2_image_io::CGImageDestination;

use super::{raster_size, PageBox, PageRequest, PageSize, PdfError};

pub(super) const SUPPORTED: bool = true;

/// Every page's crop box and `/Rotate`, in page order.
pub(super) fn page_boxes(bytes: &[u8]) -> Result<Vec<PageBox>, PdfError> {
    let document = open_document(bytes)?;
    let count = CGPDFDocument::number_of_pages(Some(&document));
    (1..=count)
        .map(|number| page(&document, number).map(|page| page_box(&page)))
        .collect()
}

/// Render one page `request.bucket` pixels wide (less only when the pixel
/// budget binds) on white, and encode it as PNG.
pub(super) fn render_png(bytes: &[u8], request: PageRequest) -> Result<Vec<u8>, PdfError> {
    let document = open_document(bytes)?;
    let count = CGPDFDocument::number_of_pages(Some(&document));
    if request.page > count {
        return Err(PdfError::PageOutOfRange {
            page: request.page,
            count,
        });
    }
    let page = page(&document, request.page)?;
    let displayed = page_box(&page).displayed()?;
    let (width, height) = raster_size(displayed, request.bucket);
    let context = bitmap_context(width, height)?;
    draw_page(&context, &page, displayed, width, height);
    let image = CGBitmapContextCreateImage(Some(&context))
        .ok_or_else(|| failure("CoreGraphics could not snapshot the page bitmap"))?;
    encode_png(&image)
}

/// Parse a PDF from memory. An encrypted document is unlocked with the empty
/// password first: PDFs that only restrict permissions are common and open
/// without asking; anything else is `locked`.
fn open_document(bytes: &[u8]) -> Result<CFRetained<CGPDFDocument>, PdfError> {
    let not_a_pdf = || PdfError::Invalid("not a PDF CoreGraphics can read".into());
    let data = CFData::from_bytes(bytes);
    let provider = CGDataProvider::with_cf_data(Some(&data)).ok_or_else(not_a_pdf)?;
    let document = CGPDFDocument::with_provider(Some(&provider)).ok_or_else(not_a_pdf)?;
    if !CGPDFDocument::is_unlocked(Some(&document)) {
        let empty = NonNull::new(c"".as_ptr().cast_mut()).expect("a literal is never null");
        // SAFETY: `empty` points at a NUL-terminated literal that outlives
        // the call; CoreGraphics only reads it.
        unsafe { CGPDFDocument::unlock_with_password(Some(&document), empty) };
        if !CGPDFDocument::is_unlocked(Some(&document)) {
            return Err(PdfError::Locked);
        }
    }
    if CGPDFDocument::number_of_pages(Some(&document)) == 0 {
        return Err(PdfError::Invalid("the PDF has no pages".into()));
    }
    Ok(document)
}

fn page(document: &CGPDFDocument, number: usize) -> Result<CFRetained<CGPDFPage>, PdfError> {
    CGPDFDocument::page(Some(document), number)
        .ok_or_else(|| PdfError::Invalid(format!("page {number} could not be read")))
}

/// CoreGraphics' crop box is already clipped to the media box.
fn page_box(page: &CGPDFPage) -> PageBox {
    let crop = CGPDFPage::box_rect(Some(page), CGPDFBox::CropBox);
    PageBox {
        width: crop.size.width,
        height: crop.size.height,
        rotation: CGPDFPage::rotation_angle(Some(page)),
    }
}

/// An opaque 8-bit RGB bitmap (RGBX) in sRGB, owned by CoreGraphics.
fn bitmap_context(width: usize, height: usize) -> Result<CFRetained<CGContext>, PdfError> {
    // SAFETY: reading an immutable CoreGraphics constant.
    let srgb = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }))
        .ok_or_else(|| failure("the sRGB color space is unavailable"))?;
    // SAFETY: a null `data` pointer asks CoreGraphics to allocate (and
    // later free) the pixel buffer; with 0, it also picks `bytes_per_row`.
    unsafe {
        CGBitmapContextCreate(
            std::ptr::null_mut(),
            width,
            height,
            8,
            0,
            Some(&srgb),
            CGImageAlphaInfo::NoneSkipLast.0,
        )
    }
    .ok_or_else(|| failure("CoreGraphics could not allocate the page bitmap"))
}

/// Paint white, then the page scaled to fill the bitmap. The CTM first maps
/// points to pixels, so the drawing transform maps the crop box onto a rect
/// of its own displayed size: it applies `/Rotate` and the crop origin but
/// never scales (CoreGraphics' drawing transform only ever scales down,
/// which would leave a small page centered in a large bitmap).
fn draw_page(
    context: &CGContext,
    page: &CGPDFPage,
    displayed: PageSize,
    width: usize,
    height: usize,
) {
    let (width, height) = (width as f64, height as f64);
    let context = Some(context);
    CGContext::set_rgb_fill_color(context, 1.0, 1.0, 1.0, 1.0);
    CGContext::fill_rect(
        context,
        CGRect::new(CGPoint::ZERO, CGSize::new(width, height)),
    );
    CGContext::set_interpolation_quality(context, CGInterpolationQuality::High);
    CGContext::scale_ctm(context, width / displayed.width, height / displayed.height);
    let points = CGRect::new(
        CGPoint::ZERO,
        CGSize::new(displayed.width, displayed.height),
    );
    let transform = CGPDFPage::drawing_transform(Some(page), CGPDFBox::CropBox, points, 0, true);
    CGContext::concat_ctm(context, transform);
    CGContext::clip_to_rect(context, CGPDFPage::box_rect(Some(page), CGPDFBox::CropBox));
    CGContext::draw_pdf_page(context, Some(page));
}

fn encode_png(image: &CGImage) -> Result<Vec<u8>, PdfError> {
    let data = CFMutableData::new(None, 0).ok_or_else(|| failure("out of memory"))?;
    let png = CFString::from_static_str("public.png");
    // SAFETY: no options dictionary is passed.
    let destination = unsafe { CGImageDestination::with_data(&data, &png, 1, None) }
        .ok_or_else(|| failure("ImageIO has no PNG encoder"))?;
    // SAFETY: no properties dictionary is passed; `finalize` runs once,
    // after the one image the destination was created for.
    let finalized = unsafe {
        destination.add_image(image, None);
        destination.finalize()
    };
    if !finalized {
        return Err(failure("ImageIO could not encode the page"));
    }
    Ok(data.to_vec())
}

fn failure(message: &str) -> PdfError {
    PdfError::Io(std::io::Error::other(message.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::{decode, pdf, request, sample};
    use super::*;

    fn is_black(pixel: &image::Rgb<u8>) -> bool {
        pixel.0.iter().all(|channel| *channel < 16)
    }

    fn is_white(pixel: &image::Rgb<u8>) -> bool {
        pixel.0.iter().all(|channel| *channel > 239)
    }

    #[test]
    fn reports_displayed_page_sizes() {
        let sizes: Vec<PageSize> = page_boxes(&sample())
            .unwrap()
            .into_iter()
            .map(|page| page.displayed().unwrap())
            .collect();
        assert_eq!(
            sizes,
            [
                PageSize {
                    width: 200.0,
                    height: 100.0
                },
                PageSize {
                    width: 100.0,
                    height: 200.0
                },
                PageSize {
                    width: 200.0,
                    height: 100.0
                },
            ]
        );
    }

    #[test]
    fn a_small_page_scales_up_to_fill_the_bucket() {
        let image = decode(&render_png(&sample(), request(1, 300)).unwrap());
        assert_eq!(image.dimensions(), (480, 240));
        for (x, y) in [(2, 2), (477, 2), (240, 120), (2, 237), (477, 237)] {
            assert!(is_black(image.get_pixel(x, y)), "({x}, {y})");
        }
    }

    #[test]
    fn a_rotated_page_renders_turned_a_quarter_clockwise() {
        let image = decode(&render_png(&sample(), request(2, 480)).unwrap());
        assert_eq!(image.dimensions(), (480, 960));
        // The page's left half turns into the top half.
        assert!(is_black(image.get_pixel(240, 200)));
        assert!(is_white(image.get_pixel(240, 760)));
    }

    #[test]
    fn only_the_crop_box_renders() {
        let image = decode(&render_png(&sample(), request(3, 480)).unwrap());
        assert_eq!(image.dimensions(), (480, 240));
        for (x, y) in [(2, 2), (477, 2), (240, 120), (2, 237), (477, 237)] {
            assert!(is_black(image.get_pixel(x, y)), "({x}, {y})");
        }
    }

    #[test]
    fn a_page_past_the_last_is_out_of_range() {
        assert!(matches!(
            render_png(&sample(), request(4, 480)),
            Err(PdfError::PageOutOfRange { page: 4, count: 3 })
        ));
    }

    #[test]
    fn non_pdf_bytes_and_empty_documents_are_invalid() {
        for bytes in [&b""[..], b"\x89PNG\r\n\x1a\n", b"%PDF-1.4\nnot really\n"] {
            assert!(
                matches!(page_boxes(bytes), Err(PdfError::Invalid(_))),
                "{bytes:?}"
            );
            assert!(matches!(
                render_png(bytes, request(1, 480)),
                Err(PdfError::Invalid(_))
            ));
        }
        assert!(matches!(page_boxes(&pdf(&[])), Err(PdfError::Invalid(_))));
    }

    /// A one-page PDF written by CoreGraphics itself, encrypted with the
    /// given passwords.
    fn encrypted(user_password: &str, owner_password: &str) -> Vec<u8> {
        use objc2_core_foundation::CFDictionary;
        use objc2_core_graphics::{
            kCGPDFContextOwnerPassword, kCGPDFContextUserPassword, CGDataConsumer,
            CGPDFContextBeginPage, CGPDFContextClose, CGPDFContextCreate, CGPDFContextEndPage,
        };
        let data = CFMutableData::new(None, 0).unwrap();
        let consumer = CGDataConsumer::with_cf_data(Some(&data)).unwrap();
        let user = CFString::from_str(user_password);
        let owner = CFString::from_str(owner_password);
        // SAFETY: reading immutable CoreGraphics constants.
        let keys = unsafe { [kCGPDFContextUserPassword, kCGPDFContextOwnerPassword] };
        let options = CFDictionary::from_slices(&keys, &[&*user, &*owner]);
        let media = CGRect::new(CGPoint::ZERO, CGSize::new(200.0, 100.0));
        // SAFETY: `media` outlives the call, and the options dictionary maps
        // CFString keys to CFString values as CGPDFContextCreate expects.
        let context =
            unsafe { CGPDFContextCreate(Some(&consumer), &media, Some(options.as_opaque())) }
                .unwrap();
        // SAFETY: no page-info dictionary is passed.
        unsafe { CGPDFContextBeginPage(Some(&context), None) };
        CGContext::set_rgb_fill_color(Some(&context), 0.0, 0.0, 0.0, 1.0);
        CGContext::fill_rect(Some(&context), media);
        CGPDFContextEndPage(Some(&context));
        CGPDFContextClose(Some(&context));
        drop(context);
        data.to_vec()
    }

    #[test]
    fn a_user_password_locks_the_document_and_an_owner_password_alone_does_not() {
        let locked = encrypted("secret", "owner");
        assert!(matches!(page_boxes(&locked), Err(PdfError::Locked)));
        assert!(matches!(
            render_png(&locked, request(1, 480)),
            Err(PdfError::Locked)
        ));

        let restricted = encrypted("", "owner");
        assert_eq!(page_boxes(&restricted).unwrap().len(), 1);
        let image = decode(&render_png(&restricted, request(1, 480)).unwrap());
        assert_eq!(image.dimensions(), (480, 240));
        assert!(is_black(image.get_pixel(240, 120)));
    }
}
