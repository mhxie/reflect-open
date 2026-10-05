//! The five commands. Shared rules live here: stdout carries only data,
//! warnings go to stderr, and `show`/`path`/`open` degrade to a file scan
//! when the index is missing (`search` is the one command that requires
//! it), taking the local-only folders from the desktop's settings then. An
//! index that exists but cannot be read refuses them instead.

pub mod open;
pub mod path;
pub mod search;
pub mod show;
pub mod today;

mod output;

use std::fmt::Display;
use std::path::Path;

use reflect_graph_paths::LocalOnlyFolders;

use crate::error::CliError;
use crate::index::{local_only_folders, open_read_only, IndexOpen, OpenIndex};
use crate::local_only_settings::configured_local_only_folders;

fn warn(message: impl Display) {
    eprintln!("reflect: warning: {message}");
}

/// The local-only folders an opened index records. Without an index there is
/// no record, so the desktop's settings answer instead: a symlinked folder is
/// invisible to this CLI anyway, but a real directory configured as
/// local-only would otherwise read like any other. An unreadable record or
/// settings document refuses (exit 3).
fn local_only_of(
    root: &Path,
    index: Option<&OpenIndex>,
) -> Result<Option<LocalOnlyFolders>, CliError> {
    match index {
        Some(open) => local_only_folders(&open.conn),
        None => configured_local_only_folders(root),
    }
}

/// Open the index for `show`/`path`/`open` resolution. A missing index is
/// not fatal there: resolution falls back to scanning the files. One that
/// exists but cannot be read (say, a write-ahead log only the app can
/// recover) refuses (exit 3), like an unreadable record: it may record
/// local-only folders this CLI cannot otherwise see.
fn open_index_for_resolution(root: &Path) -> Result<Option<OpenIndex>, CliError> {
    match open_read_only(root) {
        IndexOpen::Opened(open) => {
            if open.newer_schema {
                warn("the index schema is newer than this CLI — update Reflect");
            }
            Ok(Some(open))
        }
        IndexOpen::Missing => Ok(None),
        IndexOpen::Unusable(message) => Err(CliError::Private(format!(
            "{message}, so which notes are local-only is unknown and no note is shown: open \
             this graph in Reflect first"
        ))),
    }
}
