//! What a graph's index recorded about its local-only folders at its last
//! open, read back without migrating or writing anything: the graph-open
//! check that a configuration has not gone missing.

#![cfg(any(feature = "native", test))]

use std::path::Path;

use reflect_index_schema::{INDEX_FILE, LOCAL_ONLY_FOLDERS_KEY, REFLECT_DIR};

use reflect_types::{AppError, AppResult};

/// The local-only folder names an index recorded.
#[derive(Debug)]
pub enum LocalOnlyRecord {
    /// No index yet, or an index without a record: nothing to compare.
    Nothing,
    Names(Vec<String>),
    /// The record exists but cannot be read; `corrupt` when it does not parse.
    Unreadable {
        reason: String,
        corrupt: bool,
    },
}

/// Read the record of the index under `root`. A record that cannot be read
/// or parsed is reported as such (the caller fails closed), never as empty.
/// A stored value that is not UTF-8 text is damaged content, not a failed
/// read: it reads as empty, which does not parse.
pub fn recorded_local_only_folders(root: &Path) -> LocalOnlyRecord {
    let read = || -> AppResult<Option<String>> {
        let conn = reflect_index_schema::open_index_read_only_at(root)
            .map_err(|err| AppError::io(err.to_string()))?;
        match conn.query_row(
            "SELECT value FROM index_meta WHERE key = ?1",
            [LOCAL_ONLY_FOLDERS_KEY],
            |row| match row.get_ref(0)? {
                rusqlite::types::ValueRef::Text(text) => {
                    Ok(std::str::from_utf8(text).unwrap_or_default().to_string())
                }
                _ => Ok(String::new()),
            },
        ) {
            Ok(raw) => Ok(Some(raw)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(err) => Err(err.into()),
        }
    };
    if !root.join(REFLECT_DIR).join(INDEX_FILE).exists() {
        return LocalOnlyRecord::Nothing;
    }
    match read() {
        Ok(None) => LocalOnlyRecord::Nothing,
        Ok(Some(raw)) => match serde_json::from_str::<Vec<String>>(&raw) {
            Ok(names) => LocalOnlyRecord::Names(names),
            Err(err) => {
                tracing::warn!(%err, "the index's local-only folder record does not parse");
                LocalOnlyRecord::Unreadable {
                    reason: format!("the record does not parse: {err}"),
                    corrupt: true,
                }
            }
        },
        Err(err) => {
            tracing::warn!(?err, "could not read the index's local-only folder record");
            LocalOnlyRecord::Unreadable {
                reason: format!("{err:?}"),
                corrupt: false,
            }
        }
    }
}
