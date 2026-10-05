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

## Reading and navigation

- **Editor aids:** a heading outline and quick jumps, plus live character and
  selection counts and the note's last edit time.
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
- **Attachment browsing:** an attachment library with image/PDF previews,
  type/tag filters, and source-note links; image/PDF galleries in All Notes.
- **Wiki browser:** browse entries by topic and language, with claim and
  review signals and links to specific headings.

## Local search and private work

- **Multilingual search:** CJK-aware lexical matching, local EmbeddingGemma
  embeddings, and semantic/hybrid CLI search through the running desktop app.
- **Local-only folders:** configurable read-only folders, plus in-place
  editing on Mac with local attachment storage and unsaved-text recovery;
  their content stays out of AI and Git backup.

## Git backup

- **Git backup protection:** preserve uncommitted notes and open edits during
  pulls, refuse stale writes, and configure backup file-size limits per graph.

See the [release notes](../apps/desktop/CHANGELOG.md) for version history and
[feature plans](plans/) for implementation details.
