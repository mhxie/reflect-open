# Plan 25 — Inline PDF embeds

**Goal:** a PDF attached to a note renders *in the note* as a glance: a box exactly
one page tall that scrolls page by page, resizable with its aspect ratio locked. No
separate viewer, no text selection. Double-click (or `Enter` on the selected embed)
opens the PDF in the default app, as the file pill does today.

**Depends on:** Meowdown's `mdImage` mark view (sizing, magic comments, wiki-embed
sizing), the `reflect-asset://` protocol (`fs/asset_protocol.rs`), the attachment
catalog and resolvers in `@reflect/core` (`graph/attachment-resolution.ts`).

**Platforms:** macOS only. Pages are rasterized natively by CoreGraphics. iOS and
every other target show a "can't preview" card; there is no iOS-specific work.

## Resolved decisions

- **No text selection, search, or links inside the embed.** Pages are images. This
  removes pdf.js (worker, CMaps, CSP changes) from the design.
- **Dropping or attaching a PDF embeds it** (`![](assets/paper.pdf)`), like an image.
  A plain link `[paper.pdf](…)` or `[[paper.pdf]]` stays a file pill.
- **One size control.** The box keeps page 1's aspect ratio; dragging the handle
  changes width and height together, exactly as images resize today.
- **The box shows one full page.** Its height is one page at the current width;
  scrolling snaps page to page. Pages with a different shape fit inside the box
  (letterboxed).
- **Rendering engine: CoreGraphics in Rust**, served as PNG through
  `reflect-asset://`. Rust owns the capability (rasterize page N at width W); TS
  owns the policy (which attachments embed).
- **macOS only.** iOS is out of scope.
- **Forks only, no upstream changes.** The Meowdown change lives on a branch in
  `mhxie/meowdown`; the Reflect change lives in `mhxie/reflect-open`. Nothing is
  proposed to `prosekit/meowdown` or `team-reflect/reflect-open`, and nothing is
  published to npm.
- **Local-only PDFs are cached like any other.** "Local-only" promises never synced,
  sent, published, or written (`graph/local-only.ts`), not "no derived data on disk":
  `.reflect/index.sqlite` already holds local-only notes' text, and `.reflect/` is
  excluded from git, iCloud, backups, and Dropbox/File Provider (`fs/io.rs`).
- **Unsized default is the image rule** (height capped at 500 px): a US Letter page
  starts at about 386×500, a glance that doesn't compete with the editor's 42rem
  column. One drag persists a larger size.

## Markdown contract

| Source | Renders as |
|---|---|
| `![](assets/paper.pdf)` | PDF embed |
| `![[paper.pdf]]` | PDF embed (Obsidian syntax) |
| `[paper.pdf](assets/paper.pdf)`, `[[paper.pdf]]` | File pill (unchanged) |

Size persists exactly like an image, so nothing new round-trips:

- `![](assets/paper.pdf)<!-- {"width":480,"height":621} -->`
- `![[paper.pdf|480x621]]`

Both dimensions are written (height is derivable but persisting it lets Meowdown
reserve a sized placeholder before the page info loads, with no layout shift). An
unsized embed uses the image default: natural page size in points, height capped at
500 px, never upscaled.

## Part A — Meowdown (branch in the fork `mhxie/meowdown`)

Meowdown stays PDF-agnostic. Two small, generic additions (kept generic so they
could be offered upstream later):

1. **Host-rendered embeds in the image mark view** (`packages/core/src/extensions/image.ts`).
   - New `ImageOptions.resolveEmbed?: EmbedResolver`, where
     `EmbedResolver = (src) => HostEmbed | undefined | Promise<HostEmbed | undefined>`
     and `HostEmbed = { element: HTMLElement; width: number; height: number; destroy?(): void }`
     (`width`/`height` are the intrinsic size used for the ratio and the unsized default).
   - `#mountPreview` consults `resolveEmbed` before `resolveImageUrl`. A hit builds the
     same `prosekit-resizable-root` + handle as `#buildResizableImage`, sets
     `data-aspect-ratio`, and puts `element` where the `<img>` would go. Resize
     commits through the existing `commitImageSize` (magic comment or `|WxH`).
   - Sizing: `applyImageDisplaySize` reads `naturalWidth/Height` off an `<img>`, so add
     a sibling that takes the intrinsic size from `HostEmbed` (same rules: persisted
     wins, height capped at `MAX_DISPLAY_HEIGHT`, never upscaled). `update()`'s
     width/height branch must use it for host embeds instead of bare `applySize`.
   - The async path reuses the persisted-size placeholder. `destroy()` is called from
     the mark view's `destroy`.
   - `@meowdown/react`: pass `resolveEmbed` through `MeowdownEditor` like `resolveImageUrl`.
