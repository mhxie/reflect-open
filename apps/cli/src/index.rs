//! Read-only access to `.reflect/index.sqlite` plus staleness detection.
//!
//! The CLI never writes: connections open `SQLITE_OPEN_READ_ONLY` with
//! `query_only` belt-and-braces and a busy timeout to coexist with the desktop
//! writer (the DB is WAL). Staleness uses the indexer's content SHA-256 as the
//! truth (sync providers rewrite mtimes, so an mtime mismatch alone must not
//! flag), gated on mtime divergence for speed. The gate is deliberately
//! cheaper than the desktop's `reconcileIndex`, which hashes every file on
//! open: this check runs per `search` invocation, and the accepted cost is
//! that an external edit preserving a file's mtime goes unwarned.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use reflect_graph_paths::LocalOnlyFolders;
use rusqlite::{Connection, OpenFlags};

use reflect_index_schema::cjk::has_column;
use reflect_index_schema::{
    INDEX_FILE, LATEST_SCHEMA_VERSION, LOCAL_ONLY_FOLDERS_KEY, REFLECT_DIR,
};

use crate::error::CliError;
use crate::hash::hash_content;
use crate::note_file::{read_note_text, walk_notes};

/// A successfully-opened read-only index.
pub struct OpenIndex {
    pub conn: Connection,
    /// The index was written by a newer schema than this CLI knows — queries
    /// against the stable subset are attempted, but callers should warn.
    pub newer_schema: bool,
    /// The index has the `search_fts.cjk` column; one the app hasn't migrated
    /// since that migration lacks it.
    pub cjk_column: bool,
}

/// The three ways opening can go; callers decide how each degrades per command
/// (`search` needs the index; `show`/`path`/`open` fall back to scanning files
/// only when it is missing, and refuse when it is unusable).
pub enum IndexOpen {
    Opened(OpenIndex),
    /// No `.reflect/index.sqlite` on disk.
    Missing,
    /// Present but unopenable/unreadable (e.g. WAL recovery needs a writer).
    Unusable(String),
}

/// Open the graph's index strictly read-only.
pub fn open_read_only(root: &Path) -> IndexOpen {
    let file = root.join(REFLECT_DIR).join(INDEX_FILE);
    if !file.is_file() {
        return IndexOpen::Missing;
    }
    let conn = match Connection::open_with_flags(&file, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(conn) => conn,
        Err(err) => return IndexOpen::Unusable(format!("could not open the index: {err}")),
    };
    if let Err(err) = conn.busy_timeout(Duration::from_millis(2000)) {
        return IndexOpen::Unusable(format!("could not configure the index connection: {err}"));
    }
    if let Err(err) = conn.pragma_update(None, "query_only", true) {
        return IndexOpen::Unusable(format!("could not configure the index connection: {err}"));
    }
    // First actual read — a WAL that needs recovery surfaces here, not at open.
    let version: i64 = match conn.query_row("PRAGMA user_version", [], |row| row.get(0)) {
        Ok(version) => version,
        Err(err) => return IndexOpen::Unusable(format!("could not read the index: {err}")),
    };
    if version == 0 {
        return IndexOpen::Unusable("the index exists but has no schema yet".to_string());
    }
    let cjk_column = match has_column(&conn) {
        Ok(present) => present,
        Err(err) => return IndexOpen::Unusable(format!("could not read the index schema: {err}")),
    };
    IndexOpen::Opened(OpenIndex {
        conn,
        newer_schema: version > LATEST_SCHEMA_VERSION as i64,
        cjk_column,
    })
}

/// The graph's local-only folders as the desktop recorded them when it last
/// opened the index, kept as recorded like the desktop keeps them (even a
/// name today's rules refuse). Rows inside them are private, and a symlinked
/// folder is invisible to this CLI's own walk (it never follows symlinks).
/// `None` when none are configured, or the index predates the record. A
/// record that is present but unreadable refuses (exit 3): which notes are
/// local-only is then unknown.
pub fn local_only_folders(conn: &Connection) -> Result<Option<LocalOnlyFolders>, CliError> {
    let unknown = |detail: String| {
        CliError::Private(format!(
            "the index's record of local-only folders is unreadable ({detail}), so no note is \
             shown: open this graph in Reflect and follow its warning"
        ))
    };
    let raw: String = match conn.query_row(
        "SELECT value FROM index_meta WHERE key = ?1",
        [LOCAL_ONLY_FOLDERS_KEY],
        |row| row.get(0),
    ) {
        Ok(raw) => raw,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(err) => return Err(unknown(err.to_string())),
    };
    let names: Vec<String> = serde_json::from_str(&raw).map_err(|err| unknown(err.to_string()))?;
    Ok(LocalOnlyFolders::recorded(names, None))
}

/// How the index diverges from the files on disk.
#[derive(Debug, Default)]
pub struct Staleness {
    /// Files whose content hash no longer matches their indexed row.
    pub changed: usize,
    /// Files on disk with no index row.
    pub unindexed: usize,
    /// Index rows whose file is gone.
    pub deleted: usize,
}

impl Staleness {
    pub fn is_stale(&self) -> bool {
        self.total() > 0
    }

    pub fn total(&self) -> usize {
        self.changed + self.unindexed + self.deleted
    }
}

/// Compare the indexed rows against the files on disk. Only files whose mtime
/// diverges are hashed, so the check stays cheap on large graphs.
///
/// Local-only notes (`local_only`, from [`local_only_folders`]) are left out
/// on both sides: this walk cannot see inside a symlinked local-only folder,
/// so their rows would read as deleted forever — and counting them would
/// reveal how many exist.
pub fn detect_staleness(
    conn: &Connection,
    root: &Path,
    local_only: Option<&LocalOnlyFolders>,
) -> Result<Staleness, CliError> {
    let is_local_only = |path: &str| local_only.is_some_and(|folders| folders.contains(path));
    let mut indexed: HashMap<String, (i64, String)> = HashMap::new();
    let mut statement = conn.prepare("SELECT path, mtime, file_hash FROM notes")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (path, mtime, file_hash) = row?;
        if !is_local_only(&path) {
            indexed.insert(path, (mtime, file_hash));
        }
    }

    let mut staleness = Staleness::default();
    for note in walk_notes(root) {
        if is_local_only(&note.rel_path) {
            continue;
        }
        match indexed.remove(&note.rel_path) {
            None => {
                if !note.placeholder {
                    staleness.unindexed += 1;
                }
            }
            Some((mtime, file_hash)) => {
                if note.placeholder {
                    continue;
                }
                if note.mtime_ms as i64 != mtime {
                    let changed = match read_note_text(&root.join(&note.rel_path)) {
                        Ok(content) => hash_content(&content) != file_hash,
                        Err(_) => true,
                    };
                    if changed {
                        staleness.changed += 1;
                    }
                }
            }
        }
    }
    staleness.deleted = indexed.len();
    Ok(staleness)
}
