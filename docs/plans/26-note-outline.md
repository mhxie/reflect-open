# Plan 26 — Note outline

**Goal:** see a long note's structure at a glance and jump to any section. The open
note's headings are listed in the context sidebar, with the section being read
highlighted as the note scrolls; clicking one brings that heading to the top of the
note with the caret on it. "Jump to heading…" in the ⌘K palette does the same from
the keyboard.

**Depends on:** the context sidebar's section stack (`components/context-sidebar/`),
the command registry (Plan 08), and Meowdown's ProseKit editor.

**Platforms:** desktop, `note` route only. The daily stream and mobile are out of scope
for now.

## Resolved decisions

- **A sidebar section, not a new surface.** The right context sidebar already sits
  beside every note, so the outline adds no chrome that competes with the editor
  (Minimal UI). Google-Docs-style pinned panes, VS Code-style minimaps (prose at 1/10
  scale is unreadable) and heading rails in the margin were all considered. A rail
  cannot fit the 2rem gutter of full-width notes, which the block handle already uses
  for hover.
- **Keyboard-native.** "Jump to heading…" (`outline.jumpToHeading`) opens a cmdk picker
  over the same outline: filter by heading text, Enter to jump, Escape back to the
  editor. It has no default binding; it is reachable from ⌘K.
- **Headings come from the live editor, never the index.** The index lags typing, and a
  jump needs exact editor positions, so duplicate heading texts stay distinct.
  Meowdown's `revealHeading` matches by text and always finds the first of two
  same-named headings, so it is not used.
- **What is listed:** top-level headings only, as displayed (inline syntax omitted).
  - A leading H1 is the note's title (where the "Untitled" placeholder sits) and is
    left out. Later H1s are sections.
  - Empty headings, and headings nested in lists or blockquotes, are left out.
  - Rows indent by level relative to the shallowest level present, capped at three
    steps.
  - The section renders once one heading remains.
- **Placement:** after Published URL, before Similar notes.
- **Jumps land at the top.** The heading's top edge is placed 16px below the note's
  scroll container, not where ProseMirror's minimal `scrollIntoView` would leave it.
  - The caret moves into the heading and the editor takes focus. Clicking a row counts
    as choosing where to keep writing.
  - **Tail space.** When the content after a heading is too short to scroll it to the
    top, a blank tail grows under the note (`[data-outline-tail-space]::after`). It
    only grows, and is removed when the note closes.
  - **Layout shifts.** For up to 5s after a jump, the heading is re-aligned every
    frame while content above it settles (images, PDF previews, link cards). Scrolling,
    typing or clicking ends this early.
  - **Document changes.** The jump follows its heading by index through document
    changes that only shift positions. Settling content can write to the document:
    Meowdown persists a resolved link-card snapshot outside history. A change to the
    heading's text or level, or a heading count that no longer reaches its index, ends
    the jump.
- **Scroll-spy:** the active section is the last heading at or above a line 25% down
  the scroll container (at least 32px). Above the first heading nothing is active.
  Scrolled to the very end, the last section is active, except with tail space, where
  being at the end is the jump's doing.
- **`@prosekit/core` becomes a direct dependency** for `defineDocChangeHandler`.
  Meowdown's `onDocChange` skips programmatic `setMarkdown` (external reloads), which
  must still refresh the outline. A MutationObserver would read the state one
  keystroke stale (DOM mutations precede ProseMirror's deferred flush). The range must
  track `@meowdown/react`'s, so pnpm keeps a single copy. A second copy would break
  `useExtension` at runtime, not at typecheck; the bridge's `setMarkdown` test catches
  that.

## Shape

| Piece | Where | Role |
| --- | --- | --- |
| `readOutlineHeadings`, `outlineDepths` | `editor/outline/outline-headings.ts` | Pure: ProseMirror doc → section headings; indent depths |
| Outline store | `editor/outline/outline-store.ts` | Module store keyed by note path, owner-token guarded (the `editor-handle-registry` rule) |
| Scroll geometry | `editor/outline/outline-scroll.ts` | Scroll-container lookup, align-to-top with tail space, binary-search scroll-spy |
| `OutlineBridge` | `editor/outline/outline-bridge.tsx` | Inside the editor's ProseKit context (like `FormattingToolbarBridge`): publishes headings, active section and `reveal` |
| `OutlineSection` | `components/context-sidebar/outline-section.tsx` | The sidebar rows |
| `HeadingPicker` + provider | `components/outline/`, `providers/heading-picker-provider.tsx` | The palette command's dialog; modal for app shortcuts |

`NotePane` mounts the bridge when given `outline`, which only `SingleNoteView` passes.
That covers the note route and the secondary note window. The note window has no
sidebar or palette, so nothing reads its outline there.

## Views

| View | Sidebar outline | Jump to heading |
| --- | --- | --- |
| Note, default width | yes | yes |
| Note, full-width notes | yes (the sidebar is its own column) | yes |
| Sidebar collapsed (⌘\\) or window narrower than `lg` | no (the context sidebar is hidden) | yes |
| Daily stream | no | no (the command is a no-op) |
| Secondary note window | no | no (no palette) |
| Local-only / protected (read-only) notes | no (no editor instance) | empty state |

## Later

- The daily stream: follow the focused day like the rest of the daily sidebar. This
  needs scroll-spy inside the virtualized stream.
- An outline while the sidebar is collapsed: a floating button over the note's right
  edge that opens the outline in a popover.
- Folding sections from the outline: needs heading folding in Meowdown, which today
  only folds list items.
- Mobile: a sheet listing headings from the note header's actions menu.