2. **Host choice of embed vs link on paste/drop** (`file-paste.ts`).
   - New `FilePasteOptions.shouldEmbedFile?: (file: { name: string; type?: string }) => boolean`,
     defaulting to today's `isImageFile`. `buildFileMarkdown` takes the same predicate
     so host commands (Reflect's attach picker) stay byte-identical with paste/drop.

Wiki embeds need no API change: Reflect's `resolveWikiEmbed` returns
`{ kind: 'image', src }` for a PDF, which routes it into the same mark view.

Clicks need no API change. `image-click.ts` resolves the preview's `<img>`, and the
page images are `<img>`s, so `onImageClick` fires with the markdown `src`; Reflect
ignores a mouse click on a PDF (meowdown consumes it, so it neither moves the caret
nor selects the embed; arrow keys select it, as with images) and opens it on a
`KeyboardEvent` (`Enter` on the selected embed). ProseMirror reports only single clicks to
`handleClick`, so a double-click is handled by the embed element's own `dblclick`
listener.

Tests (browser, in Meowdown): sync and async `resolveEmbed`, persisted-size
placeholder, ratio-locked resize writing both syntaxes, `update()` resizing a host
embed, `destroy` on removal and on `src` change, `shouldEmbedFile` on paste/drop.
No changeset: the fork's `release.yml` publishes to npm on pushes to `master`, so the
work stays on a feature branch there and is never merged into the fork's `master`
while that workflow is enabled.

### Installing the fork in Reflect: vendored tarballs

A git dependency does not work (`exports` point at an unbuilt `./dist`, and internal
deps are `workspace:*`), a `link:` only works on one machine, and pkg.pr.new or a
registry would be an external service. So Reflect vendors built tarballs:

- `apps/desktop/scripts/vendor-meowdown.mjs` builds `~/repos/meowdown` (or a path argument),
  runs `pnpm pack` for `@meowdown/core` and `@meowdown/react` only, and writes them to
  `vendor/meowdown/` named with the fork commit, e.g.
  `meowdown-core-0.78.1-<sha>.tgz`. `pnpm pack` rewrites `workspace:*` to concrete
  versions.
- `pnpm-workspace.yaml` `overrides` map `@meowdown/core` and `@meowdown/react` to
  `file:vendor/meowdown/…tgz`, following the commented example there.
  `@meowdown/markdown` (0.74.0) and `@meowdown/embed` (0.3.1) are unchanged and come
  from npm; Reflect's `@meowdown/markdown` range moves to `^0.74.0` (in `apps/desktop`
  and `packages/core`) so there is one copy.
- `react` depends on `core`, so the override is transitive; if pnpm refuses it,
  `blockExoticSubdeps: false` is set, as in the commented example. This relaxes a
  supply-chain guard; the exposure is bounded because the overrides are explicit and
  pinned to committed files. *Verify* whether it is actually required.
- Updating the fork means rerunning the script and committing the new tarballs.

## Part B — Rust primitive (`apps/desktop/src-tauri`)

New module `src/fs/pdf_render.rs`, compiled for `cfg(target_os = "macos")` with a
stub elsewhere (iOS, Linux) that returns an `unsupported` error. The stub keeps the
iOS build, the Linux CI build, and `cargo test --workspace` green.

- **`pdf_info(path, generation) -> { pages: [{ width, height }] }`** — a Tauri command.
  Page sizes in points from the crop box, with `/Rotate` applied. Errors are typed:
  `unsupported`, `locked` (password-protected), `invalid`. Before reporting
  `locked`, try `CGPDFDocumentUnlockWithPassword("")`: PDFs with an empty user
  password are common and render normally.
  Path rules match `asset_open`: `ensure_readable_attachment_path` + `resolve_read`
  (local-only folders are readable on-device; `asset_read`'s sharing gate does not
  apply because nothing leaves the device).
- **Page rasters through the existing protocol:**
  `reflect-asset://localhost/<generation>/<path>?reflect-preview=pdf-page&page=N&width=W`.
  `asset_protocol.rs` recognizes the query inside `serve`, after the generation
  check and `resolve_read`, and responds with a PNG rendered on the blocking pool it
  already uses. This is its own branch, not the raster-only gate (which matches
  `reflect-preview=raster` exactly); that is safe because Rust produced the PNG, and
  the PDF bytes never reach the webview. The branch sets `Content-Type: image/png`
  itself: the normal path sniffs with `MimeType::parse(&bytes, rel)`, and `rel` ends
  in `.pdf`.
- **Read the PDF through `serve`'s existing read path** (`read_bytes_no_follow` for
  local-only, `std::fs::read` otherwise) and build the `CGPDFDocument` from those
  bytes. Never `CGPDFDocumentCreateWithURL`, which would bypass the no-follow
  guarantee. Cap the input size.
- **Width buckets:** W is rounded up to one of a few sizes (e.g. 480, 960, 1440,
  1920, capped), so dragging the resize handle does not re-render continuously.
  The frontend requests `display width × devicePixelRatio`.
