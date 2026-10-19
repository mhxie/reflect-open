//! Command tier: the index commands take the open graph's local-only folders
//! from `GraphState`, and a graph open loads and checks the configuration
//! the index records. The session's own rules are tested in `reflect-index`.

use std::path::{Path, PathBuf};

use reflect_graph_paths::LocalOnlyFolders;
use reflect_index::{FileIndexConnections, LocalOnlyRecord, LocalOnlyScope};
use serde_json::{Value, json};
use tauri::Manager;

use super::{IndexState, IndexedNote, MovedNoteAddress, NoteMoveRequest};

type App = tauri::App<tauri::test::MockRuntime>;

/// A note's projection as the TypeScript extractor sends it.
fn note(path: &str, title: &str) -> IndexedNote {
    serde_json::from_value(json!({
        "path": path,
        "title": title,
        "titleKey": title.to_lowercase(),
        "pathKey": path.to_lowercase(),
        "kind": "note",
        "isPrivate": false,
        "isPinned": false,
        "hasContent": true,
        "bodyChars": 0,
        "gistStale": false,
        "summaryFresh": false,
        "fileHash": "h",
        "mtime": 0,
        "text": format!("{title} body"),
        "preview": "body",
        "links": [],
        "tags": [],
        "aliases": [],
        "claims": [],
        "emails": [],
        "assets": [],
        "tasks": [],
    }))
    .unwrap()
}

/// The folded address a move's destination (or source) answers to.
fn moved_address(path: &str) -> MovedNoteAddress {
    let stem = Path::new(path).file_stem().unwrap().to_string_lossy();
    serde_json::from_value(json!({
        "pathKey": path.to_lowercase(),
        "basenameKey": stem.to_lowercase(),
    }))
    .unwrap()
}

fn move_request(from: &str, to: &str) -> NoteMoveRequest {
    NoteMoveRequest {
        from: from.into(),
        to: to.into(),
        to_address: moved_address(to),
        from_address: moved_address(from),
    }
}

/// Store `notes` in the index at `root` from a session that knows of no
/// local-only folder (rows written before a folder was configured).
fn store_unconfigured(root: &Path, notes: &[IndexedNote]) {
    let session = IndexState::default();
    let generation = session
        .open(root, LocalOnlyScope::default(), &FileIndexConnections)
        .unwrap();
    session.apply(generation, notes).unwrap();
}

/// A mock app with one graph open at `root`, carrying `folders`.
fn local_only_app(root: &Path, folders: Option<LocalOnlyFolders>) -> App {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    app.manage(crate::fs::GraphState::default());
    app.manage(IndexState::default());
    app.manage(crate::background_task::BackgroundTaskState::default());
    app.manage(crate::fs::assets::AssetUploads::default());
    {
        let state: tauri::State<crate::fs::GraphState> = app.state();
        let mut inner = state.0.lock().unwrap();
        inner.generation = 1;
        inner.root = Some(root.to_path_buf());
        inner.set_local_only(folders);
    }
    app
}

fn index_open(app: &App) -> u64 {
    super::index_open(app.state(), app.state(), app.state()).expect("open")
}

fn apply(app: &App, generation: u64, note: IndexedNote) {
    super::index_apply(
        note,
        generation,
        app.handle().clone(),
        app.state(),
        app.state(),
    )
    .unwrap();
}

fn move_note(app: &App, from: &str, to: &str) -> crate::error::AppResult<()> {
    super::note_move_indexed(
        move_request(from, to),
        1,
        app.handle().clone(),
        app.state(),
        app.state(),
        app.state(),
    )
}

/// The stored privacy flag of the row at `path`, or `None` with no row.
fn row_private_flag(app: &App, path: &str) -> Option<bool> {
    let index = app.state::<IndexState>();
    let generation = index.read_generation().unwrap();
    let rows = index
        .query(
            generation,
            "SELECT is_private AS private FROM notes WHERE path = ?1",
            &[Value::from(path)],
        )
        .unwrap();
    rows.first()
        .map(|row| row["private"].as_i64().expect("an integer flag") != 0)
}

