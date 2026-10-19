//! Names of the events the native side broadcasts to the frontend.

/// Batched [`crate::FileChange`]s for files that changed outside the editor.
pub const INDEX_CHANGED: &str = "index:changed";

/// Asks the frontend for one full reconcile pass. Carries no payload.
pub const INDEX_RECONCILE: &str = "index:reconcile";

/// Fired after a note-projection write commits. Secondary note windows run no
/// indexer of their own and refetch their index-backed queries on this signal.
pub const INDEX_WRITTEN: &str = "index:written";

/// Fired after a note's rows move to a new path (an in-app rename or an
/// id-healed external one), with `{ "from": ..., "to": ... }`.
pub const NOTE_MOVED: &str = "note:moved";

/// Fired for every entry a pull moved out of a path it wrote and left moved,
/// whether the pull succeeded or failed, with
/// `{ "generation": ..., "from": ..., "to": ..., "keptOut": ... }`: every
/// window's open editor on `from` decides whether to follow it to `to`.
pub const NOTE_DISPLACED: &str = "note:displaced";
