//! Names of the events the native side broadcasts to the frontend.

use serde::Serialize;

/// An event the native side broadcasts. The serde name is the wire name, and
/// `pnpm gen:types` exports it to TypeScript and Swift.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
pub enum EventName {
    /// Batched [`crate::FileChange`]s for files that changed outside the editor.
    #[serde(rename = "index:changed")]
    IndexChanged,
    /// Asks the frontend for one full reconcile pass. Carries no payload.
    #[serde(rename = "index:reconcile")]
    IndexReconcile,
    /// Fired after a note-projection write commits. Secondary note windows run
    /// no indexer of their own and refetch their index-backed queries on this
    /// signal.
    #[serde(rename = "index:written")]
    IndexWritten,
    /// Fired after a note's rows move to a new path (an in-app rename or an
    /// id-healed external one), with `{ "from": ..., "to": ... }`.
    #[serde(rename = "note:moved")]
    NoteMoved,
    /// Fired for every entry a pull moved out of a path it wrote and left
    /// moved, whether the pull succeeded or failed, with
    /// `{ "generation": ..., "from": ..., "to": ..., "keptOut": ... }`: every
    /// window's open editor on `from` decides whether to follow it to `to`.
    #[serde(rename = "note:displaced")]
    NoteDisplaced,
}

impl EventName {
    /// The wire name, the same string as the serde name.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::IndexChanged => "index:changed",
            Self::IndexReconcile => "index:reconcile",
            Self::IndexWritten => "index:written",
            Self::NoteMoved => "note:moved",
            Self::NoteDisplaced => "note:displaced",
        }
    }
}