/// Command tier: `index_open` takes the graph's folders from `GraphState`,
/// marks stored rows inside them private, binds the policy `index_apply`
/// enforces, and the reconcile scan lists the notes behind a link; the
/// control session without folders leaves the same rows public.
#[cfg(unix)]
#[test]
fn the_index_commands_take_local_only_folders_from_the_open_graph() {
    for configured in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let (root, raw) = (base.join("graph"), base.join("raw"));
        std::fs::create_dir_all(root.join("people/secure")).unwrap();
        std::fs::create_dir_all(root.join("finance")).unwrap();
        std::fs::create_dir_all(raw.join("finance/secure")).unwrap();
        std::fs::write(root.join("people/secure/visa.md"), "# Visa\n").unwrap();
        std::fs::write(raw.join("finance/secure/bank.md"), "# Bank\n").unwrap();
        std::os::unix::fs::symlink(raw.join("finance/secure"), root.join("finance/secure"))
            .unwrap();
        store_unconfigured(&root, &[note("people/secure/visa.md", "Visa")]);
        let folders = LocalOnlyFolders::new(["secure"], Some(&raw));
        let app = local_only_app(&root, if configured { folders } else { None });

        let generation = index_open(&app);
        assert_eq!(
            row_private_flag(&app, "people/secure/visa.md"),
            Some(configured)
        );

        apply(&app, generation, note("finance/secure/bank.md", "Bank"));
        assert_eq!(
            row_private_flag(&app, "finance/secure/bank.md"),
            Some(configured)
        );

        let scan = tauri::async_runtime::block_on(super::index_reconcile_scan(
            generation,
            app.handle().clone(),
        ))
        .expect("scan");
        // The link's note is listed only when the link is followed.
        assert_eq!(scan.total, if configured { 2 } else { 1 });
    }
}

/// A move into a local-only folder is refused before any row moves.
#[cfg(unix)]
#[test]
fn a_refused_move_into_a_local_only_folder_leaves_the_row_as_it_was() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    std::fs::create_dir_all(root.join("notes")).unwrap();
    std::fs::create_dir_all(root.join("people/secure")).unwrap();
    std::fs::write(root.join("notes/plan.md"), "# Plan\n").unwrap();
    let app = local_only_app(&root, LocalOnlyFolders::new(["secure"], None));
    let generation = index_open(&app);
    apply(&app, generation, note("notes/plan.md", "Plan"));

    assert!(move_note(&app, "notes/plan.md", "people/secure/plan.md").is_err());
    assert_eq!(row_private_flag(&app, "notes/plan.md"), Some(false));
    assert_eq!(row_private_flag(&app, "people/secure/plan.md"), None);
    assert!(root.join("notes/plan.md").exists());
}

/// A graph whose `finance/secure` links into a raw store with `secure`
/// editable, beside an ordinary note, open in a mock app.
#[cfg(unix)]
struct EditableGraph {
    _dir: tempfile::TempDir,
    root: PathBuf,
    raw: PathBuf,
    app: App,
}

#[cfg(unix)]
fn editable_graph() -> EditableGraph {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let (root, raw) = (base.join("graph"), base.join("raw"));
    for folder in ["notes", "assets", "finance", ".reflect"] {
        std::fs::create_dir_all(root.join(folder)).unwrap();
    }
    std::fs::create_dir_all(raw.join("finance/secure")).unwrap();
    std::fs::write(root.join("notes/plan.md"), "# Plan\n").unwrap();
    std::fs::write(raw.join("finance/secure/bank.md"), "# Bank\n").unwrap();
    std::os::unix::fs::symlink(raw.join("finance/secure"), root.join("finance/secure")).unwrap();
    let (folders, _) = LocalOnlyFolders::new(["secure"], Some(&raw))
        .unwrap()
        .with_editable(["secure"]);
    let app = local_only_app(&root, Some(folders));
    EditableGraph {
        _dir: dir,
        root,
        raw,
        app,
    }
}

