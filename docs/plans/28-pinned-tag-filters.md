# Custom pinned tag filters

Status: implemented on `feat/pinned-tag-filters-20261004`. Baseline: `8a506099`.

## Product goal

Let people choose and order their own one-click tag filters directly in desktop
All Notes. The default `#book`, `#link`, and `#person` filters become an obvious
starting set rather than an apparent fixed limit.

## Baseline behavior

- `allNotesFilterTags` already stores an ordered, unlimited list, including an
  intentional empty list (`packages/core/src/settings/schema.ts:199`).
- Settings → All Notes already supports normalized addition and removal, but
  offers no ordering controls (`apps/desktop/src/components/settings/all-notes-section.tsx:23`).
- All Notes renders the configured list; its `overflow-hidden` segmented bar
  can clip many or long labels (`apps/desktop/src/components/all-notes/all-notes-filters.tsx:56`).
- Custom selects a temporary tag filter and accepts typed names
  (`apps/desktop/src/components/all-notes/custom-filter-menu.tsx:36`).
- This menu also serves Wiki and Attachments. Pinned-filter management belongs
  only to All Notes.
- Preferences are app-wide and stored outside graphs
  (`apps/desktop/src-tauri/src/settings.rs:1`).
- Tag filtering is exact and case-insensitive. A selected tag includes regular
  and daily notes, although the suggestion facets come from regular notes
  (`packages/core/src/indexing/note-list.ts:155`, `:327`).

## Approved interaction

Keep **Custom** as the header's single entry point for selecting other tags and
managing pinned filters. Its normal view retains search, counts, and free entry.
Search should also find pinned tags, so a distant tab is reachable without
scrolling through the entire strip.

When the current filter is an unpinned tag, offer **Pin #tag** inside the menu.
The action appends a tab and keeps the current result set. The menu footer offers
**Manage pinned filters…**, which opens a management view in the same popover.

The management view has:

1. An ordered list of pinned tags. Each row has a **drag handle** on the left
   and a **⋯** action menu on the right. The menu contains **Move to top**,
   **Move up**, **Move down**, **Move to bottom**, and **Unpin**; impossible
   moves are disabled. Row labels are display text, not filter-selection actions.
2. A search/input field to add an existing or new valid tag. Suggestions come
   from the current graph; matching pinned names are labelled **Already pinned**.
3. An explicit **Pin #tag** action for valid free entry, including a tag with
   zero matching notes. New pins append to the list.
4. **Back** to the normal tag picker and **Done** to close. Menu actions apply
   and persist immediately; dragging persists once on drop through the existing
   settings path. No separate sorting mode or Apply button is needed.

### Ordering

The management list's top-to-bottom order maps to the filter bar's left-to-right
order. New pins append. Search filters only suggestions to add; it never hides
rows from the ordered pinned list.

Drag starts from the handle, with a lifted copy of the row and a clear insertion
line. The source remains as a subdued placeholder. Drop updates the list and
header together and saves once. Cancel restores the previous order. The header
tabs retain their normal selection and horizontal scrolling behavior.

The ⋯ menu offers equivalent click/tap moves so precise dragging is optional,
consistent with [WCAG 2.2 dragging-movement guidance](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html).
The grip and menu remain visible, with short tooltips and accessible names.

Selecting a tag changes the filter. Pinning changes the saved shortcut list.
Keep those as separate, labelled actions rather than nesting a pin button inside
a combobox option.

Unpinning the active tag keeps its results displayed, with that tag becoming the
Custom selection. An empty pinned list shows All, the enabled attachment filters,
and Custom. Existing users retain their configured list and order.

## Layout and keyboard behavior

Keep the bar on one line, with **All** fixed at the start and **Custom** fixed at
the end. The middle strip contains the active Edited date filter, pinned tags,
and existing attachment filters, and scrolls horizontally when needed. The
active tab comes into view after
selection or a pin action. Long labels truncate with their full accessible name
and a tooltip. The header can reflow the entire bar onto its own row at narrow
widths, alongside the existing New note action.

