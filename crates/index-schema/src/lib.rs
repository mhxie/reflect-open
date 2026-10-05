//! Shared schema + migrations for `<graph>/.reflect/index.sqlite` (Plan 04/14).
//!
//! The desktop app (writer) and the `reflect` CLI (read-only) both depend on
//! this crate, so the schema can never skew between them. Everything that
//! creates or migrates the schema sits behind the `vec` feature — the vec0
//! virtual tables (Plan 09) require the sqlite-vec extension. Read-only
//! consumers build with `default-features = false` and get just the constants.
//!
//! `rusqlite_migration` tracks the applied version in SQLite's `user_version`
//! pragma. Append a new `M::up(include_str!(...))` (never edit a shipped one)
//! as later plans add tables — and bump [`LATEST_SCHEMA_VERSION`] with it.
//!
//! Almost every table is a rebuildable projection of the markdown — except
//! the `chat_*` tables (0008), which hold durable chat history. Wipe-style
//! migrations (0004, 0006) and `index_clear` must never touch them.

pub mod cjk;

/// Directory inside a graph that holds the index (and marks a dir as a graph).
pub const REFLECT_DIR: &str = ".reflect";

/// The index database's filename inside [`REFLECT_DIR`].
pub const INDEX_FILE: &str = "index.sqlite";

/// The Unix socket a running app answers `reflect search --mode
/// semantic|hybrid` on, inside [`REFLECT_DIR`].
pub const SEARCH_SOCKET_FILE: &str = "search.sock";

/// `sockaddr_un.sun_path` holds 104 bytes on macOS (108 on Linux), one of
/// them the terminating NUL.
pub const MAX_SOCKET_PATH_BYTES: usize = 103;

/// Where the app serving `root` listens for CLI searches, or why a graph that
/// deep can't have a socket at all.
pub fn search_socket_path(root: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let path = root.join(REFLECT_DIR).join(SEARCH_SOCKET_FILE);
    let length = path.as_os_str().len();
    if length > MAX_SOCKET_PATH_BYTES {
        return Err(format!(
            "the graph's path is too long for a search socket ({length} bytes, at most \
             {MAX_SOCKET_PATH_BYTES})"
        ));
    }
    Ok(path)
}

/// `user_version` after every migration has run. Read-only consumers compare
/// this against `PRAGMA user_version` to detect an index written by a newer
/// (or older) app than they were built for.
pub const LATEST_SCHEMA_VERSION: usize = 26;

/// The `index_meta` key holding the TS-owned projection version (the rows'
/// derivation version, distinct from the schema version above).
pub const PROJECTION_VERSION_KEY: &str = "projection_version";

/// The `index_meta` key holding the graph's local-only folder names as a JSON
/// array of strings, written by the desktop on every index open (absent when
/// none are configured). Rows inside those folders are private and, for a
/// symlinked folder, invisible to a reader's own vault walk — the CLI reads
/// the names here instead of the desktop's settings.
pub const LOCAL_ONLY_FOLDERS_KEY: &str = "local_only_folders";

#[cfg(feature = "vec")]
mod schema {
    use std::ffi::{c_char, c_int};
    use std::fmt;
    use std::path::Path;
    use std::sync::{LazyLock, OnceLock};

    use rusqlite::ffi::{sqlite3, sqlite3_api_routines};
    use rusqlite::{Connection, TransactionBehavior};
    use rusqlite_migration::{Migrations, M};

