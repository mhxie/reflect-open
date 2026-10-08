# Fork feature guide

Supported additions to upstream Reflect, grouped by workflow. Keep feature details
here as the fork grows; the [README](../README.md#this-fork) remains a short overview.

## Daily work and capture

- **Daily workspace:** a journaling heatmap with edited-note previews,
  "On this day" entries from earlier years, and due/overdue tasks in the sidebar.
- **File capture:** drop files onto the sidebar to create a note with their
  attachments.
- **Mac audio:** on-device audio memo transcription and meeting recording
  with microphone/system audio capture on macOS 14.2+.
- **Activity tray:** background work (transcription, indexing, summaries) shows
  in a quiet tray at the foot of the sidebar.

## Reading and navigation

- **Editor aids:** a heading outline and quick jumps, plus live character and
  selection counts and the note's last edit time.
- **Note state:** one subdued glyph in note lists (excluding pins) and one word
  in the editor's single-row footer. Open it for editing, privacy, AI, Git
  backup, graph sync, and the note's last committed short Git SHA. Private
  notes still support Git backup; Local-only notes stay excluded.
  Protected details explain the cause and offer conflict resolution, save retry,
  or revealing unsupported Markdown in the desktop file manager.
- **Hidden sidebar on hover:** with the sidebar hidden (`⌘\`), rest the pointer
  on the window's leading edge to float it over the content. Shift-click a
  pinned row to Peek it; its context menu also opens it in a new window,
  copies a deep link, or reveals it in Finder.
- **Pinned note shortcuts:** `⌘1`–`⌘9` and `⌘0` open the first ten pinned notes
  in sidebar order, with floating hints on hover and keyboard focus.
- **Pinned tag filters:** use **Custom → Manage pinned filters…** in All Notes
  to add any number of tags, including tags with no matching notes. Drag a row
  by its handle or use its **⋯** menu to move or unpin it. From a focused handle,
  Space/Enter picks up, ↑/↓ moves, Space/Enter saves, and Escape cancels.
  The list order controls tab order; new pins append. Unpinning the active tag
  keeps its results. **Settings → All Notes** edits the same app-wide list.
- **Peek and PDFs on Mac:** open notes and PDFs over the current editor, and read
  PDFs inline as scrollable page previews.
- **Embedded notes:** read an embedded note in place and jump to its headings
  without leaving the host note.
- **All Notes:** sort by title or last updated, filter by attachment type, and
  read a one-sentence AI summary in place of the opening text of long notes
  (Settings → All Notes → AI summaries; on-device only by default).
- **Attachment browsing:** an attachment library with image/PDF previews,
  type/tag filters, and source-note links; image/PDF galleries in All Notes.
- **Wiki browser:** browse entries by topic and language, with claim and
  review signals and links to specific headings. Index notes are told apart
  from articles and can be filtered by role, and articles render with compact
  citations and their native-language titles.
- **Claim trust from your agent harness:** an agent harness (atelier or any
  other) publishes a trust report into the graph, and Reflect shows its
  verdicts on wiki claims; Reflect computes none of it. Settings → Wiki picks
  how trust shows while reading and where the report lives; the
  [harness guide](wiki-trust-harness.md) is the whole contract. The Wiki
  screen's Review column still reads `@pass` records until it moves to the
  report.

## Local search and private work

- **Multilingual search:** CJK-aware lexical matching, local EmbeddingGemma
  embeddings, and semantic/hybrid CLI search through the running desktop app.
- **On-device AI:** configure loopback-only models running on this Mac, and use
  a verified on-device model to search private notes and OCR attachments
  without anything leaving the device.
- **Local-only folders:** configurable read-only folders, plus in-place
  editing on Mac with local attachment storage and unsaved-text recovery;
  their content stays out of AI and Git backup.

## Git backup

- **Git backup protection:** preserve uncommitted notes and open edits during
  pulls, refuse stale writes, and configure backup file-size limits per graph.
  Sync pauses rather than joining a remote history this graph has not
  accepted.

See the [release notes](../apps/desktop/CHANGELOG.md) for version history and
[feature plans](plans/) for implementation details.