/// A move into or out of an editable local-only folder is refused before
/// any row moves; a move within it carries the rows, which stay private.
#[cfg(unix)]
#[test]
fn a_move_across_an_editable_folder_boundary_is_refused_before_any_row_moves() {
    let graph = editable_graph();
    let app = &graph.app;
    let generation = index_open(app);
    for (path, title) in [
        ("notes/plan.md", "Plan"),
        ("finance/secure/bank.md", "Bank"),
    ] {
        apply(app, generation, note(path, title));
    }

    for (from, to) in [
        ("notes/plan.md", "finance/secure/plan.md"),
        ("finance/secure/bank.md", "notes/bank.md"),
    ] {
        let message = format!("{:?}", move_note(app, from, to).unwrap_err());
        assert!(
            message.contains("crosses a local-only boundary"),
            "{message}"
        );
        assert_eq!(row_private_flag(app, to), None, "{to}");
    }
    assert_eq!(row_private_flag(app, "notes/plan.md"), Some(false));
    assert_eq!(row_private_flag(app, "finance/secure/bank.md"), Some(true));
    assert!(graph.root.join("notes/plan.md").exists());
    assert!(graph.raw.join("finance/secure/bank.md").exists());
    assert!(!graph.raw.join("finance/secure/plan.md").exists());
    assert!(!graph.root.join("notes/bank.md").exists());

    // Control: within the folder, rows and file move together.
    move_note(app, "finance/secure/bank.md", "finance/secure/2026/bank.md").unwrap();
    assert_eq!(row_private_flag(app, "finance/secure/bank.md"), None);
    assert_eq!(
        row_private_flag(app, "finance/secure/2026/bank.md"),
        Some(true)
    );
    assert_eq!(
        std::fs::read_to_string(graph.raw.join("finance/secure/2026/bank.md")).unwrap(),
        "# Bank\n"
    );
}

/// Every file below `dir`, with its bytes, skipping `skip` directory names
/// (a link is recorded by its target and never followed).
#[cfg(all(unix, desktop))]
fn tree(dir: &Path, skip: &[&str]) -> Vec<(PathBuf, Vec<u8>)> {
    let mut found = Vec::new();
    let entries = walkdir::WalkDir::new(dir)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| {
            !skip
                .iter()
                .any(|name| entry.depth() == 1 && entry.file_name() == *name)
        });
    for entry in entries {
        let entry = entry.unwrap();
        let bytes = if entry.path_is_symlink() {
            std::fs::read_link(entry.path())
                .unwrap()
                .into_os_string()
                .into_encoded_bytes()
        } else if entry.file_type().is_file() {
            std::fs::read(entry.path()).unwrap()
        } else {
            Vec::new()
        };
        found.push((entry.path().to_path_buf(), bytes));
    }
    found
}

