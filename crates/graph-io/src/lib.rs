//! Graph file IO with no Tauri in it: the open graph session, atomic note
//! writes, the traversal and local-only guards, the no-follow directory-fd
//! IO, the per-graph lock, the Reflect V1 import, the X archive store and the
//! conflict ladder. The shell decides the thread, the trash policy and how a
//! change reaches the frontend.

#[cfg(unix)]
pub mod beneath;
pub mod conflict;
pub mod displaced_revisions;
mod graph;
pub mod graph_gitignore;
mod graph_lock;
pub mod hash;
pub mod import;
pub mod import_assets;
pub mod io;
pub mod local_only_edit;
pub mod own_writes;
mod resolve;
pub mod x_archive_store;

pub use graph::*;
#[cfg(any(test, feature = "test-support"))]
pub use graph_lock::holders as graph_lock_holders;
pub use graph_lock::with_graph_lock;
pub use resolve::{
    EditTarget, LocalOnlyEntry, ReadTarget, TargetKind, ensure_relative, entry_is_local_only,
    resolve, resolve_note_edit, resolve_read, resolve_shareable, resolve_write,
};
