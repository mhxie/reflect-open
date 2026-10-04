/**
 * Inline PDF previews (Plan 25): the raster widths the `reflect-asset://`
 * protocol renders PDF pages at. Requesting a bucket instead of the exact
 * display width keeps a page's URL stable while its box is resized, so the
 * webview and the render cache reuse it.
 */

/** Page raster widths in device pixels. Must match `fs/pdf_render.rs`. */
export const PDF_PAGE_WIDTH_BUCKETS: readonly number[] = [480, 960, 1440, 1920, 2560]

/** The smallest bucket at least `pixels` wide, or the largest bucket. */
export function pdfPageWidthBucket(pixels: number): number {
  const largest = PDF_PAGE_WIDTH_BUCKETS.at(-1) ?? pixels
  return PDF_PAGE_WIDTH_BUCKETS.find((bucket) => bucket >= pixels) ?? largest
}