/// End to end through the commands, the way the app edits a note in an
/// editable linked folder: a refused unchecked save, a checked save, the
/// alias frontmatter a rename writes, a move within the folder, a pasted
/// attachment, a kept and cleared recovery copy, a delete through the
/// system Trash, and the next backup commit. The note's text and its
/// attachment exist only in the raw store, the graph's own tree and
/// `assets/` never change, its rows stay private, and the backup holds
/// nothing of it, nor of `.reflect/`.
#[cfg(all(unix, desktop))]
#[test]
fn an_editable_local_only_note_never_leaves_its_folder_or_reaches_the_backup() {
    let graph = editable_graph();
    let (root, raw, app) = (&graph.root, &graph.raw, &graph.app);
    git2::Repository::init(root).unwrap();
    let _trash = crate::fs::os_trash_seam::install(|path| Ok(std::fs::remove_file(path)?));
    let generation = index_open(app);
    let tracked = || tree(root, &[".git", ".reflect"]);
    let tracked_before = tracked();
    let secret = "account 4421-7731";
    let (path, moved) = ("finance/secure/bank.md", "finance/secure/2026/bank.md");
    let write = |path: &str, contents: &str, check: Option<bool>, expected: Option<&str>| {
        crate::fs::note_write(
            path.into(),
            contents.into(),
            1,
            check,
            expected.map(str::to_string),
            app.state(),
        )
    };

    let body = format!("# Bank\n\n{secret}\n");
    assert!(write(path, &body, None, None).is_err());
    assert_eq!(std::fs::read_to_string(raw.join(path)).unwrap(), "# Bank\n");
    write(path, &body, Some(true), Some("# Bank\n")).unwrap();
    let aliased = format!("---\naliases:\n  - Old Bank\n---\n{body}");
    write(path, &aliased, Some(true), Some(&body)).unwrap();
    apply(app, generation, note(path, "Bank"));

    move_note(app, path, moved).unwrap();
    assert_eq!(row_private_flag(app, path), None);
    assert_eq!(row_private_flag(app, moved), Some(true));

    let upload = crate::fs::assets::asset_upload_begin(1, app.state(), app.state()).unwrap();
    crate::fs::assets::append_chunk(
        &app.state::<crate::fs::assets::AssetUploads>(),
        &upload,
        secret.as_bytes(),
    )
    .unwrap();
    let asset = crate::fs::assets::asset_upload_commit(
        upload,
        "statement.png".into(),
        moved.into(),
        1,
        app.state(),
        app.state(),
    )
    .unwrap();
    assert_eq!(asset, "finance/secure/assets/statement.png");

    let owner = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let copy = tauri::async_runtime::block_on(crate::fs::recovery::note_recovery_write(
        moved.into(),
        body.clone(),
        owner.into(),
        Some(aliased.clone()),
        1,
        app.state(),
    ))
    .unwrap();
    let recovery = root.join(".reflect/recovery");
    assert_eq!(std::fs::read_dir(&recovery).unwrap().count(), 1);
    tauri::async_runtime::block_on(crate::fs::recovery::note_recovery_clear(
        moved.into(),
        owner.into(),
        copy.token,
        1,
        app.state(),
    ))
    .unwrap();
    assert!(
        tauri::async_runtime::block_on(crate::fs::recovery::note_recovery_read(
            moved.into(),
            1,
            app.state()
        ))
        .unwrap()
        .is_none()
    );

    // Until the delete, the text and the attachment live in the raw store
    // alone: nothing under the graph root holds either.
    assert_eq!(
        std::fs::read_to_string(raw.join("finance/secure/2026/bank.md")).unwrap(),
        aliased
    );
    assert_eq!(
        std::fs::read(raw.join("finance/secure/assets/statement.png")).unwrap(),
        secret.as_bytes()
    );
    let leaked: Vec<_> = tree(root, &[".git"])
        .into_iter()
        .filter(|(_, bytes)| {
            bytes
                .windows(secret.len())
                .any(|window| window == secret.as_bytes())
        })
        .collect();
    assert!(leaked.is_empty(), "{leaked:?}");

    let deleted = crate::fs::note_delete(moved.into(), 1, app.state()).unwrap();
    assert_eq!(deleted.trashed, crate::fs::Trashed::System);
    assert!(!raw.join("finance/secure/2026/bank.md").exists());

    let committed = tauri::async_runtime::block_on(crate::git::git_commit_all(
        "Update notes".into(),
        1,
        app.state(),
    ))
    .unwrap();
    assert!(committed.committed);
    let repo = git2::Repository::open(root).unwrap();
    let head = repo.head().unwrap().peel_to_tree().unwrap();
    let mut committed_paths = Vec::new();
    head.walk(git2::TreeWalkMode::PreOrder, |prefix, entry| {
        committed_paths.push(format!("{prefix}{}", entry.name().unwrap_or("")));
        git2::TreeWalkResult::Ok
    })
    .unwrap();
    assert!(
        committed_paths.contains(&"notes/plan.md".to_string()),
        "{committed_paths:?}"
    );
    assert!(
        !committed_paths
            .iter()
            .any(|path| path.contains("secure") || path.contains(".reflect")),
        "{committed_paths:?}"
    );

    assert_eq!(tracked(), tracked_before);
    assert_eq!(
        std::fs::read_dir(root.join(".reflect/tmp"))
            .map(|entries| entries.count())
            .unwrap_or(0),
        0
    );
}

/// The names an index recorded (empty for no index or no record).
fn recorded_names(root: &Path) -> Vec<String> {
    match reflect_index::recorded_local_only_folders(root) {
        LocalOnlyRecord::Names(names) => names,
        LocalOnlyRecord::Nothing => Vec::new(),
        unreadable => panic!("{unreadable:?}"),
    }
}

/// Open (creating if needed) and migrate the index file under `root`, for
/// staging raw rows.
fn open_index_at(root: &Path) -> rusqlite::Connection {
    reflect_index_schema::open_index_at(root).unwrap()
}

/// An index that cannot be read reports its record unreadable (the open
/// then fails closed), never as nothing recorded; the controls, no index
/// and an index without a record, have nothing to compare.
#[test]
fn an_index_that_cannot_be_read_reports_the_record_unreadable() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let recorded = || reflect_index::recorded_local_only_folders(&root);
    assert!(matches!(recorded(), LocalOnlyRecord::Nothing));
    drop(open_index_at(&root));
    assert!(matches!(recorded(), LocalOnlyRecord::Nothing));
    std::fs::write(root.join(".reflect/index.sqlite"), b"not a database").unwrap();
    assert!(
        matches!(
            recorded(),
            LocalOnlyRecord::Unreadable { corrupt: false, .. }
        ),
        "{:?}",
        recorded()
    );
}