- **Cache:** rendered PNGs under `.reflect/cache/pdf-pages/`, keyed by
  the first 16 bytes of SHA-256 over (format version, path, size, mtime) + page +
  width, only for buckets actually requested.
  Written through `resolve_write` like the transcript cache (`fs/mod.rs:797`), so a
  symlinked cache directory cannot redirect writes into a local-only raw store.
  Bounded: a total size cap with a least-recently-used sweep at graph open, next to
  `sweep_upload_staging` (`fs/io.rs:198`). A 300-page PDF across several buckets can
  otherwise reach hundreds of MB.
- **Observability:** debug logs for render time and cache hit/miss, so slow
  rendering and cache churn can be told apart.
- **Concurrency:** a small semaphore (e.g. 2) around rendering so a note with
  several PDFs cannot saturate the CPU.
- **Dependencies:** `objc2-core-graphics` (already in `Cargo.lock` at 0.3.2,
  transitively) and `objc2-image-io` 0.3.2, added to the macOS-only dependency block
  in `Cargo.toml` with only the features used (`CGPDFDocument`, `CGPDFPage`,
  `CGContext`, `CGBitmapContext`, `CGColorSpace`, `CGImage`, `CGImageDestination`).
  *Verify* the exact feature names. Record them in `docs/plans/libraries.md`.
- **CSP:** none. Page images load through `img-src reflect-asset:`, already granted.

## Part C — TypeScript (`@reflect/core` + `apps/desktop`)

`@reflect/core`:
- `graph/attachment-resolution.ts`: `isPdfAttachmentPath`; `WikiEmbedTarget` gains
  `kind: 'pdf'`. Embedding policy lives here.
- `graph/commands.ts`: `pdfInfo(path, generation)` with a zod schema for the reply
  and the typed errors.

`apps/desktop/src/editor/`:
- `use-note-attachments.ts`: `resolveEmbed(src)` for PDF paths returns a `HostEmbed`
  whose size comes from `pdfInfo` page 1 (TanStack Query, keyed by generation + path
  + size + `modifiedMs`; the attachment catalog keeps only `size` today, so it gains
  `modifiedMs` from `FileMeta`). `resolveImageUrl` returns `undefined` for PDFs so they
  never reach an `<img>` as raw bytes. `resolveWikiEmbed` maps `pdf` to `{ kind: 'image' }`.
- `pdf-embed-element.ts` (framework-free DOM, no React root per embed): a scroll
  container with `scroll-snap-type: y mandatory`, one `<img loading="lazy"
  decoding="async">` per page sized from `pdfInfo`, `object-fit: contain`. A
  `ResizeObserver` picks the width bucket; on a change, only pages within a few of
  the visible one swap `src` (the rest swap as they scroll into view), so resizing a
  300-page PDF is not 300 refetches. Error states (`unsupported`, `locked`,
  `invalid`, missing file) render a small card inside the box that names the error
  and offers "Open in default app". A subtle `3 / 12` page indicator
  appears on hover.
- `note-editor.tsx`: pass `resolveEmbed` and `shouldEmbedFile` (images + PDFs).
  `handleImageClick` branches on a PDF `src` *before* calling `resolveImageUrl` (which
  now returns `undefined` for PDFs, and the handler bails on `undefined`):
  `Enter` goes to `openAsset` (a double-click opens through the embed's own
  listener), a single click is ignored.
- `lib/attach-files.ts`: build markdown with Meowdown's `buildFileMarkdown`, embedding
  PDFs; other picked files keep their `[name](assets/…)` link as before.
- `editor/formatting-toolbar-bridge.tsx`: the toolbar's attach button uses the same
  `shouldEmbedFile` as paste/drop.
- `dev/dev-bridge.ts`: `pdf_info` answers `unsupported` (browser dev shows the card).

Scrolling past the last page continues scrolling the note (browser default
`overscroll-behavior`). On iOS, `pdf_info` answers `unsupported`, so a PDF embed shows
the "can't preview" card with the file name and no open action.

## Phases

1. **Meowdown fork** — Part A on a branch in `mhxie/meowdown`, with tests; then the
   vendor script and the overrides in Reflect.
2. **Rust primitive** — Part B. Unit tests for page sizing, rotation, buckets, cache
   keys, and the protocol query parse. Rendering tests are macOS-only, so add a
   `cargo test -p reflect-open pdf_render` step to the `apple-lint` job (macOS).
3. **Reflect wiring** — Part C, against the linked Meowdown. Browser tests with a
   mocked `pdfInfo` and page URLs: embed vs pill classification, paste/drop and
   attach picker markdown, resize round-trip, error cards, click opens the asset.
4. **Verification** — `pnpm check`, targeted tests, then manual runs on
   `pnpm tauri:dev`: a 300-page PDF, mixed page sizes,
   rotated pages, an encrypted PDF, an iCloud-evicted file, a local-only folder,
   undo after resize, and a note with several embeds.

## Out of scope

- **Second-window reading** (⌘-click opens the PDF next to the note); it needs a
  full viewer.
- **Read-only previews.** Notes shown through `MarkdownPreview` (local-only notes,
  protected notes) render no PDF box; `resolveImageUrl` returns nothing for a PDF.
- **Remote PDFs** (`![](https://…/x.pdf)`) are not previewed.
- **iOS.**
