//! Command-tier tests: every command takes the open graph and its
//! local-only configuration from `GraphState`, whatever the caller sends.
//! The graph-io behavior under them is tested in `reflect-graph-io`.

mod note_write_command_tests {
    //! The command-tier contract: `note_write` writes only with a revision
    //! check, whatever the caller sends.
    use crate::fs::*;
    use tauri::Manager;

    struct Session {
        app: tauri::App<tauri::test::MockRuntime>,
        _dir: tempfile::TempDir,
        root: PathBuf,
    }

    /// An open graph holding one note, `notes/plan.md`.
    fn session() -> Session {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        app.manage(GraphState::default());
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap().join("graph");
        io::bootstrap(&root).unwrap();
        fs::write(root.join("notes/plan.md"), "# Plan").unwrap();
        {
            let state: State<GraphState> = app.state();
            let mut inner = state.0.lock().unwrap();
            inner.generation = 1;
            inner.root = Some(root.clone());
        }
        Session {
            app,
            _dir: dir,
            root,
        }
    }

    fn write(
        session: &Session,
        path: &str,
        check_contents: Option<bool>,
        expected_contents: Option<&str>,
    ) -> AppResult<NoteWriteOutcome> {
        note_write(
            path.to_string(),
            "# Replaced".to_string(),
            1,
            check_contents,
            expected_contents.map(str::to_string),
            session.app.state(),
        )
    }

    #[test]
    fn an_unchecked_write_is_refused_and_leaves_the_note_intact() {
        let session = session();
        for check_contents in [None, Some(false)] {
            for expected_contents in [None, Some("# Plan")] {
                let refused = write(&session, "notes/plan.md", check_contents, expected_contents)
                    .expect_err("an unchecked write must be refused");
                assert!(matches!(refused, AppError::Parse { .. }), "{refused:?}");
            }
        }
        assert_eq!(
            fs::read_to_string(session.root.join("notes/plan.md")).unwrap(),
            "# Plan"
        );
        // An unchecked write never creates a file either.
        assert!(write(&session, "notes/new.md", None, None).is_err());
        assert!(!session.root.join("notes/new.md").exists());
    }

    #[test]
    fn a_checked_write_lands_over_the_contents_it_names_and_merges_past_them() {
        let session = session();
        let plan = session.root.join("notes/plan.md");
        // `None` names a file that must not exist yet.
        let message = format!("{:?}", write(&session, "notes/plan.md", Some(true), None));
        assert!(message.contains(CHANGED_ON_DISK), "{message}");
        assert_eq!(fs::read_to_string(&plan).unwrap(), "# Plan");

        let landed = write(&session, "notes/plan.md", Some(true), Some("# Plan")).unwrap();
        assert_eq!(landed.merged, None);
        assert_eq!(fs::read_to_string(&plan).unwrap(), "# Replaced");

        // A revision the file moved past merges instead of replacing it.
        fs::write(&plan, "# Plan\n\nedited elsewhere").unwrap();
        let merged = write(&session, "notes/plan.md", Some(true), Some("# Replaced"))
            .unwrap()
            .merged
            .expect("merged");
        assert_eq!(fs::read_to_string(&plan).unwrap(), merged);
        assert!(merged.contains("edited elsewhere"), "{merged}");

        write(&session, "notes/new.md", Some(true), None).unwrap();
        assert_eq!(
            fs::read_to_string(session.root.join("notes/new.md")).unwrap(),
            "# Replaced"
        );
    }

    fn write_keeping_modified(
        session: &Session,
        path: &str,
        expected_contents: &str,
    ) -> AppResult<Option<u64>> {
        note_write_keep_modified(
            path.to_string(),
            "# Replaced".to_string(),
            1,
            expected_contents.to_string(),
            session.app.state(),
        )
    }

    #[test]
    fn a_write_keeping_modified_lands_with_the_old_mtime() {
        let session = session();
        let plan = session.root.join("notes/plan.md");
        let earlier =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000);
        fs::File::options()
            .write(true)
            .open(&plan)
            .unwrap()
            .set_modified(earlier)
            .unwrap();

        let modified_ms = write_keeping_modified(&session, "notes/plan.md", "# Plan").unwrap();
        assert_eq!(fs::read_to_string(&plan).unwrap(), "# Replaced");
        assert_eq!(fs::metadata(&plan).unwrap().modified().unwrap(), earlier);
        assert_eq!(modified_ms, Some(1_600_000_000_000));
    }

    #[test]
    fn a_write_keeping_modified_is_checked_and_never_creates() {
        let session = session();
        let plan = session.root.join("notes/plan.md");
        assert!(write_keeping_modified(&session, "notes/plan.md", "# Stale").is_err());
        assert_eq!(fs::read_to_string(&plan).unwrap(), "# Plan");
        assert!(write_keeping_modified(&session, "notes/new.md", "").is_err());
        assert!(!session.root.join("notes/new.md").exists());
    }
}