/// The index records the folder names it opened with, the next graph open
/// reads them back, and an open whose configuration is unknown leaves the
/// record alone (so the CLI keeps refusing); a known open replaces it.
#[test]
fn an_unknown_open_keeps_the_recorded_local_only_folders() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    std::fs::create_dir_all(root.join("people/secure")).unwrap();
    assert!(recorded_names(&root).is_empty(), "no index yet");

    let app = local_only_app(&root, LocalOnlyFolders::new(["secure"], None));
    index_open(&app);
    assert_eq!(recorded_names(&root), ["secure"]);

    // Unknown, even with no folders in hand: the record stays.
    let app = local_only_app(&root, None);
    {
        let state: tauri::State<crate::fs::GraphState> = app.state();
        state.0.lock().unwrap().set_local_only_unknown();
    }
    index_open(&app);
    assert_eq!(recorded_names(&root), ["secure"]);

    // Control: a known configuration without the folder replaces it.
    let app = local_only_app(&root, None);
    index_open(&app);
    assert!(recorded_names(&root).is_empty());
}

/// Only the index open writes the local-only record: `index_meta_set`
/// refuses its key, so a frontend bug cannot empty it; the control key
/// still lands.
#[test]
fn the_frontend_cannot_overwrite_the_local_only_record() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let app = local_only_app(&root, LocalOnlyFolders::new(["secure"], None));
    let generation = index_open(&app);
    let set = |key: &str| {
        super::index_meta_set(
            key.to_string(),
            "[]".to_string(),
            generation,
            app.state(),
            app.state(),
        )
    };
    assert!(set(reflect_index_schema::LOCAL_ONLY_FOLDERS_KEY).is_err());
    assert_eq!(recorded_names(&root), ["secure"]);
    set("projection_version").expect("an ordinary key");
    let stored: String = open_index_at(&root)
        .query_row(
            "SELECT value FROM index_meta WHERE key = 'projection_version'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored, "[]");
}

/// A temp settings file and recents list for this test thread, a mock app
/// managing the graph, index, and background-task state, and a graph folder.
struct OpenFixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    settings: PathBuf,
    app: App,
}

impl OpenFixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let root = base.join("graph");
        std::fs::create_dir_all(root.join("people/secure")).unwrap();
        std::fs::write(root.join("people/secure/visa.md"), "# Visa\n").unwrap();
        let settings = base.join("settings.json");
        crate::settings::TEST_STORE_PATH.with(|path| *path.borrow_mut() = Some(settings.clone()));
        crate::recents::TEST_STORE_PATH
            .with(|path| *path.borrow_mut() = Some(base.join("recent-graphs.json")));
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        app.manage(crate::fs::GraphState::default());
        app.manage(IndexState::default());
        app.manage(crate::background_task::BackgroundTaskState::default());
        Self {
            _dir: dir,
            root,
            settings,
            app,
        }
    }

    /// Write the settings with this graph's entry, or none.
    fn settings(&self, entry: Option<Value>) {
        let mut entries = serde_json::Map::new();
        if let Some(entry) = entry {
            entries.insert(self.root.to_string_lossy().into_owned(), entry);
        }
        let doc = json!({ "localOnlyFolders": entries });
        std::fs::write(&self.settings, doc.to_string()).unwrap();
    }

    fn open(&self) -> crate::fs::GraphInfo {
        crate::fs::graph_open(self.root.to_string_lossy().into_owned(), self.app.state())
            .expect("graph_open")
    }

    fn index_open(&self) {
        index_open(&self.app);
    }

    fn sync_refusal(&self, generation: u64) -> Option<String> {
        crate::fs::graph_for_sync(&self.app.state(), generation)
            .err()
            .map(|err| format!("{err:?}"))
    }

    fn chat_rows(&self) -> i64 {
        open_index_at(&self.root)
            .query_row("SELECT count(*) FROM chat_messages", [], |row| row.get(0))
            .unwrap()
    }
}

impl Drop for OpenFixture {
    fn drop(&mut self) {
        crate::settings::TEST_STORE_PATH.with(|path| *path.borrow_mut() = None);
        crate::recents::TEST_STORE_PATH.with(|path| *path.borrow_mut() = None);
    }
}

