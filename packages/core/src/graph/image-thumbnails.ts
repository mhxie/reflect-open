/**
 * Image thumbnails for passive previews (the Attachments card flow): the
 * widths the `reflect-asset://` protocol renders thumbnails at. Requesting a
 * bucket instead of the exact display width keeps a thumbnail's URL stable
 * while its card is resized, so the webview and the thumbnail cache reuse it.
 */

/** Thumbnail widths in device pixels. Must match `fs/image_thumbnail.rs`. */
export const IMAGE_THUMBNAIL_WIDTH_BUCKETS: readonly number[] = [320, 640, 960, 1280]

/** The smallest bucket at least `pixels` wide, or the largest bucket. */
export function imageThumbnailWidthBucket(pixels: number): number {
  const largest = IMAGE_THUMBNAIL_WIDTH_BUCKETS.at(-1) ?? pixels
  return IMAGE_THUMBNAIL_WIDTH_BUCKETS.find((bucket) => bucket >= pixels) ?? largest
}
