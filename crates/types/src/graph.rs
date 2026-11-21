//! Graph, note, and window command results.

use serde::{Deserialize, Serialize};

/// Identity of an open graph, returned to the frontend.
#[derive(Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct GraphInfo {
    /// Absolute path of the graph root.
    pub root: String,
    /// Display name (the root folder name).
    pub name: String,
    /// Open-session generation, bumped on every graph open. Mutating file
    /// commands echo it back and are rejected when stale, so a write enqueued
    /// for one graph can never land in another graph's same-named file.
    pub generation: u64,
    /// The local-only folder names configured for this graph (empty when
    /// none): notes inside them are private everywhere, and read-only unless
    /// every one of these names on their path is also editable.
    pub local_only_folders: Vec<String>,
    /// The local-only folder names this graph edits in place (a subset of
    /// `local_only_folders`; empty when every local-only folder is
    /// read-only, which is all a phone, an unknown configuration, or a too
    /// broad rawRoot ever gets).
    pub local_only_editable_folders: Vec<String>,
    /// Problems with that configuration the user must see (dropped names,
    /// an unusable rawRoot, an unreadable settings file); empty when none.
    pub local_only_warnings: Vec<String>,
    /// Problems with the graph's backup settings the user must see (a size
    /// limit out of range, a malformed accepted history root, a key naming a
    /// missing folder); empty when none.
    pub backup_warnings: Vec<String>,
}

/// Result of claiming a note path without overwriting an existing file.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum NoteCreateOutcome {
    /// The path was free and now contains the supplied bytes.
    Created { modified_ms: Option<u64> },
    /// A file or iCloud eviction placeholder already owns the path.
    Collision,
}

/// How a local note read (the desktop `note_read_local` command) found the
/// note on disk.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum LocalNoteRead {
    /// The bytes are local; here they are. `local_only` reports whether the
    /// note lies in a local-only folder, decided by the entry the path
    /// resolves to: bulk passes fold text across notes (asset descriptions
    /// into the notes that embed them) and must not carry it out of one.
    Content { content: String, local_only: bool },
    /// The note is iCloud-evicted (a dataless file, or an `.icloud` stub in
    /// the logical path's place). Reading it would block on an on-demand
    /// download — this command refuses instead.
    Evicted,
}

/// How a shareable note read (the `note_read_shareable` command) found the
/// note.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum ShareableNoteRead {
    /// The note may leave this machine; here are its bytes.
    Content { content: String },
    /// The note lies in a local-only folder, by its requested path or by the
    /// entry the filesystem resolves it to. Nothing was read.
    LocalOnly,
}

/// Where `note_delete` put the note.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct NoteDeleteOutcome {
    pub trashed: Trashed,
}

/// Which trash holds a deleted note.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum Trashed {
    /// The system Trash (desktop): Finder's Put Back restores it.
    System,
    /// The graph's own `.reflect/trash/`: mobile has no system Trash, and a
    /// local-only note stays there when the system Trash refuses it.
    Graph,
}

/// What a note write left on disk.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct NoteWriteOutcome {
    /// The note's on-disk mtime (epoch ms) after the call.
    pub modified_ms: Option<u64>,
    /// The full note text now on disk, when the note had moved past the
    /// expected revision and the file holds something other than `contents`.
    pub merged: Option<String>,
}

/// Counts from the vault catalog. `skipped` is what the walk refused or
/// failed to list (unreadable directories, symlinks, default-pruned trees) —
/// the number that keeps "why isn't my file showing up" diagnosable.
#[derive(Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct VaultScanStats {
    pub notes: u32,
    pub attachments: u32,
    pub skipped: u32,
}

/// A previously-opened graph, newest first in the stored list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct RecentGraph {
    pub root: String,
    pub name: String,
    pub opened_ms: u64,
}

/// What a secondary window needs to boot: the open graph's identity (both
/// session generations, unbumped) and the deep link it was created to show.
#[derive(Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct WindowBootstrap {
    pub graph: GraphInfo,
    /// The open index session's generation, or null when the main window's
    /// index failed to open (the note window then boots without index reads).
    pub index_generation: Option<u64>,
    /// The `reflect://` link this window was opened for — one-shot, absent on
    /// a reload (the router simply stays where the reloaded window was).
    pub initial_deep_link: Option<String>,
}

#[cfg(test)]
mod note_create_tests {
    use serde_json::json;

    use super::NoteCreateOutcome;

    #[test]
    fn outcome_serializes_for_the_typescript_boundary() {
        assert_eq!(
            serde_json::to_value(NoteCreateOutcome::Created {
                modified_ms: Some(1_234),
            })
            .unwrap(),
            json!({ "kind": "created", "modifiedMs": 1_234 })
        );
        assert_eq!(
            serde_json::to_value(NoteCreateOutcome::Collision).unwrap(),
            json!({ "kind": "collision" })
        );
    }
}