/// End to end through the open: the graph's accepted history roots reach
/// `GraphState` for sync, and an id Reflect cannot use comes back as a
/// backup warning instead.
#[test]
fn a_graph_open_loads_its_accepted_history_roots_and_reports_a_malformed_one() {
    let fixture = OpenFixture::new();
    let key = crate::git::ACCEPTED_HISTORY_ROOTS_SETTINGS_KEY;
    let graph = fixture.root.to_string_lossy().into_owned();
    let accepted = "d39c5fa0d39c5fa0d39c5fa0d39c5fa0d39c5fa0";
    let doc = json!({ key: { graph: [accepted, "d39c5fa"] } });
    std::fs::write(&fixture.settings, doc.to_string()).unwrap();

    let info = fixture.open();
    assert_eq!(info.backup_warnings.len(), 1, "{:?}", info.backup_warnings);
    assert!(
        info.backup_warnings[0].contains("\"d39c5fa\""),
        "{:?}",
        info.backup_warnings
    );
    let roots = crate::fs::accepted_history_roots(&fixture.app.state(), info.generation).unwrap();
    assert_eq!(roots, vec![git2::Oid::from_str(accepted).unwrap()]);
}

/// End to end through the commands, the load the open uses included: a
/// graph whose entry disappears (a moved vault) keeps its recorded folders
/// local-only, warns, and refuses to commit; a `released` list in its own
/// entry resumes it, the next index open records the shorter list, and the
/// chat history survives every step.
#[test]
fn a_disappearing_entry_pauses_and_a_release_resumes_without_touching_chat() {
    let fixture = OpenFixture::new();
    fixture.settings(Some(json!({ "folders": ["secure"] })));
    assert_eq!(fixture.open().local_only_folders, ["secure"]);
    fixture.index_open();
    assert_eq!(recorded_names(&fixture.root), ["secure"]);
    {
        let index = fixture.app.state::<IndexState>();
        let generation = index.current_generation().unwrap().unwrap();
        let conversation = serde_json::from_value(json!({
            "id": "c1", "title": "Chat", "createdMs": 1, "updatedMs": 1,
        }))
        .unwrap();
        let message = serde_json::from_value(json!({
            "id": "m1", "conversationId": "c1", "userText": "hi", "attachments": "[]",
            "parts": "[]", "responseMessages": "[]", "createdMs": 1,
        }))
        .unwrap();
        index
            .save_chat_message(generation, &conversation, &message)
            .unwrap();
    }

    // The entry disappears.
    fixture.settings(None);
    let info = fixture.open();
    assert_eq!(info.local_only_folders, ["secure"]);
    assert!(
        info.local_only_warnings
            .iter()
            .any(|warning| warning.contains("no longer lists")),
        "{:?}",
        info.local_only_warnings
    );
    let committed = tauri::async_runtime::block_on(crate::git::git_commit_all(
        "Update notes".into(),
        info.generation,
        fixture.app.state(),
    ));
    assert!(format!("{:?}", committed.expect_err("paused")).contains("Sync is paused"));
    fixture.index_open();
    assert_eq!(
        recorded_names(&fixture.root),
        ["secure"],
        "the record is kept"
    );

    // A release in the graph's own entry resumes it.
    fixture.settings(Some(json!({ "folders": [], "released": ["secure"] })));
    let info = fixture.open();
    assert!(info.local_only_folders.is_empty());
    assert!(
        info.local_only_warnings
            .iter()
            .any(|warning| warning.contains("no longer local-only"))
    );
    assert_eq!(fixture.sync_refusal(info.generation), None);
    fixture.index_open();
    assert!(recorded_names(&fixture.root).is_empty());

    // The leftover release is silent, and nothing was rebuilt.
    let info = fixture.open();
    assert!(
        !info
            .local_only_warnings
            .iter()
            .any(|warning| warning.contains("no longer local-only"))
    );
    assert_eq!(fixture.sync_refusal(info.generation), None);
    assert_eq!(fixture.chat_rows(), 1);
}

