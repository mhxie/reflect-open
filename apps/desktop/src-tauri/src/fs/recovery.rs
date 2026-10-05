//! Unsaved text kept for local-only notes: when a save inside a local-only
//! folder cannot land (the raw store is unmounted, a link was swapped, the
//! file changed underneath), the editor keeps its buffer here so closing the
//! pane or quitting never loses it, and the next open offers it back.
//!
//! One slot per note and editor session under `<graph>/.reflect/recovery/`, owner-only, written
//! atomically through directory descriptors that never follow a link
//! (`beneath`), like the conflict archive keeps resolved-away versions.
//! `.reflect/` never syncs and is never committed. Only paths inside the
//! graph's local-only folders have a slot: everything else is backed up by
//! Git, and its unsaved text has no business outside the note.

use std::path::PathBuf;

use tauri::State;

use crate::error::{AppError, AppResult};

use super::local_only_edit::{self, NoteRecovery};
use super::{ensure_relative, graph_for, note_write_guard, GraphState};

/// Keep `contents` as the unsaved text of the local-only note at `path`,
/// replacing only this editor session's earlier copy.
#[tauri::command]
pub async fn note_recovery_write(
    path: String,
    contents: String,
    owner_id: String,
    source_revision: Option<String>,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<NoteRecovery> {
    let root = recovery_root(&state, generation, &path)?;
    crate::blocking::run_blocking(move || {
        let _guard = note_write_guard();
        local_only_edit::write_recovery(
            &root,
            &path,
            &owner_id,
            source_revision.as_deref(),
            &contents,
        )
    })
    .await
}

/// The kept unsaved text of the local-only note at `path`, or `None`.
///
/// Takes no note write guard: copies land and go with single renames and
/// unlinks, so a read never sees half of one, and opening a note must not
/// wait out a Git pull's checkout.
#[tauri::command]
pub async fn note_recovery_read(
    path: String,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<Option<NoteRecovery>> {
    let root = recovery_root(&state, generation, &path)?;
    crate::blocking::run_blocking(move || local_only_edit::read_recovery(&root, &path)).await
}

/// Drop this version of a session's copy; missing or newer copies stay untouched.
#[tauri::command]
pub async fn note_recovery_clear(
    path: String,
    owner_id: String,
    token: String,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<()> {
    let root = recovery_root(&state, generation, &path)?;
    crate::blocking::run_blocking(move || {
        let _guard = note_write_guard();
        local_only_edit::clear_recovery(&root, &path, &owner_id, &token)
    })
    .await
}

/// The canonical root of the graph `generation` names, when `path` lies in
/// one of its local-only folders.
fn recovery_root(state: &GraphState, generation: u64, path: &str) -> AppResult<PathBuf> {
    let (root, local_only) = graph_for(state, Some(generation))?;
    ensure_relative(path)?;
    if !local_only
        .as_deref()
        .is_some_and(|folders| folders.contains(path))
    {
        return Err(AppError::traversal(format!(
            "only local-only notes keep unsaved text: {path}"
        )));
    }
    Ok(root.canonicalize()?)
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::future::Future;
    use std::os::unix::fs::symlink;
    use std::path::{Path, PathBuf};
    use std::task::{Context, Poll, Waker};

    use reflect_graph_paths::LocalOnlyFolders;
    use tauri::Manager;

    use super::*;

    const OWNER_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OWNER_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn note_recovery_write(
        path: String,
        contents: String,
        owner_id: String,
        source_revision: Option<String>,
        generation: u64,
        state: State<GraphState>,
    ) -> AppResult<NoteRecovery> {
        tauri::async_runtime::block_on(super::note_recovery_write(
            path,
            contents,
            owner_id,
            source_revision,
            generation,
            state,
        ))
    }

    fn note_recovery_read(
        path: String,
        generation: u64,
        state: State<GraphState>,
    ) -> AppResult<Option<NoteRecovery>> {
        tauri::async_runtime::block_on(super::note_recovery_read(path, generation, state))
    }

    fn note_recovery_clear(
        path: String,
        owner_id: String,
        token: String,
        generation: u64,
        state: State<GraphState>,
    ) -> AppResult<()> {
        tauri::async_runtime::block_on(super::note_recovery_clear(
            path, owner_id, token, generation, state,
        ))
    }

    struct Session {
        app: tauri::App<tauri::test::MockRuntime>,
        _dir: tempfile::TempDir,
        root: PathBuf,
    }

    fn session(folders: Option<LocalOnlyFolders>) -> Session {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        app.manage(GraphState::default());
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap().join("graph");
        super::super::io::bootstrap(&root).unwrap();
        {
            let state: State<GraphState> = app.state();
            let mut inner = state.0.lock().unwrap();
            inner.generation = 1;
            inner.root = Some(root.clone());
            inner.set_local_only(folders);
        }
        Session {
            app,
            _dir: dir,
            root,
        }
    }

    fn secure() -> Option<LocalOnlyFolders> {
        LocalOnlyFolders::new(["secure"], None)
    }

    fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut found = Vec::new();
        for entry in walkdir::WalkDir::new(dir).sort_by_file_name() {
            let entry = entry.unwrap();
            let bytes = if entry.file_type().is_file() {
                fs::read(entry.path()).unwrap()
            } else {
                Vec::new()
            };
            found.push((entry.path().to_path_buf(), bytes));
        }
        found
    }

    #[test]
    fn a_recovery_read_never_waits_for_a_pull() {
        let session = session(secure());
        let _pulling = note_write_guard();
        assert_eq!(
            note_recovery_read("finance/secure/bank.md".into(), 1, session.app.state()).unwrap(),
            None
        );
    }

    #[test]
    fn a_recovery_write_waits_for_a_pull_without_blocking_its_command_future() {
        let session = session(secure());
        let guard = note_write_guard();
        let mut write = Box::pin(super::note_recovery_write(
            "finance/secure/bank.md".into(),
            "unsaved".into(),
            OWNER_A.into(),
            None,
            1,
            session.app.state(),
        ));
        let mut context = Context::from_waker(Waker::noop());
        assert!(matches!(write.as_mut().poll(&mut context), Poll::Pending));
        drop(guard);
        assert_eq!(
            tauri::async_runtime::block_on(write).unwrap().contents,
            "unsaved"
        );
    }

    #[test]
    fn unsaved_text_round_trips_in_one_slot_per_session() {
        let session = session(secure());
        let state = || session.app.state::<GraphState>();
        let path = "finance/secure/bank.md";
        assert_eq!(note_recovery_read(path.into(), 1, state()).unwrap(), None);

        let first = note_recovery_write(
            path.into(),
            "first".into(),
            OWNER_A.into(),
            Some("disk".into()),
            1,
            state(),
        )
        .unwrap();
        let latest = note_recovery_write(
            path.into(),
            "# Bank\n\nunsaved".into(),
            OWNER_A.into(),
            Some("disk".into()),
            1,
            state(),
        )
        .unwrap();
        let kept = note_recovery_read(path.into(), 1, state())
            .unwrap()
            .expect("kept");
        assert_eq!(kept.contents, "# Bank\n\nunsaved");
        assert_eq!(kept.token, latest.token);
        assert_ne!(kept.token, first.token);
        assert!(kept.saved_at_ms > 0);
        assert_eq!(
            fs::read_dir(session.root.join(".reflect/recovery"))
                .unwrap()
                .count(),
            1
        );
        // The wire shape the app parses.
        assert_eq!(
            serde_json::to_value(&kept).unwrap(),
            serde_json::json!({
                "ownerId": OWNER_A, "token": kept.token, "sourceRevision": "disk",
                "savedAtMs": kept.saved_at_ms, "contents": kept.contents
            })
        );

        note_recovery_clear(path.into(), OWNER_A.into(), first.token, 1, state()).unwrap();
        assert_eq!(
            note_recovery_read(path.into(), 1, state()).unwrap(),
            Some(kept.clone())
        );
        note_recovery_clear(path.into(), OWNER_A.into(), kept.token.clone(), 1, state()).unwrap();
        assert_eq!(note_recovery_read(path.into(), 1, state()).unwrap(), None);
        note_recovery_clear(path.into(), OWNER_A.into(), kept.token, 1, state()).unwrap();
    }

    #[test]
    fn resolving_one_session_keeps_the_other_sessions_copy() {
        let session = session(secure());
        let state = || session.app.state::<GraphState>();
        let path = "finance/secure/bank.md";
        let first =
            note_recovery_write(path.into(), "A".into(), OWNER_A.into(), None, 1, state()).unwrap();
        let second =
            note_recovery_write(path.into(), "B".into(), OWNER_B.into(), None, 1, state()).unwrap();
        assert_eq!(
            note_recovery_read(path.into(), 1, state()).unwrap(),
            Some(second.clone())
        );

        note_recovery_clear(path.into(), OWNER_B.into(), second.token, 1, state()).unwrap();
        assert_eq!(
            note_recovery_read(path.into(), 1, state()).unwrap(),
            Some(first.clone())
        );
        note_recovery_clear(path.into(), OWNER_A.into(), first.token, 1, state()).unwrap();
        assert_eq!(note_recovery_read(path.into(), 1, state()).unwrap(), None);
    }

    #[test]
    fn only_local_only_paths_of_the_current_graph_have_a_slot() {
        for folders in [secure(), None] {
            let configured = folders.is_some();
            let session = session(folders);
            let state = || session.app.state::<GraphState>();
            for path in ["notes/plan.md", "finance/secure", "../secure/x.md"] {
                assert!(
                    note_recovery_write(path.into(), "x".into(), OWNER_A.into(), None, 1, state())
                        .is_err(),
                    "{path}"
                );
                assert!(
                    note_recovery_read(path.into(), 1, state()).is_err(),
                    "{path}"
                );
                assert!(
                    note_recovery_clear(path.into(), OWNER_A.into(), OWNER_B.into(), 1, state())
                        .is_err(),
                    "{path}"
                );
            }
            // Without folders even a `secure` path has no slot.
            let local = note_recovery_write(
                "finance/secure/x.md".into(),
                "x".into(),
                OWNER_A.into(),
                None,
                1,
                state(),
            );
            assert_eq!(local.is_ok(), configured);
            // A stale generation is refused like every pinned command.
            assert!(note_recovery_read("finance/secure/x.md".into(), 2, state()).is_err());
            if !configured {
                assert!(!session.root.join(".reflect/recovery").exists());
            }
        }
    }

    #[test]
    fn a_recovery_directory_swapped_for_a_symlink_is_refused() {
        let session = session(secure());
        let state = || session.app.state::<GraphState>();
        let notes = session.root.join("notes");
        fs::write(notes.join("kept.md"), "# Kept\n").unwrap();
        symlink(&notes, session.root.join(".reflect/recovery")).unwrap();
        let before = snapshot(&notes);
        let path = "finance/secure/bank.md";

        assert!(note_recovery_write(
            path.into(),
            "unsaved".into(),
            OWNER_A.into(),
            None,
            1,
            state()
        )
        .is_err());
        assert!(note_recovery_read(path.into(), 1, state()).is_err());
        assert!(
            note_recovery_clear(path.into(), OWNER_A.into(), OWNER_B.into(), 1, state()).is_err()
        );
        assert_eq!(snapshot(&notes), before);
    }
}