#[cfg(unix)]
mod local_only_command_tests {
    //! Command-tier pins: every command takes the open graph's local-only
    //! configuration from `GraphState` and refuses, or flags, through it.
    //! Each refusal has a control run without the configuration.
    use crate::fs::*;
    use reflect_graph_paths::LocalOnlyFolders;
    use std::os::unix::fs::symlink;
    use tauri::Manager;

    struct Session {
        app: tauri::App<tauri::test::MockRuntime>,
        _dir: tempfile::TempDir,
        root: PathBuf,
        raw: PathBuf,
    }

    const FOLDED: &str = "people/\u{17f}ecure/visa.md";

    /// A graph with a real local-only folder (`people/secure`), a linked one
    /// (`finance/secure` into a raw store), and ordinary files beside them.
    fn session(configured: bool) -> Session {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        app.manage(GraphState::default());
        app.manage(assets::AssetUploads::default());
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let (root, raw) = (base.join("graph"), base.join("raw"));
        io::bootstrap(&root).unwrap();
        let files = [
            (root.join("people/secure/visa.md"), "# Visa"),
            (root.join("people/secure/scan.png"), "png"),
            (root.join("people/plan.md"), "# Plan"),
            (root.join("people/photo.png"), "png"),
            (raw.join("finance/secure/bank.md"), "# Bank"),
            (raw.join("finance/secure/statement.png"), "png"),
        ];
        for (path, contents) in files {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
        fs::create_dir_all(root.join("finance")).unwrap();
        symlink(raw.join("finance/secure"), root.join("finance/secure")).unwrap();
        {
            let state: State<GraphState> = app.state();
            let mut inner = state.0.lock().unwrap();
            inner.generation = 1;
            inner.root = Some(root.clone());
            inner.set_local_only(
                configured.then(|| LocalOnlyFolders::new(["secure"], Some(&raw)).unwrap()),
            );
        }
        Session {
            app,
            _dir: dir,
            root,
            raw,
        }
    }

    /// [`session`] with `secure` editable.
    fn editable_session() -> Session {
        let session = session(true);
        session
            .app
            .state::<GraphState>()
            .0
            .lock()
            .unwrap()
            .set_local_only(Some(editable_folders(&session)));
        session
    }

    fn editable_folders(session: &Session) -> LocalOnlyFolders {
        LocalOnlyFolders::new(["secure"], Some(&session.raw))
            .unwrap()
            .with_editable(["secure"])
            .0
    }

    fn folds(session: &Session) -> bool {
        session.root.join(FOLDED).exists()
    }

    fn write_note(
        session: &Session,
        path: &str,
        contents: &str,
        check_contents: Option<bool>,
        expected: Option<&str>,
    ) -> AppResult<NoteWriteOutcome> {
        note_write(
            path.into(),
            contents.into(),
            1,
            check_contents,
            expected.map(str::to_string),
            session.app.state(),
        )
    }

    fn create_note(session: &Session, path: &str, contents: &str) -> AppResult<NoteCreateOutcome> {
        note_create(path.into(), contents.into(), 1, session.app.state())
    }

    /// A move under the graph lock, as the rename pipeline makes it.
    fn move_note(
        session: &Session,
        from: &str,
        to: &str,
        folders: Option<&LocalOnlyFolders>,
    ) -> AppResult<()> {
        with_graph_lock(&session.root, || {
            move_note_file(&session.root, from, to, folders)
        })
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    /// Every file below `dir` with its bytes; links by their target.
    fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut found = Vec::new();
        for entry in walkdir::WalkDir::new(dir).sort_by_file_name() {
            let entry = entry.unwrap();
            let bytes = if entry.path_is_symlink() {
                fs::read_link(entry.path())
                    .unwrap()
                    .into_os_string()
                    .into_encoded_bytes()
            } else if entry.file_type().is_file() {
                fs::read(entry.path()).unwrap()
            } else {
                Vec::new()
            };
            found.push((entry.path().to_path_buf(), bytes));
        }
        found
    }

    /// The names staged in the graph's `.reflect/trash/`, as
    /// `<slot>/<name>` (empty slots included as `<slot>/`).
    #[cfg(desktop)]
    fn trashed(session: &Session) -> Vec<String> {
        let trash = session.root.join(".reflect/trash");
        let Ok(slots) = fs::read_dir(&trash) else {
            return Vec::new();
        };
        let mut found = Vec::new();
        for slot in slots {
            let slot = slot.unwrap().file_name().to_string_lossy().into_owned();
            let names: Vec<String> = fs::read_dir(trash.join(&slot))
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            if names.is_empty() {
                found.push(format!("{slot}/"));
            }
            found.extend(names.into_iter().map(|name| format!("{slot}/{name}")));
        }
        found
    }

    #[test]
    fn a_checked_write_to_an_editable_note_lands_in_the_raw_store() {
        let session = editable_session();
        let bank = session.raw.join("finance/secure/bank.md");
        let graph_before = snapshot(&session.root.join("notes"));

        let written = write_note(
            &session,
            "finance/secure/bank.md",
            "# Bank\n\nedited",
            Some(true),
            Some("# Bank"),
        )
        .unwrap();
        assert_eq!(read(&bank), "# Bank\n\nedited");
        assert_eq!(
            written,
            NoteWriteOutcome {
                modified_ms: modified_ms(&fs::metadata(&bank).unwrap()),
                merged: None,
            }
        );
        // A new note (and its folder) claims a free name.
        write_note(
            &session,
            "finance/secure/2026/plan.md",
            "# Plan",
            Some(true),
            None,
        )
        .unwrap();
        assert_eq!(
            read(&session.raw.join("finance/secure/2026/plan.md")),
            "# Plan"
        );
        // A real editable folder is written in place, in the graph.
        write_note(
            &session,
            "people/secure/visa.md",
            "# Visa\n\nrenewed",
            Some(true),
            Some("# Visa"),
        )
        .unwrap();
        assert_eq!(
            read(&session.root.join("people/secure/visa.md")),
            "# Visa\n\nrenewed"
        );
        // Nothing else in the graph changed, and nothing was left staged.
        assert_eq!(snapshot(&session.root.join("notes")), graph_before);
        assert_eq!(
            fs::read_dir(session.root.join(".reflect/tmp"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn editable_checked_writes_compare_the_revision_returned_by_note_read() {
        let session = editable_session();
        let path = "finance/secure/bank.md";
        let bank = session.raw.join(path);
        for (source, expected) in [
            ("# Bank\r\n\r\nBalance", "# Bank\n\nBalance"),
            (
                "---\r\nprivate: true\r\n---\r\nsecret",
                "---\nprivate: true\n---\nsecret",
            ),
            (
                "---\ntitle: x\rprivate: false\n---\nsecret",
                "---\ntitle: x\rprivate: false\n---\nsecret",
            ),
            (
                "---\ntitle: x\r---\rprivate: true\n---\nsecret",
                "---\ntitle: x\r---\rprivate: true\n---\nsecret",
            ),
        ] {
            fs::write(&bank, source).unwrap();
            let revision = tauri::async_runtime::block_on(note_read(
                path.into(),
                Some(1),
                session.app.state(),
            ))
            .unwrap();
            assert_eq!(revision, expected);
            let written = write_note(&session, path, "# Edited", Some(true), Some(&revision));
            assert_eq!(written.unwrap().merged, None);
            assert_eq!(read(&bank), "# Edited");
        }
    }

    /// A revision the disk moved past, or a normalization that would change
    /// the note's privacy, is not the read revision: the save merges with
    /// the disk text instead of replacing it.
    #[test]
    fn a_normalized_local_only_revision_never_replaces_new_disk_text() {
        let session = editable_session();
        let path = "finance/secure/bank.md";
        let bank = session.raw.join(path);
        fs::write(&bank, "# Bank\r\nBalance").unwrap();
        let revision =
            tauri::async_runtime::block_on(note_read(path.into(), Some(1), session.app.state()))
                .unwrap();
        fs::write(&bank, "# Bank\r\nNew balance").unwrap();
        let merged = write_note(&session, path, "# Edited", Some(true), Some(&revision))
            .unwrap()
            .merged
            .expect("a stale revision merges");
        assert_eq!(read(&bank), merged);
        assert!(merged.contains("New"), "{merged}");

        let ambiguous = "---\ntitle: x\rprivate: false\n---\nsecret";
        fs::write(&bank, ambiguous).unwrap();
        let normalized = reflect_graph_paths::normalize_line_endings(ambiguous.into());
        let merged = write_note(&session, path, "# Edited", Some(true), Some(&normalized))
            .unwrap()
            .merged
            .expect("a privacy-changing normalization is not the read revision");
        assert_eq!(read(&bank), merged);
        assert_ne!(merged, "# Edited");
    }

    #[test]
    fn an_editable_note_is_written_only_with_the_revision_it_names() {
        let session = editable_session();
        let bank = session.raw.join("finance/secure/bank.md");
        let write = |check: Option<bool>, expected: Option<&str>| {
            write_note(
                &session,
                "finance/secure/bank.md",
                "# Ours",
                check,
                expected,
            )
        };
        // Unchecked, whatever it names.
        for check in [None, Some(false)] {
            assert!(matches!(
                write(check, Some("# Bank")).expect_err("refused"),
                AppError::Parse { .. }
            ));
        }
        // A missing revision over an existing file.
        let message = format!("{:?}", write(Some(true), None).expect_err("refused"));
        assert!(message.contains(CHANGED_ON_DISK), "{message}");
        assert_eq!(read(&bank), "# Bank");
        // A revision for a note that is gone.
        let message = format!(
            "{:?}",
            write_note(
                &session,
                "finance/secure/gone.md",
                "# Ours",
                Some(true),
                Some("# Gone")
            )
            .unwrap_err()
        );
        assert!(message.contains(CHANGED_ON_DISK), "{message}");
        assert!(!session.raw.join("finance/secure/gone.md").exists());
        // An iCloud placeholder holds its note's name.
        fs::write(
            session.raw.join("finance/secure/.evicted.md.icloud"),
            "stub",
        )
        .unwrap();
        assert!(
            write_note(
                &session,
                "finance/secure/evicted.md",
                "# Ours",
                Some(true),
                None
            )
            .is_err()
        );
        assert!(!session.raw.join("finance/secure/evicted.md").exists());
        // A stale revision merges with the disk text.
        let merged = write(Some(true), Some("# Stale"))
            .unwrap()
            .merged
            .expect("merged");
        assert_eq!(read(&bank), merged);
    }

    #[test]
    fn a_create_in_an_editable_folder_never_replaces_a_note() {
        let session = editable_session();
        let create = |path: &str| create_note(&session, path, "# New").unwrap();

        assert!(matches!(
            create("finance/secure/bank.md"),
            NoteCreateOutcome::Collision
        ));
        assert_eq!(read(&session.raw.join("finance/secure/bank.md")), "# Bank");
        assert!(matches!(
            create("finance/secure/new.md"),
            NoteCreateOutcome::Created { .. }
        ));
        assert_eq!(read(&session.raw.join("finance/secure/new.md")), "# New");
        assert!(create_note(&session, "finance/secure/new.txt", "x").is_err());
    }

    #[cfg(desktop)]
    #[test]
    fn a_delete_in_an_editable_folder_stages_the_note_before_the_system_trash() {
        let session = editable_session();
        let state = || session.app.state::<GraphState>();
        fs::write(session.raw.join("finance/secure/old.md"), "# Old").unwrap();
        // The system Trash refuses: the note stays in the graph's trash.
        let refusing = os_trash_seam::install(|_| Err(AppError::io("Trash refused")));
        let outcome = note_delete("finance/secure/bank.md".into(), 1, state()).unwrap();
        assert_eq!(outcome.trashed, Trashed::Graph);
        assert_eq!(
            serde_json::to_value(&outcome).unwrap(),
            serde_json::json!({ "trashed": "graph" })
        );
        assert!(!session.raw.join("finance/secure/bank.md").exists());
        let staged = trashed(&session);
        assert_eq!(staged.len(), 1, "{staged:?}");
        let (slot, name) = staged[0].split_once('/').unwrap();
        assert_eq!((slot.len(), name), (32, "bank.md"));
        assert_eq!(
            read(&session.root.join(".reflect/trash").join(&staged[0])),
            "# Bank"
        );
        assert_eq!(
            os_trash_seam::calls(),
            [session.root.join(".reflect/trash").join(&staged[0])]
        );
        drop(refusing);

        // The system Trash takes it: the staged copy leaves the graph.
        let _accepting = os_trash_seam::install(|path| Ok(fs::remove_file(path)?));
        let outcome = note_delete("finance/secure/old.md".into(), 1, state()).unwrap();
        assert_eq!(outcome.trashed, Trashed::System);
        assert!(!session.raw.join("finance/secure/old.md").exists());
        let called = os_trash_seam::calls();
        assert_eq!(called.len(), 1);
        assert!(called[0].starts_with(session.root.join(".reflect/trash")));
        assert!(called[0].ends_with("old.md"));
    }

    #[cfg(desktop)]
    #[test]
    fn a_delete_from_another_volume_stages_beside_the_note_and_drops_its_recovery() {
        let session = editable_session();
        let state = || session.app.state::<GraphState>();
        let delete = |path: &str| note_delete(path.into(), 1, state());
        let keep = |path: &str| {
            tauri::async_runtime::block_on(recovery::note_recovery_write(
                path.into(),
                "unsaved".into(),
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
                None,
                1,
                state(),
            ))
            .unwrap();
        };
        let kept = |path: &str| {
            tauri::async_runtime::block_on(recovery::note_recovery_read(path.into(), 1, state()))
                .unwrap()
        };
        let folder = session.raw.join("finance/secure");
        let _elsewhere = beneath::PretendTrashElsewhere::engage();
        keep("finance/secure/bank.md");

        // Refused: the note goes back under its name, its text stays kept,
        // and nothing is left staged anywhere.
        let refusing = os_trash_seam::install(|_| Err(AppError::io("Trash refused")));
        assert!(delete("finance/secure/bank.md").is_err());
        let called = os_trash_seam::calls();
        assert_eq!(called.len(), 1);
        assert_eq!(called[0].parent().unwrap().parent().unwrap(), folder);
        assert_eq!(read(&folder.join("bank.md")), "# Bank");
        assert!(kept("finance/secure/bank.md").is_some());
        drop(refusing);

        let _accepting = os_trash_seam::install(|path| Ok(fs::remove_file(path)?));
        let outcome = delete("finance/secure/bank.md").unwrap();
        assert_eq!(outcome.trashed, Trashed::System);
        assert!(!folder.join("bank.md").exists());
        assert_eq!(kept("finance/secure/bank.md"), None);
        assert_eq!(trashed(&session), Vec::<String>::new());
        let hidden: Vec<_> = fs::read_dir(&folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter(|name| name.to_string_lossy().starts_with('.'))
            .collect();
        assert!(hidden.is_empty(), "{hidden:?}");
    }

    #[test]
    fn a_moved_editable_note_carries_its_kept_text() {
        let session = editable_session();
        let state = || session.app.state::<GraphState>();
        let (from, to) = ("finance/secure/bank.md", "finance/secure/2026/bank.md");
        tauri::async_runtime::block_on(recovery::note_recovery_write(
            from.into(),
            "unsaved".into(),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            None,
            1,
            state(),
        ))
        .unwrap();
        move_note(&session, from, to, Some(&editable_folders(&session))).unwrap();
        let read = |path: &str| {
            tauri::async_runtime::block_on(recovery::note_recovery_read(path.into(), 1, state()))
                .unwrap()
        };
        assert_eq!(read(from), None);
        let carried = read(to).expect("carried");
        assert_eq!(
            (carried.contents.as_str(), carried.source_revision),
            ("unsaved", None)
        );
    }

    #[cfg(desktop)]
    #[test]
    fn a_symlinked_or_dataless_note_is_never_deleted_or_moved() {
        let session = editable_session();
        let state = || session.app.state::<GraphState>();
        let _trash = os_trash_seam::install(|_| Ok(()));
        symlink(
            session.root.join("people/plan.md"),
            session.raw.join("finance/secure/link.md"),
        )
        .unwrap();
        assert!(note_delete("finance/secure/link.md".into(), 1, state()).is_err());
        assert!(fs::symlink_metadata(session.raw.join("finance/secure/link.md")).is_ok());

        let dataless = beneath::PretendDataless::engage();
        assert!(note_delete("finance/secure/bank.md".into(), 1, state()).is_err());
        assert!(
            move_note(
                &session,
                "finance/secure/bank.md",
                "finance/secure/moved.md",
                Some(&editable_folders(&session)),
            )
            .is_err()
        );
        drop(dataless);
        assert_eq!(read(&session.raw.join("finance/secure/bank.md")), "# Bank");
        assert!(os_trash_seam::calls().is_empty());
        assert_eq!(trashed(&session), Vec::<String>::new());
    }

    #[test]
    fn a_move_stays_inside_editable_folders() {
        let session = editable_session();
        let folders = editable_folders(&session);
        move_note(
            &session,
            "finance/secure/bank.md",
            "finance/secure/2026/bank.md",
            Some(&folders),
        )
        .unwrap();
        assert_eq!(
            read(&session.raw.join("finance/secure/2026/bank.md")),
            "# Bank"
        );
        assert!(!session.raw.join("finance/secure/bank.md").exists());
        // Between two editable folders, a link and a real directory.
        move_note(
            &session,
            "finance/secure/2026/bank.md",
            "people/secure/bank.md",
            Some(&folders),
        )
        .unwrap();
        assert_eq!(read(&session.root.join("people/secure/bank.md")), "# Bank");
        // An occupied destination refuses, both files intact.
        let occupied = move_note(
            &session,
            "people/secure/bank.md",
            "people/secure/visa.md",
            Some(&folders),
        );
        assert!(occupied.is_err());
        assert_eq!(read(&session.root.join("people/secure/visa.md")), "# Visa");

        // Crossing the boundary either way refuses before anything moves.
        for (from, to) in [
            ("people/plan.md", "finance/secure/plan.md"),
            ("people/secure/bank.md", "people/bank.md"),
        ] {
            let message = format!(
                "{:?}",
                move_note(&session, from, to, Some(&folders)).unwrap_err()
            );
            assert!(
                message.contains("crosses a local-only boundary"),
                "{message}"
            );
        }
        assert!(session.root.join("people/plan.md").exists());
        assert!(session.root.join("people/secure/bank.md").exists());
        assert!(!session.raw.join("finance/secure/plan.md").exists());
        assert!(!session.root.join("people/bank.md").exists());
    }

    /// The default contract: without `editable`, a local-only folder takes
    /// no write, create, delete, move, or attachment.
    #[cfg(desktop)]
    #[test]
    fn a_read_only_folder_still_refuses_every_edit() {
        let session = session(true);
        let state = || session.app.state::<GraphState>();
        let _trash = os_trash_seam::install(|_| Ok(()));
        let raw_before = snapshot(&session.raw);
        let graph_before = snapshot(&session.root);
        let folders = LocalOnlyFolders::new(["secure"], Some(&session.raw)).unwrap();

        for (path, expected) in [
            ("finance/secure/bank.md", Some("# Bank")),
            ("finance/secure/new.md", None),
            ("people/secure/visa.md", Some("# Visa")),
        ] {
            assert!(
                write_note(&session, path, "# Ours", Some(true), expected).is_err(),
                "{path}"
            );
        }
        assert!(create_note(&session, "finance/secure/new.md", "x").is_err());
        assert!(note_delete("finance/secure/bank.md".into(), 1, state()).is_err());
        assert!(note_delete("people/secure/visa.md".into(), 1, state()).is_err());
        assert!(
            move_note(
                &session,
                "finance/secure/bank.md",
                "finance/secure/moved.md",
                Some(&folders),
            )
            .is_err()
        );
        let source = session.root.join("people/photo.png");
        assert!(import(&session, &source, "pic.png", "finance/secure/bank.md").is_err());

        assert_eq!(snapshot(&session.raw), raw_before);
        assert_eq!(snapshot(&session.root), graph_before);
        assert!(os_trash_seam::calls().is_empty());
    }

    fn upload(session: &Session, bytes: &[u8], name: &str, note: &str) -> AppResult<String> {
        let id = assets::asset_upload_begin(1, session.app.state(), session.app.state()).unwrap();
        assets::append_chunk(&session.app.state::<assets::AssetUploads>(), &id, bytes).unwrap();
        assets::asset_upload_commit(
            id,
            name.into(),
            note.into(),
            1,
            session.app.state(),
            session.app.state(),
        )
    }

    fn import(session: &Session, source: &Path, name: &str, note: &str) -> AppResult<String> {
        tauri::async_runtime::block_on(assets::asset_import(
            source.to_string_lossy().into_owned(),
            name.into(),
            note.into(),
            1,
            session.app.state(),
        ))
    }

    fn staging_is_empty(session: &Session) -> bool {
        fs::read_dir(session.root.join(".reflect/tmp"))
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true)
    }

    #[test]
    fn an_editable_notes_attachments_stay_in_its_folder() {
        let session = editable_session();
        let assets_before = snapshot(&session.root.join("assets"));
        let source = session.root.join("people/photo.png");

        assert_eq!(
            upload(&session, b"scan", "scan.png", "finance/secure/bank.md").unwrap(),
            "finance/secure/assets/scan.png"
        );
        assert_eq!(
            import(&session, &source, "scan.png", "finance/secure/sub/deep.md").unwrap(),
            "finance/secure/assets/scan-2.png"
        );
        assert_eq!(
            fs::read(session.raw.join("finance/secure/assets/scan.png")).unwrap(),
            b"scan"
        );
        assert_eq!(
            fs::read(session.raw.join("finance/secure/assets/scan-2.png")).unwrap(),
            b"png"
        );
        // A real editable folder keeps them in its own `assets/` too.
        assert_eq!(
            upload(&session, b"id", "id.png", "people/secure/visa.md").unwrap(),
            "people/secure/assets/id.png"
        );
        assert!(session.root.join("people/secure/assets/id.png").is_file());

        assert_eq!(snapshot(&session.root.join("assets")), assets_before);
        assert!(staging_is_empty(&session));

        // Control: an ordinary note's attachments go to `assets/` as before.
        assert_eq!(
            upload(&session, b"chart", "chart.png", "people/plan.md").unwrap(),
            "assets/chart.png"
        );
        assert_eq!(
            fs::read(session.root.join("assets/chart.png")).unwrap(),
            b"chart"
        );
    }

    #[test]
    fn attachments_refuse_hidden_names_and_a_planted_assets_link() {
        let editable = editable_session();
        let source = editable.root.join("people/photo.png");

        // A hidden name, and a path-shaped one.
        for name in [".scan.png", "sub/scan.png"] {
            assert!(upload(&editable, b"x", name, "finance/secure/bank.md").is_err());
            assert!(import(&editable, &source, name, "finance/secure/bank.md").is_err());
        }
        // `<folder>/assets` planted as a link into `notes/`.
        let notes_before = snapshot(&editable.root.join("notes"));
        symlink(
            editable.root.join("notes"),
            editable.raw.join("finance/secure/assets"),
        )
        .unwrap();
        assert!(upload(&editable, b"x", "scan.png", "finance/secure/bank.md").is_err());
        assert!(import(&editable, &source, "scan.png", "finance/secure/bank.md").is_err());
        assert_eq!(snapshot(&editable.root.join("notes")), notes_before);
        assert!(staging_is_empty(&editable));
    }

    #[test]
    fn a_note_in_a_read_only_folder_takes_no_attachment() {
        let read_only = session(true);
        let source = read_only.root.join("people/photo.png");
        let raw_before = snapshot(&read_only.raw);
        let assets_before = snapshot(&read_only.root.join("assets"));
        assert!(upload(&read_only, b"x", "scan.png", "finance/secure/bank.md").is_err());
        assert!(import(&read_only, &source, "scan.png", "people/secure/visa.md").is_err());
        assert_eq!(snapshot(&read_only.raw), raw_before);
        assert_eq!(snapshot(&read_only.root.join("assets")), assets_before);
        assert!(staging_is_empty(&read_only));
    }

    fn shareable(session: &Session, path: &str) -> ShareableNoteRead {
        tauri::async_runtime::block_on(note_read_shareable(
            path.to_string(),
            None,
            session.app.state(),
        ))
        .unwrap_or_else(|err| panic!("{path}: {err:?}"))
    }

    #[test]
    fn shareable_reads_refuse_local_only_notes_however_spelled() {
        let session = session(true);
        symlink(
            session.root.join("people/secure"),
            session.root.join("notes/alias"),
        )
        .unwrap();
        let mut refused = vec![
            "finance/secure/bank.md",
            "people/secure/visa.md",
            "people/SECURE/visa.md",
            "notes/alias/visa.md",
        ];
        if folds(&session) {
            refused.push(FOLDED);
        }
        for path in refused {
            assert!(
                matches!(shareable(&session, path), ShareableNoteRead::LocalOnly),
                "{path}"
            );
        }
        assert!(matches!(
            shareable(&session, "people/plan.md"),
            ShareableNoteRead::Content { content } if content == "# Plan"
        ));
        // The UI read of the same note is allowed: only sharing refuses.
        let read = tauri::async_runtime::block_on(note_read(
            "finance/secure/bank.md".to_string(),
            None,
            session.app.state(),
        ));
        assert_eq!(read.unwrap(), "# Bank");
    }

    #[test]
    fn without_the_configuration_a_real_folder_is_ordinary() {
        let session = session(false);
        assert!(matches!(
            shareable(&session, "people/secure/visa.md"),
            ShareableNoteRead::Content { .. }
        ));
    }

    #[test]
    fn local_reads_report_the_resolved_local_only_status() {
        let session = session(true);
        let local = |path: &str| match tauri::async_runtime::block_on(note_read_local(
            path.to_string(),
            None,
            None,
            session.app.state(),
        )) {
            Ok(LocalNoteRead::Content { local_only, .. }) => local_only,
            other => panic!("{path}: {other:?}"),
        };
        assert!(local("finance/secure/bank.md"));
        assert!(local("people/secure/visa.md"));
        assert!(!local("people/plan.md"));
        if folds(&session) {
            assert!(local(FOLDED));
        }
    }

    #[test]
    fn asset_reads_bound_off_device_refuse_local_only_files() {
        let configured = session(true);
        for path in ["finance/secure/statement.png", "people/secure/scan.png"] {
            assert!(asset_read(path.to_string(), 1, configured.app.state()).is_err());
            assert!(asset_read_binary(path.to_string(), 1, configured.app.state()).is_err());
        }
        assert!(asset_read("people/photo.png".to_string(), 1, configured.app.state()).is_ok());
        // Control: unconfigured, the real folder is ordinary, and the link is
        // still refused by the plain escape guard.
        let plain = session(false);
        assert!(asset_read("people/secure/scan.png".to_string(), 1, plain.app.state()).is_ok());
        assert!(
            asset_read(
                "finance/secure/statement.png".to_string(),
                1,
                plain.app.state()
            )
            .is_err()
        );
    }

    #[test]
    fn writes_through_an_alias_or_folded_spelling_are_refused() {
        let session = session(true);
        let state = || session.app.state::<GraphState>();
        if folds(&session) {
            let created = "people/\u{17f}ecure/new.md".to_string();
            // Checked against the file's real bytes, so only the path refuses.
            let visa = Some("# Visa".to_string());
            assert!(
                note_write(FOLDED.to_string(), "x".into(), 1, Some(true), visa, state()).is_err()
            );
            assert!(note_create(created, "x".into(), 1, state()).is_err());
            assert!(note_delete(FOLDED.to_string(), 1, state()).is_err());
            let folders = LocalOnlyFolders::new(["secure"], None);
            assert!(
                move_note(
                    &session,
                    "people/plan.md",
                    "people/\u{17f}ecure/plan.md",
                    folders.as_ref(),
                )
                .is_err()
            );
            assert!(move_note(&session, FOLDED, "people/visa.md", folders.as_ref()).is_err());
        }
        assert_eq!(
            fs::read_to_string(session.root.join("people/secure/visa.md")).unwrap(),
            "# Visa"
        );
        assert!(session.root.join("people/plan.md").exists());
    }

    /// With the configuration unknown, nothing leaves the device: shareable
    /// note reads, local reads marked `sharing`, and asset reads refuse, even
    /// for an ordinary note; the control session with the configuration known
    /// serves them. An unmarked local read stays on the device and is served
    /// either way.
    #[test]
    fn sharing_pauses_while_the_configuration_is_unknown() {
        for unknown in [true, false] {
            let session = session(true);
            if unknown {
                session
                    .app
                    .state::<GraphState>()
                    .0
                    .lock()
                    .unwrap()
                    .set_local_only_unknown();
            }
            let note = tauri::async_runtime::block_on(note_read_shareable(
                "people/plan.md".to_string(),
                None,
                session.app.state(),
            ));
            let read_local = |sharing| {
                tauri::async_runtime::block_on(note_read_local(
                    "people/plan.md".to_string(),
                    None,
                    sharing,
                    session.app.state(),
                ))
            };
            let shared_local = read_local(Some(true));
            let asset = asset_read("people/photo.png".to_string(), 1, session.app.state());
            let binary = asset_read_binary("people/photo.png".to_string(), 1, session.app.state());
            assert!(matches!(
                read_local(None),
                Ok(LocalNoteRead::Content { .. })
            ));
            if unknown {
                for message in [
                    format!("{:?}", note.expect_err("note")),
                    format!("{:?}", shared_local.expect_err("shared local")),
                    format!("{:?}", asset.expect_err("asset")),
                    format!("{:?}", binary.err().expect("binary")),
                ] {
                    assert!(message.contains("Sharing is paused"), "{message}");
                }
            } else {
                assert!(matches!(note.unwrap(), ShareableNoteRead::Content { .. }));
                assert!(matches!(shared_local, Ok(LocalNoteRead::Content { .. })));
                assert!(asset.is_ok() && binary.is_ok());
            }
        }
    }

    /// Listing an `audio-memos/` linked into a real local-only folder shows
    /// nothing from it (not even an empty recording, which would otherwise
    /// become a note naming it), and no listing reaches into a local-only
    /// folder below it; the control session without folders lists them all.
    #[test]
    fn listings_never_reach_into_a_local_only_folder() {
        for configured in [true, false] {
            let session = session(configured);
            let secure = session.root.join("people/secure");
            fs::write(secure.join("memo.m4a"), "").unwrap();
            symlink(&secure, session.root.join("audio-memos")).unwrap();
            let listed = |dir: &str| -> Vec<String> {
                let mut paths: Vec<String> = dir_list(dir.into(), 1, session.app.state())
                    .unwrap()
                    .into_iter()
                    .map(|file| file.path)
                    .collect();
                paths.sort();
                paths
            };
            let (memos, people) = (listed("audio-memos"), listed("people"));
            if configured {
                assert!(memos.is_empty(), "{memos:?}");
                assert_eq!(people, ["people/photo.png", "people/plan.md"]);
            } else {
                assert!(memos.contains(&"audio-memos/memo.m4a".to_string()));
                assert!(people.contains(&"people/secure/visa.md".to_string()));
            }
        }
    }

    /// `audio-memos/`, `assets/`, and the transcript cache aliased into a real
    /// local-only folder: each command refuses configured and works without.
    #[test]
    fn fixed_write_targets_aliased_into_a_local_only_folder_are_refused() {
        for configured in [true, false] {
            let session = session(configured);
            let secure = session.root.join("people/secure");
            fs::write(secure.join("memo.m4a"), "audio").unwrap();
            symlink(&secure, session.root.join("audio-memos")).unwrap();
            symlink(&secure, session.root.join(".reflect/transcripts")).unwrap();
            fs::remove_dir_all(session.root.join("assets")).unwrap();
            symlink(&secure, session.root.join("assets")).unwrap();
            let source = session.root.join("people/photo.png");
            let state = || session.app.state::<GraphState>();

            let deleted = audio_memo_delete("audio-memos/memo.m4a".into(), 1, state());
            let cached = transcript_cache_write("memo.json".into(), "{}".into(), 1, state());
            let imported = import(&session, &source, "pic.png", "people/plan.md");
            if configured {
                assert!(deleted.is_err() && cached.is_err() && imported.is_err());
                assert!(secure.join("memo.m4a").exists());
                assert!(!secure.join("memo.json").exists());
                assert!(!secure.join("pic.png").exists());
            } else {
                assert!(deleted.is_ok() && cached.is_ok() && imported.is_ok());
                assert!(!secure.join("memo.m4a").exists());
            }
        }
    }
}

mod note_read_shareable_tests {
    //! The shareable read serves visible Markdown only. Every path below
    //! exists on disk, so a refusal is the path policy, never a missing file.
    use crate::fs::*;
    use tauri::Manager;

    type MockApp = tauri::App<tauri::test::MockRuntime>;

    fn open_graph() -> (MockApp, tempfile::TempDir) {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        app.manage(GraphState::default());
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        io::bootstrap(&root).unwrap();
        for (path, contents) in [
            (".git/config", "[remote \"origin\"]"),
            (".reflect/x.md", "# Runtime"),
            ("notes/a.txt", "plain text"),
            ("notes/a.md", "# A"),
            ("assets/a.png.reflect.md", "A chart."),
        ] {
            let path = root.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
        {
            let state: State<GraphState> = app.state();
            let mut inner = state.0.lock().unwrap();
            inner.generation = 1;
            inner.root = Some(root);
        }
        (app, dir)
    }

    fn read(app: &MockApp, path: &str) -> AppResult<ShareableNoteRead> {
        tauri::async_runtime::block_on(note_read_shareable(path.to_string(), None, app.state()))
    }

    #[test]
    fn refuses_hidden_and_non_markdown_paths() {
        let (app, _dir) = open_graph();
        for path in [".git/config", ".reflect/x.md", "notes/a.txt"] {
            let refused = read(&app, path);
            assert!(
                matches!(refused, Err(AppError::Traversal { .. })),
                "{path}: {refused:?}"
            );
        }
    }

    #[test]
    fn still_reads_notes_and_asset_sidecars() {
        let (app, _dir) = open_graph();
        for (path, expected) in [
            ("notes/a.md", "# A"),
            ("assets/a.png.reflect.md", "A chart."),
        ] {
            let served = read(&app, path);
            assert!(
                matches!(&served, Ok(ShareableNoteRead::Content { content }) if content == expected),
                "{path}: {served:?}"
            );
        }
    }
}