/// A record that does not parse fails closed: with no entry for the graph
/// it pauses and stays as it is; an entry for the graph replaces it at the
/// next index open (the control that the corruption, not the entry, paused).
#[test]
fn a_corrupt_record_pauses_until_an_entry_replaces_it() {
    let fixture = OpenFixture::new();
    open_index_at(&fixture.root)
        .execute(
            "INSERT INTO index_meta(key, value) VALUES(?1, 'not json')",
            [reflect_index_schema::LOCAL_ONLY_FOLDERS_KEY],
        )
        .unwrap();
    fixture.settings(None);
    let info = fixture.open();
    assert!(
        info.local_only_warnings
            .iter()
            .any(|warning| warning.contains("could not read which folders")),
        "{:?}",
        info.local_only_warnings
    );
    assert!(
        fixture
            .sync_refusal(info.generation)
            .is_some_and(|reason| reason.contains("Sync is paused"))
    );
    fixture.index_open();
    assert!(matches!(
        reflect_index::recorded_local_only_folders(&fixture.root),
        LocalOnlyRecord::Unreadable { corrupt: true, .. }
    ));

    fixture.settings(Some(json!({ "folders": ["secure"] })));
    let info = fixture.open();
    assert!(
        fixture.sync_refusal(info.generation).is_some(),
        "paused this session"
    );
    assert!(
        info.local_only_warnings
            .iter()
            .any(|warning| warning.contains("records \"secure\" from this graph's entry")),
        "{:?}",
        info.local_only_warnings
    );
    fixture.index_open();
    assert_eq!(recorded_names(&fixture.root), ["secure"]);
    let info = fixture.open();
    assert_eq!(fixture.sync_refusal(info.generation), None);
    assert_eq!(info.local_only_folders, ["secure"]);
}

/// Open the graph with `entry`, then the index: one session, and whether
/// sync is paused in it.
fn session(fixture: &OpenFixture, entry: Value) -> (crate::fs::GraphInfo, bool) {
    fixture.settings(Some(entry));
    let info = fixture.open();
    fixture.index_open();
    let paused = fixture.sync_refusal(info.generation).is_some();
    (info, paused)
}

fn warns(info: &crate::fs::GraphInfo, text: &str) -> bool {
    info.local_only_warnings
        .iter()
        .any(|warning| warning.contains(text))
}

/// While the configuration is paused the record only grows: a folder listed
/// during the pause is remembered even if it is dropped before the pause
/// lifts, so dropping it then pauses instead of silently unprotecting it.
/// Control: a known open still replaces the record, so a release shrinks it.
#[test]
fn a_folder_listed_during_a_pause_is_remembered() {
    let fixture = OpenFixture::new();
    session(&fixture, json!({ "folders": ["secure"] }));
    let (_, paused) = session(&fixture, json!({ "folders": ["kids"] }));
    assert!(paused, "secure went missing");
    assert_eq!(recorded_names(&fixture.root), ["secure", "kids"]);

    let (info, paused) = session(&fixture, json!({ "folders": ["secure"] }));
    assert!(paused && warns(&info, "no longer lists \"kids\""));
    assert_eq!(info.local_only_folders, ["secure", "kids"]);

    let (_, paused) = session(
        &fixture,
        json!({ "folders": ["secure"], "released": ["kids"] }),
    );
    assert!(!paused);
    assert_eq!(recorded_names(&fixture.root), ["secure"]);
}

/// The challenger's sequence: release `secure`, then list it again with the
/// release left in place. The overlap pauses at the first open, where the
/// record grows to hold `secure` again, so the leftover never sits quietly;
/// removing it from `released` resumes with the folder local-only. Control:
/// dropping it from `folders` instead is the release edit and lets it go.
#[test]
fn a_name_in_both_lists_pauses_until_one_list_drops_it() {
    let fixture = OpenFixture::new();
    let both = || json!({ "folders": ["secure"], "released": ["secure"] });
    session(&fixture, json!({ "folders": ["secure"] }));
    session(&fixture, json!({ "folders": [], "released": ["secure"] }));
    assert!(recorded_names(&fixture.root).is_empty());

    let (info, paused) = session(&fixture, both());
    assert!(paused && warns(&info, "in both \"folders\" and \"released\""));
    assert_eq!(info.local_only_folders, ["secure"]);
    assert_eq!(
        recorded_names(&fixture.root),
        ["secure"],
        "recorded while paused"
    );
    let (info, paused) = session(&fixture, json!({ "folders": ["secure"], "released": [] }));
    assert!(!paused && info.local_only_folders == ["secure"]);

    session(&fixture, both());
    let (info, paused) = session(&fixture, json!({ "folders": [], "released": ["secure"] }));
    assert!(!paused && info.local_only_folders.is_empty());
    assert!(warns(&info, "no longer local-only"));
}