Use the existing shadcn Popover, Command, DropdownMenu, Input, Button, and Tooltip
primitives. Reuse the existing sortable dependency with a dedicated drag handle.
All actions work with Tab and Enter/Space; the normal picker retains arrow-key
selection. With focus on a reorder handle, Space/Enter picks up the tag, Up/Down
moves it, and Space/Enter drops it. Announce the tag's new position and keep
focus by its folded identity. Escape during a drag cancels the draft and keeps
management open. While idle, Escape closes the action menu first, then the
popover, restoring the corresponding trigger's focus.

Menu moves return focus to that tag's ⋯ trigger. Removing a focused row moves
focus to the next row's trigger, previous row, or input if the list is empty.
Popup content fits the viewport, with long pinned lists scrolling and edge
scrolling during a drag. Closing or dismissing management cancels an active drag.
An external pin-list update also cancels the draft and refreshes the list rather
than committing an outdated order.

## Persistence and scope

Reuse the app-wide ordered `allNotesFilterTags` array. It remains shared across
graphs; a pin can therefore show zero results in another graph and stays visible
and removable. A graph's facet refresh never removes configured pins.

Use the existing `foldTag` and `isTagName` contract for user input. Accept a
leading `#`, trim whitespace, prevent case-insensitive duplicates, and preserve
the saved order. Intentional `[]` stays empty across restarts. Use
`updateSettingsWith` to apply rapid actions to the latest settings; retain the
existing save-failure operation feedback. A save failure must not be presented
as durable success.

Settings → All Notes should reuse the same tag editor and mutation logic.
This proposal needs no SQLite or settings-format migration. Pin/unpin changes
preferences; note files remain the source of tag data, consistent with TDR 0004.

Initial scope is desktop All Notes and one tag filter at a time. Compound tag
queries, graph-specific pins, tag renaming, and additional numeric shortcuts
would require separate product decisions.

## Decisions

The user chose management inside Custom. The interaction sketch now focuses on
that entry point and drag-handle ordering with a row action menu.

Measured overflow into a More menu would require width measurement, resize
handling, and another selector. Prefer native horizontal scrolling initially.

## Observable completion criteria for implementation

- Add a fourth tag from All Notes, use its tab, and retain it after restart.
- Normalize `#Research` and `research` to one pin; reject invalid names.
- Pin a valid zero-result tag and retain it through graph switches and indexing.
- Reorder by drag, keyboard, and menu; persist the order and retain focus by tag.
- Cancel a drag without saving; keep management open and the current filter intact.
- Keep the complete pinned order visible while searching for tags to add.
- Unpin the active tag without changing the result set.
- Remove every pin, restart, and retain the empty list.
- With many pins, long CJK names, light/dark themes, and a narrow window, All and
  Custom remain reachable and the active filter remains visible.
- Settings and All Notes show the same pin list immediately.
- Save failures use existing operation feedback.
- Wiki and Attachments retain their current picker behavior.

Implementation verification should cover settings mutations, All Notes browser
flows in Chromium/WebKit, focus/reorder behavior, and existing filter-query
regressions, followed by `pnpm check` and `pnpm build`.

## Implementation

All Notes and Settings share the editor in `components/tag-filters/` and the
`usePinnedTagFilters` hook. Pure normalization and ordering rules live in
`@reflect/core` settings helpers; the existing settings array remains unchanged.
Pointer sessions are owned from pointerdown, including the interval before the
drag threshold, so dismissal cannot leave a sensor intercepting later clicks.

The README keeps a short fork overview. Supported additions and their controls
live in the [fork feature guide](../fork-features.md), grouped by workflow.

Validation: `pnpm check`, `pnpm build`, four core tests, 58 Settings tests per
browser, and 101 All Notes/settings-provider/Wiki/Attachments tests per browser
passed in Chromium and WebKit. Browser coverage includes pending-pointer
teardown, keyboard cancellation, tooltip dismissal, external updates, focus,
and narrow layouts.
