# 29: Inline note reading

A standalone `![[Example reference]]` paragraph shows a short Markdown preview in the note editor and read-only note surfaces. The reference accepts the usual alias, such as `![[Example reference|Read example]]`. Ordinary `[[links]]` and embeds mixed into prose retain their inline chips.

Click the preview, or activate it with the keyboard, to read the full source in place. The arrow opens the original note; Command or Control opens a secondary window where supported. The embedded body is read-only. Selecting and copying its full text uses the browser's native selection, while selecting and deleting the reference edits the containing note.

The preview shares the document's typography and left edge, without a frame or separate title bar. Its first 4096 characters render within 16em; overflowing text fades across the final 3.5em. A persistent Read full note label and downward chevron sit below the fade so the action stays legible. Hover and keyboard focus reveal the quiet Open original action, which remains visible on touch devices. Each embedding depth demotes real heading elements by one level, capped at H6: H1 becomes H2 in the first embed and H3 in a nested embed. Preview and full reading share this hierarchy; source Markdown and fragment targets remain intact. Touch controls stay at least 44px; fine pointers above the small-screen breakpoint use 32px controls.

## Ownership

Meowdown exposes the optional `renderNoteEmbed` callback on `MeowdownEditor` and `MarkdownView`. It supplies the canonical target and display label classified by `resolveWikiEmbed`. A paragraph NodeView keeps the source `contentDOM` separate from the non-editable reader; React portals retain the host's providers. Passive previews never mount readers. Markdown export continues to contain the authored `![[...]]` reference.

Reflect owns loading, collapse state, source links, attachments, and media privacy. Sources are resolved through existing-note APIs and read against a pinned graph generation, including the live buffer of an open document. The default excerpt is passive: it loads no images, attachments, or nested readers. Expansion reuses the loaded source and mounts the full reading surface. Source writes and file changes refresh both states. Collapse retires the full body's pending attachment opens; unmounting or switching graphs retires pending source reads.

## Reading boundaries

The source note's frontmatter is omitted from the body. Its attachments resolve from its own folder after the attachment catalog is available; file pills and Markdown attachment links open through the existing native attachment action. Its wiki links, Markdown note links, and heading fragments retain their source context. Navigation only opens existing notes. Parent heading jumps exclude headings from expanded descendants.

Remote media follows both the containing note's policy and the embedded note's live private verdict, including optimistic Lock changes. Descendants inherit a restriction. Missing, ambiguous, or unavailable notes show a retry action. Resolved-path cycles and embeds beyond four levels show an Open note escape instead of loading another body.

The containing note's outline includes the complete source headings of each reader, even while its preview is collapsed. Embedded headings appear at the reference's position with the same demoted hierarchy as the reading surface. Choosing a hidden chapter expands that reader and scrolls to the chapter without moving the containing note's caret. Repeated references have independent targets; expanded nested readers contribute their headings and retire them on collapse. Embedding does not copy headings or summaries into the file. Existing wiki-link indexing continues to supply backlinks from the reference.

## Validation

Meowdown browser tests cover source preservation, valid block DOM, React providers, keyboard activation, native clipboard selection, reference deletion, resolver payloads, disposal, and passive/inline fallbacks. Reflect tests cover passive bounded previews, expansion without redundant reads, generation and unmount races, refresh, recursive reading, source navigation, heading scope, live media privacy, and embedded outline ordering and navigation. Both projects run their type and lint checks; Reflect also builds its desktop frontend and signed local desktop bundle. Fork packages are pinned under `vendor/meowdown/` with the renderer's source commit recorded in their filenames and provenance README.