/// End to end through the open: the entry's `editable` list reaches
/// `GraphInfo` (and so the app) only while editing is safe. A paused
/// configuration and a rawRoot that contains the Library folder both open
/// with every folder read-only and a warning saying why; the folders stay
/// local-only either way.
#[cfg(all(desktop, unix))]
#[test]
fn a_graph_open_grants_editable_folders_only_while_editing_is_safe() {
    let fixture = OpenFixture::new();
    let raw = fixture.root.with_file_name("raw");
    std::fs::create_dir_all(&raw).unwrap();
    let (info, paused) = session(
        &fixture,
        json!({ "folders": ["secure"], "editable": ["secure"], "rawRoot": raw }),
    );
    assert!(!paused);
    assert_eq!(info.local_only_editable_folders, ["secure"]);
    assert!(
        !warns(&info, "Not editable"),
        "{:?}",
        info.local_only_warnings
    );

    let (info, paused) = session(
        &fixture,
        json!({
            "folders": ["secure", "kids"],
            "released": ["kids"],
            "editable": ["secure"],
            "rawRoot": raw
        }),
    );
    assert!(paused);
    assert!(info.local_only_editable_folders.is_empty());
    assert!(
        warns(&info, "until the configuration is known again"),
        "{:?}",
        info.local_only_warnings
    );
    assert!(info.local_only_folders.contains(&"secure".to_string()));

    if let Some(home) = dirs::home_dir() {
        let (info, paused) = session(
            &fixture,
            json!({
                "folders": ["secure"],
                "released": ["kids"],
                "editable": ["secure"],
                "rawRoot": home
            }),
        );
        assert!(!paused);
        assert!(info.local_only_editable_folders.is_empty());
        assert!(warns(&info, "too broad"), "{:?}", info.local_only_warnings);
    }
}

/// A record that is not text is damaged content, not a failed read: it
/// counts as a record that does not parse, so the graph's entry replaces it
/// at the next index open, as it does a record that fails to parse, instead
/// of pausing with no way out from the settings. Control: once replaced,
/// the record reads as names again.
#[test]
fn a_record_that_is_not_text_counts_as_damaged() {
    let fixture = OpenFixture::new();
    open_index_at(&fixture.root)
        .execute(
            "INSERT INTO index_meta(key, value) VALUES(?1, X'00ff')",
            [reflect_index_schema::LOCAL_ONLY_FOLDERS_KEY],
        )
        .unwrap();
    assert!(matches!(
        reflect_index::recorded_local_only_folders(&fixture.root),
        LocalOnlyRecord::Unreadable { corrupt: true, .. }
    ));
    let (info, paused) = session(&fixture, json!({ "folders": ["secure"] }));
    assert!(paused && warns(&info, "records \"secure\" from this graph's entry"));
    assert_eq!(recorded_names(&fixture.root), ["secure"]);
}

/// A paused open that cannot read the record leaves it exactly as it is (and
/// logs it): here a value that is not text with no entry for this graph, so
/// every open keeps pausing. Control: once the entry names a folder, the
/// next index open replaces the record.
#[test]
fn a_paused_open_leaves_a_record_it_cannot_read_unchanged() {
    let fixture = OpenFixture::new();
    let key = reflect_index_schema::LOCAL_ONLY_FOLDERS_KEY;
    open_index_at(&fixture.root)
        .execute(
            "INSERT INTO index_meta(key, value) VALUES(?1, X'00ff')",
            [key],
        )
        .unwrap();
    let stored = || -> String {
        open_index_at(&fixture.root)
            .query_row(
                "SELECT typeof(value) || ':' || hex(value) FROM index_meta WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .unwrap()
    };
    fixture.settings(None);
    for _ in 0..2 {
        let info = fixture.open();
        assert!(fixture.sync_refusal(info.generation).is_some(), "paused");
        fixture.index_open();
        assert_eq!(stored(), "blob:00FF");
    }
    let (_, paused) = session(&fixture, json!({ "folders": ["secure"] }));
    assert!(paused);
    assert_eq!(recorded_names(&fixture.root), ["secure"]);
}