    /// Ordered schema migrations, loaded from `migrations/*.sql`.
    static MIGRATIONS: LazyLock<Migrations<'static>> = LazyLock::new(|| {
        Migrations::new(vec![
            M::up(include_str!("../migrations/0001_initial.sql")),
            M::up(include_str!("../migrations/0002_embeddings.sql")),
            M::up(include_str!("../migrations/0003_cosine_vectors.sql")),
            M::up(include_str!("../migrations/0004_pinned.sql")),
            M::up(include_str!("../migrations/0005_note_list_projection.sql")),
            M::up(include_str!("../migrations/0006_conflicts.sql")),
            M::up(include_str!("../migrations/0007_note_id_index.sql")),
            M::up(include_str!("../migrations/0008_chat.sql")),
            M::up(include_str!("../migrations/0009_gist.sql")),
            M::up(include_str!("../migrations/0010_tag_search_indexes.sql")),
            M::up(include_str!("../migrations/0011_tasks.sql")),
            M::up(include_str!("../migrations/0012_task_due_date.sql")),
            M::up(include_str!("../migrations/0013_perf_indexes.sql")),
            M::up(include_str!("../migrations/0014_note_kind.sql")),
            M::up(include_str!("../migrations/0015_note_kind_invariant.sql")),
            M::up(include_str!("../migrations/0016_note_emails.sql")),
            M::up(include_str!("../migrations/0017_task_breadcrumbs.sql")),
            M::up(include_str!("../migrations/0018_note_key_precedence.sql")),
            M::up(include_str!("../migrations/0019_note_claims.sql")),
            M::up(include_str!(
                "../migrations/0020_backlink_name_fallback.sql"
            )),
            M::up(include_str!("../migrations/0021_note_has_content.sql")),
            M::up(include_str!("../migrations/0022_drop_note_text.sql")),
            M::up(include_str!("../migrations/0023_search_fts_cjk.sql")),
            M::up(include_str!("../migrations/0024_task_ast_path.sql")),
            M::up(include_str!("../migrations/0025_note_body_chars.sql")),
            M::up(include_str!("../migrations/0026_device_only_content.sql")),
        ])
    });

    /// Why a schema operation failed; `Display` carries the full story.
    #[derive(Debug)]
    pub enum SchemaError {
        Sqlite(rusqlite::Error),
        Migration(String),
        Io(std::io::Error),
        VecRegistration(String),
    }

    impl fmt::Display for SchemaError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            match self {
                SchemaError::Sqlite(err) => write!(formatter, "{err}"),
                SchemaError::Migration(message) => write!(formatter, "migration failed: {message}"),
                SchemaError::Io(err) => write!(formatter, "{err}"),
                SchemaError::VecRegistration(message) => write!(formatter, "{message}"),
            }
        }
    }

    impl std::error::Error for SchemaError {}

    impl From<rusqlite::Error> for SchemaError {
        fn from(err: rusqlite::Error) -> Self {
            SchemaError::Sqlite(err)
        }
    }

    impl From<std::io::Error> for SchemaError {
        fn from(err: std::io::Error) -> Self {
            SchemaError::Io(err)
        }
    }

    /// Result of the one-time sqlite-vec registration; the error message is
    /// cached so every caller surfaces it instead of panicking.
    static VEC_INIT: OnceLock<Result<(), String>> = OnceLock::new();

    /// The SQLite auto-extension entry-point signature. sqlite-vec and rusqlite
    /// each link their own copy of the C types, so we transmute
    /// `sqlite3_vec_init` into rusqlite's matching function-pointer type.
    type AutoExtensionFn =
        unsafe extern "C" fn(*mut sqlite3, *mut *mut c_char, *const sqlite3_api_routines) -> c_int;

    /// Registers the sqlite-vec extension once per process, so every connection
    /// opened afterwards exposes the `vec0` virtual table and `vec_*` functions.
    pub fn register_sqlite_vec() -> Result<(), SchemaError> {
        let result = VEC_INIT.get_or_init(|| {
            // SAFETY: registering a statically-linked SQLite extension entry
            // point before opening connections — the documented sqlite-vec pattern.
            let rc = unsafe {
                rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute::<
                    *const (),
                    AutoExtensionFn,
                >(
                    sqlite_vec::sqlite3_vec_init as *const (),
                )))
            };
            if rc == rusqlite::ffi::SQLITE_OK {
                Ok(())
            } else {
                Err(format!(
                    "failed to register the sqlite-vec auto-extension (code {rc})"
                ))
            }
        });
        result.clone().map_err(SchemaError::VecRegistration)
    }

    /// Opens an in-memory connection with sqlite-vec available (used by tests).
    pub fn open_in_memory() -> Result<Connection, SchemaError> {
        register_sqlite_vec()?;
        Ok(Connection::open_in_memory()?)
    }

    /// Bring the connection to the latest schema and reconcile its CJK projection.
    pub fn migrate(conn: &mut Connection) -> Result<(), SchemaError> {
        MIGRATIONS
            .to_latest(conn)
            .map_err(|err| SchemaError::Migration(err.to_string()))?;
        repair_cjk_projection(conn)
    }

    fn repair_cjk_projection(conn: &mut Connection) -> Result<(), SchemaError> {
        // Upstream schema 23 contains task changes, so its FTS table can lack CJK.
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !super::cjk::has_column(&tx)? {
            tx.execute_batch(include_str!("../migrations/0023_search_fts_cjk.sql"))?;
            tx.execute(
                "DELETE FROM index_meta WHERE key = ?1",
                [super::PROJECTION_VERSION_KEY],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Stop at schema `version`, so schema-evolution tests can stage data in an
    /// older shape and assert what a later migration does with it.
    pub fn migrate_to(conn: &mut Connection, version: usize) -> Result<(), SchemaError> {
        MIGRATIONS
            .to_version(conn, version)
            .map_err(|err| SchemaError::Migration(format!("to version {version}: {err}")))?;
        if version >= super::cjk::COLUMN_SCHEMA_VERSION {
            repair_cjk_projection(conn)?;
        }
        Ok(())
    }

    /// Open (creating if needed) and migrate `<root>/.reflect/index.sqlite`.
    pub fn open_index_at(root: &Path) -> Result<Connection, SchemaError> {
        register_sqlite_vec()?;
        let dir = root.join(super::REFLECT_DIR);
        std::fs::create_dir_all(&dir)?;
        let mut conn = Connection::open(dir.join(super::INDEX_FILE))?;
        // Another PROCESS can hold this database too — a second app flavor on
        // the same graph, or the `reflect` CLI (which sets its own timeout).
        // Wait briefly for a cross-process lock to clear instead of failing
        // writes instantly with SQLITE_BUSY ("database is locked").
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        migrate(&mut conn)?;
        Ok(conn)
    }

    /// Open `<root>/.reflect/index.sqlite` **read-only** (no create, no
    /// migrate) — a second connection for query traffic, so a long read never
    /// holds the writer's lock. WAL readers see the last committed state, and
    /// the writer connection (opened first via [`open_index_at`]) owns the
    /// file's existence and schema.
    pub fn open_index_read_only_at(root: &Path) -> Result<Connection, SchemaError> {
        register_sqlite_vec()?;
        let path = root.join(super::REFLECT_DIR).join(super::INDEX_FILE);
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                | rusqlite::OpenFlags::SQLITE_OPEN_URI
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(conn)
    }

    /// Check the migration set itself (each `up` parses and applies in order).
    pub fn validate() -> Result<(), SchemaError> {
        // Validation replays the migrations on its own connection; vec0 must be
        // registered first (the auto-extension is process-global but not innate
        // — without this the check is order-dependent on who registers first).
        register_sqlite_vec()?;
        MIGRATIONS
            .validate()
            .map_err(|err| SchemaError::Migration(format!("invalid migration set: {err}")))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use rusqlite::OptionalExtension;

        #[test]
        fn migrations_are_valid() {
            validate().unwrap();
        }

        #[test]
        fn latest_schema_version_matches_migrations() {
            let mut conn = open_in_memory().unwrap();
            migrate(&mut conn).unwrap();
            let version: i64 = conn
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .unwrap();
            assert_eq!(version, crate::LATEST_SCHEMA_VERSION as i64);
            assert!(crate::cjk::has_column(&conn).unwrap());
        }

        #[test]
        fn historical_targets_keep_their_cjk_schema_boundary() {
            let mut conn = open_in_memory().unwrap();
            migrate_to(&mut conn, 22).unwrap();
            assert!(!crate::cjk::has_column(&conn).unwrap());
            migrate_to(&mut conn, 23).unwrap();
            assert!(crate::cjk::has_column(&conn).unwrap());
        }

        #[test]
        fn cjk_repair_preserves_durable_data_and_is_idempotent() {
            for (version, upstream) in [
                (23, true),
                (23, false),
                (24, false),
                (crate::LATEST_SCHEMA_VERSION, false),
            ] {
                let mut conn = open_in_memory().unwrap();
                if upstream {
                    migrate_to(&mut conn, 22).unwrap();
                    conn.execute_batch(include_str!("../migrations/0024_task_ast_path.sql"))
                        .unwrap();
                    conn.pragma_update(None, "user_version", i64::try_from(version).unwrap())
                        .unwrap();
                } else {
                    migrate_to(&mut conn, version).unwrap();
                }
                conn.execute_batch(
                    "INSERT INTO notes(path, title, title_key, file_hash) VALUES ('notes/a.md', 'A', 'a', 'hash');
                     INSERT INTO search_fts(path, title, body) VALUES ('notes/a.md', 'A', 'body');
                     INSERT INTO index_meta(key, value) VALUES ('projection_version', 'current'), ('local_only_folders', '[\"secure\"]');
                     INSERT INTO chat_conversations VALUES ('c1', 'Chat', 1, 2);
                     INSERT INTO chat_messages VALUES ('m1', 'c1', 0, 'hello', '[]', '[]', '[]', 1);
                     INSERT INTO embedding_chunks(id, note_path, pos_from, pos_to, text, content_hash, model_id)
                       VALUES (1, 'notes/a.md', 0, 4, 'body', 'hash', 'all-MiniLM-L6-v2');",
                ).unwrap();
                let vector = format!("[{}]", ["0.25"; 384].join(","));
                conn.execute(
                    "INSERT INTO embedding_vectors(rowid, embedding) VALUES (1, ?1)",
                    [vector],
                )
                .unwrap();
                let before: Vec<u8> = conn
                    .query_row(
                        "SELECT embedding FROM embedding_vectors WHERE rowid = 1",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();

                migrate(&mut conn).unwrap();
                assert!(crate::cjk::has_column(&conn).unwrap());
                let stamp: Option<String> = conn
                    .query_row(
                        "SELECT value FROM index_meta WHERE key = 'projection_version'",
                        [],
                        |row| row.get(0),
                    )
                    .optional()
                    .unwrap();
                assert_eq!(stamp.as_deref(), (!upstream).then_some("current"));
                assert_eq!(
                    conn.query_row(
                        "SELECT count(*) FROM search_fts WHERE path = 'notes/a.md'",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                    i64::from(!upstream)
                );
                conn.execute("INSERT INTO tasks(note_path, ast_path, markdown, checked) VALUES ('notes/a.md', '[0]', 'task', 0)", []).unwrap();
                let after: Vec<u8> = conn
                    .query_row(
                        "SELECT embedding FROM embedding_vectors WHERE rowid = 1",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(after, before);
                for (query, expected) in [
                    ("SELECT title FROM notes WHERE path = 'notes/a.md'", "A"),
                    (
                        "SELECT title FROM chat_conversations WHERE id = 'c1'",
                        "Chat",
                    ),
                    (
                        "SELECT user_text FROM chat_messages WHERE id = 'm1'",
                        "hello",
                    ),
                    ("SELECT text FROM embedding_chunks WHERE id = 1", "body"),
                    (
                        "SELECT value FROM index_meta WHERE key = 'local_only_folders'",
                        "[\"secure\"]",
                    ),
                ] {
                    assert_eq!(
                        conn.query_row(query, [], |row| row.get::<_, String>(0))
                            .unwrap(),
                        expected
                    );
                }
                conn.execute_batch("INSERT INTO search_fts(path, title, body, cjk) VALUES ('notes/rebuilt.md', 'Rebuilt', '東京旅行', '東京 京旅 旅行 行');
                    INSERT OR REPLACE INTO index_meta(key, value) VALUES ('projection_version', 'rebuilt');").unwrap();
                migrate(&mut conn).unwrap();
                assert_eq!(
                    conn.query_row(
                        "SELECT path FROM search_fts WHERE search_fts MATCH 'cjk : \"東京\"'",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                    "notes/rebuilt.md"
                );
                assert_eq!(
                    conn.query_row(
                        "SELECT value FROM index_meta WHERE key = 'projection_version'",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                    "rebuilt"
                );
            }
        }
    }
}

#[cfg(feature = "vec")]
pub use schema::{
    migrate, migrate_to, open_in_memory, open_index_at, open_index_read_only_at,
    register_sqlite_vec, validate, SchemaError,
};
