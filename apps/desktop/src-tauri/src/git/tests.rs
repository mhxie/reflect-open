//! Command tier: the git commands take what a graph's backup may do from
//! the open graph in `GraphState`, each against a control session. The
//! guards themselves are tested in `reflect-git`.

use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::task::Poll;

use git2::{Oid, Repository, RepositoryInitOptions, Signature};
use reflect_git::{MAX_FILE_BYTES, MergeKind};
use reflect_graph_io::GraphInner;
use reflect_graph_paths::LocalOnlyFolders;
use serde_json::{Value, json};
use tauri::{Listener, Manager};
use tempfile::TempDir;

use crate::error::AppError;
use crate::fs::GraphState;

type App = tauri::App<tauri::test::MockRuntime>;

/// A bare "remote" (libgit2's local transport) and a graph backed up to it.
struct Backup {
    dir: TempDir,
    remote: String,
    graph: PathBuf,
}

fn backup() -> Backup {
    let dir = tempfile::tempdir().unwrap();
    let bare = dir.path().join("remote.git");
    let mut opts = RepositoryInitOptions::new();
    opts.bare(true).initial_head("main");
    Repository::init_opts(&bare, &opts).unwrap();
    let remote = bare.to_string_lossy().into_owned();
    let graph = dir.path().join("graph");
    fs::create_dir_all(&graph).unwrap();
    reflect_git::setup(&graph, Some(remote.clone()), None).unwrap();
    Backup { dir, remote, graph }
}

impl Backup {
    /// Clone the remote as a second device.
    fn second_device(&self) -> PathBuf {
        let root = self.dir.path().join("graph-b");
        Repository::clone(&self.remote, &root).unwrap();
        root
    }
}

fn write(root: &Path, rel: &str, contents: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

fn commit_and_push(root: &Path) {
    let policy = reflect_git::CommitPolicy {
        max_file_bytes: MAX_FILE_BYTES,
        ..reflect_git::CommitPolicy::default()
    };
    assert!(
        reflect_git::commit_all(root, "edit", &policy)
            .unwrap()
            .committed
    );
    assert!(reflect_git::push(root, None, &[]).unwrap().pushed);
}

fn head_tree_paths(root: &Path) -> Vec<String> {
    let repo = Repository::open(root).unwrap();
    let tree = repo.head().unwrap().peel_to_tree().unwrap();
    let mut paths = Vec::new();
    tree.walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
        if entry.kind() == Some(git2::ObjectType::Blob) {
            paths.push(format!("{dir}{}", entry.name().unwrap()));
        }
        git2::TreeWalkResult::Ok
    })
    .unwrap();
    paths
}

/// Merge a separate history (one with a root commit of its own) into
/// `root`'s HEAD, the way another device's unrelated graph arrives; returns
/// that root.
fn join_separate_history(root: &Path) -> Oid {
    let repo = Repository::open(root).unwrap();
    let sig = Signature::now("Device B", "b@example.invalid").unwrap();
    let blob = repo.blob(b"# Old\n").unwrap();
    let mut update = git2::build::TreeUpdateBuilder::new();
    update.upsert("notes/old.md", blob, git2::FileMode::Blob);
    let empty = repo.find_tree(repo.treebuilder(None).unwrap().write().unwrap());
    let separate_tree = repo
        .find_tree(update.create_updated(&repo, &empty.unwrap()).unwrap())
        .unwrap();
    let separate = repo
        .commit(None, &sig, &sig, "Another graph", &separate_tree, &[])
        .unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    let mut update = git2::build::TreeUpdateBuilder::new();
    update.upsert("notes/old.md", blob, git2::FileMode::Blob);
    let tree = repo
        .find_tree(update.create_updated(&repo, &head.tree().unwrap()).unwrap())
        .unwrap();
    let other = repo.find_commit(separate).unwrap();
    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        "Merge changes from other devices",
        &tree,
        &[&head, &other],
    )
    .unwrap();
    separate
}

fn mock_app() -> App {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    app.manage(GraphState::default());
    app
}

/// Open `root` as generation `generation`, configured by `configure`.
fn open(app: &App, root: &Path, generation: u64, configure: impl FnOnce(&mut GraphInner)) {
    let state: tauri::State<GraphState> = app.state();
    let mut inner = state.0.lock().unwrap();
    inner.generation = generation;
    inner.root = Some(root.to_path_buf());
    configure(&mut inner);
}

fn paused_message(err: AppError) -> String {
    let AppError::Io { message, .. } = err else {
        panic!("expected an Io error, got {err:?}");
    };
    message
}

#[test]
fn the_git_commands_take_local_only_folders_from_the_open_graph() {
    for configured in [true, false] {
        let backup = backup();
        let root_a = &backup.graph;
        write(root_a, "people/secure/old.md", "# Old\n");
        write(root_a, "notes/a.md", "# A\n");
        commit_and_push(root_a);
        let root_b = backup.second_device();
        write(&root_b, "people/secure/old.md", "# Old\n\nedited on b\n");
        commit_and_push(&root_b);
        write(root_a, "people/secure/old.md", "# Old\n\nedited on a\n");
        write(root_a, "people/secure/new.md", "# New\n");

        let app = mock_app();
        let folders = LocalOnlyFolders::new(["secure"], None).unwrap();
        open(&app, root_a, 1, |inner| {
            inner.set_local_only(configured.then_some(folders));
        });
        let committed = tauri::async_runtime::block_on(super::git_commit_all(
            "Update notes".to_string(),
            1,
            app.state(),
        ))
        .unwrap();
        tauri::async_runtime::block_on(super::git_fetch(None, 1, app.state())).unwrap();
        let pulled = tauri::async_runtime::block_on(super::git_pull(
            "Update notes".to_string(),
            1,
            app.handle().clone(),
            app.state(),
        ));
        let on_disk = fs::read_to_string(root_a.join("people/secure/old.md")).unwrap();
        if configured {
            // Nothing in the folder is staged, and the other device's edit
            // is recorded in history but never written here.
            assert!(!committed.committed, "{committed:?}");
            let pulled = pulled.unwrap();
            assert_eq!(
                pulled.frozen_paths,
                vec!["people/secure/old.md"],
                "{pulled:?}"
            );
            assert_eq!(on_disk, "# Old\n\nedited on a\n");
            assert!(!head_tree_paths(root_a).contains(&"people/secure/new.md".to_string()));
        } else {
            // Control: the stock commit stages the folder like any other.
            assert!(committed.committed);
            assert!(head_tree_paths(root_a).contains(&"people/secure/new.md".to_string()));
            assert!(pulled.is_err() || pulled.unwrap().frozen_paths.is_empty());
        }
    }
}

/// With the settings file unreadable at open, which folders are local-only
/// is unknown, so commit and pull refuse loudly; the control session
/// (configuration known, here none) commits.
#[test]
fn sync_refuses_while_the_local_only_configuration_is_unknown() {
    for unknown in [true, false] {
        let backup = backup();
        write(&backup.graph, "notes/a.md", "# A\n");
        let app = mock_app();
        open(&app, &backup.graph, 1, |inner| {
            if unknown {
                inner.set_local_only_unknown();
            }
        });
        let committed = tauri::async_runtime::block_on(super::git_commit_all(
            "Update notes".to_string(),
            1,
            app.state(),
        ));
        let pulled = tauri::async_runtime::block_on(super::git_pull(
            "Update notes".to_string(),
            1,
            app.handle().clone(),
            app.state(),
        ));
        if unknown {
            let message = paused_message(committed.expect_err("commit refused"));
            assert!(message.contains("Sync is paused"), "{message}");
            let message = paused_message(pulled.expect_err("pull refused"));
            assert!(message.contains("Sync is paused"), "{message}");
            let repo = Repository::open(&backup.graph).unwrap();
            assert!(
                repo.head()
                    .ok()
                    .and_then(|head| head.peel_to_commit().ok())
                    .is_none()
            );
        } else {
            assert!(committed.unwrap().committed);
            assert!(head_tree_paths(&backup.graph).contains(&"notes/a.md".to_string()));
        }
    }
}

#[test]
fn the_git_commands_take_accepted_roots_from_the_open_graph() {
    for accepted in [false, true] {
        // A pull that would bring in a separate root.
        let backup = backup();
        let root_a = backup.graph.clone();
        write(&root_a, "notes/a.md", "# A\n");
        commit_and_push(&root_a);
        let root_b = backup.second_device();
        let incoming = join_separate_history(&root_b);
        assert!(
            reflect_git::push(&root_b, None, &[incoming])
                .unwrap()
                .pushed
        );
        // A push that would upload one, from another graph.
        let other = self::backup();
        write(&other.graph, "notes/a.md", "# A\n");
        commit_and_push(&other.graph);
        let outgoing = join_separate_history(&other.graph);

        let app = mock_app();
        let roots = if accepted {
            vec![incoming, outgoing]
        } else {
            Vec::new()
        };
        open(&app, &root_a, 1, |inner| {
            inner.set_accepted_history_roots(roots.clone());
        });
        tauri::async_runtime::block_on(super::git_fetch(None, 1, app.state())).unwrap();
        let pulled = tauri::async_runtime::block_on(super::git_pull(
            "Update notes".to_string(),
            1,
            app.handle().clone(),
            app.state(),
        ));
        open(&app, &other.graph, 2, |inner| {
            inner.set_accepted_history_roots(roots);
        });
        let pushed = tauri::async_runtime::block_on(super::git_push(None, 2, app.state()))
            .expect("a push outcome");
        if accepted {
            assert!(matches!(pulled.unwrap().kind, MergeKind::FastForward));
            assert!(pushed.pushed, "{pushed:?}");
        } else {
            let message = paused_message(pulled.expect_err("paused"));
            assert!(message.starts_with("Sync paused:"), "{message}");
            assert!(message.contains(&incoming.to_string()), "{message}");
            assert!(!pushed.pushed && !pushed.non_fast_forward, "{pushed:?}");
            let message = pushed.rejection_message.unwrap_or_default();
            assert!(message.contains(&outgoing.to_string()), "{message}");
        }
    }
}

/// The backup size limit loaded at open applies to commits; the control
/// session (no limit loaded) keeps the default.
#[test]
fn the_commit_takes_the_backup_size_limit_from_the_open_graph() {
    for limited in [true, false] {
        let backup = backup();
        write(&backup.graph, "notes/a.md", "# A\n");
        write(
            &backup.graph,
            "assets/big.bin",
            &"x".repeat(2 * 1024 * 1024),
        );
        let app = mock_app();
        let config = reflect_graph_io::GraphConfig {
            backup_max_file_bytes: limited.then_some(1024 * 1024),
            ..Default::default()
        };
        let info = crate::fs::activate(&app.state(), &backup.graph, config).unwrap();
        let committed = tauri::async_runtime::block_on(super::git_commit_all(
            "Update notes".to_string(),
            info.generation,
            app.state(),
        ))
        .unwrap();
        let paths = head_tree_paths(&backup.graph);
        assert!(paths.contains(&"notes/a.md".to_string()));
        let skipped: Vec<&str> = committed
            .skipped_large_files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        if limited {
            assert_eq!(skipped, vec!["assets/big.bin"]);
            assert!(!paths.contains(&"assets/big.bin".to_string()));
        } else {
            assert!(skipped.is_empty(), "{skipped:?}");
            assert!(paths.contains(&"assets/big.bin".to_string()));
        }
    }
}

/// A graph whose tracked `assets/big.bin` grew past a 16-byte backup size
/// limit on this device after the other device changed it: the next pull's
/// commit withholds it, so the pull moves it aside.
fn withheld_edit_the_remote_changed() -> (Backup, App, u64) {
    let backup = backup();
    let root = &backup.graph;
    write(root, "assets/big.bin", "small at first");
    commit_and_push(root);
    let root_b = backup.second_device();
    write(&root_b, "assets/big.bin", "the phone's version");
    commit_and_push(&root_b);
    write(
        root,
        "assets/big.bin",
        "grown well past the size limit here",
    );
    let app = mock_app();
    let config = reflect_graph_io::GraphConfig {
        backup_max_file_bytes: Some(16),
        ..Default::default()
    };
    let generation = crate::fs::activate(&app.state(), root, config)
        .unwrap()
        .generation;
    tauri::async_runtime::block_on(super::git_fetch(None, generation, app.state())).unwrap();
    (backup, app, generation)
}

/// Every `note:displaced` payload `app` broadcasts from now on.
fn announcements(app: &App) -> Arc<Mutex<Vec<Value>>> {
    let announced: Arc<Mutex<Vec<Value>>> = Arc::default();
    let sink = Arc::clone(&announced);
    app.listen_any(reflect_types::events::NOTE_DISPLACED, move |event| {
        sink.lock()
            .unwrap()
            .push(serde_json::from_str(event.payload()).unwrap());
    });
    announced
}

/// `git_pull` announces every entry left displaced on `note:displaced`,
/// after a pull that landed and after one that failed once the checkout had
/// written the moved entry's path.
#[test]
fn the_pull_command_announces_displaced_notes_on_both_outcomes() {
    for fail in [false, true] {
        let (backup, app, generation) = withheld_edit_the_remote_changed();
        let announced = announcements(&app);
        // A live writer's ref lock: the ref move after the checkout fails.
        let lock = backup.graph.join(".git/refs/heads/main.lock");
        if fail {
            fs::write(&lock, b"").unwrap();
        }
        let pulled = tauri::async_runtime::block_on(super::git_pull(
            "Update notes".to_string(),
            generation,
            app.handle().clone(),
            app.state(),
        ));
        let copy = "assets/big (this device).bin";
        if fail {
            fs::remove_file(&lock).unwrap();
            assert!(pulled.is_err(), "{pulled:?}");
        } else {
            let pulled = pulled.unwrap();
            assert_eq!(pulled.displaced.len(), 1, "{pulled:?}");
            assert_eq!(pulled.displaced[0].to, copy);
        }
        assert_eq!(
            fs::read_to_string(backup.graph.join(copy)).unwrap(),
            "grown well past the size limit here"
        );
        assert_eq!(
            *announced.lock().unwrap(),
            vec![json!({
                "generation": generation,
                "from": "assets/big.bin",
                "to": copy,
                "keptOut": false,
            })],
            "fail={fail}"
        );
    }
}

/// A pull that finishes after the user switched graphs fails its generation
/// check and announces nothing into the new session; what it moved stays
/// beside its path in the graph it pulled.
#[test]
fn a_pull_finishing_after_a_graph_switch_never_announces_into_the_new_session() {
    let (backup, app, generation) = withheld_edit_the_remote_changed();
    let announced = announcements(&app);
    let next_root = backup.dir.path().join("next-graph");
    write(
        &next_root,
        "assets/big.bin",
        "the next graph's same-path file",
    );

    // Hold the graph lock, as a write in flight would, so the pull's commit
    // waits until the switch.
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let held = backup.graph.clone();
    let holder = std::thread::spawn(move || {
        reflect_graph_io::with_graph_lock(&held, || {
            entered_tx.send(()).unwrap();
            let _ = release_rx.recv();
            Ok(())
        })
        .unwrap();
    });
    entered_rx.recv().unwrap();

    let mut command = Box::pin(super::git_pull(
        "Update notes".to_string(),
        generation,
        app.handle().clone(),
        app.state(),
    ));
    let pulled = tauri::async_runtime::block_on(async {
        // Poll through the command's generation check; its blocking pull
        // cannot finish while the lock is held.
        std::future::poll_fn(|context| {
            assert!(command.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
        crate::fs::activate(
            &app.state(),
            &next_root,
            reflect_graph_io::GraphConfig::default(),
        )
        .unwrap();
        release_tx.send(()).unwrap();
        command.await
    });
    holder.join().unwrap();

    let error = pulled.unwrap_err();
    assert!(format!("{error:?}").contains("graph changed"), "{error:?}");
    assert!(announced.lock().unwrap().is_empty());
    assert_eq!(
        fs::read_to_string(backup.graph.join("assets/big (this device).bin")).unwrap(),
        "grown well past the size limit here"
    );
    assert_eq!(
        fs::read_to_string(next_root.join("assets/big.bin")).unwrap(),
        "the next graph's same-path file"
    );
    assert!(!next_root.join("assets/big (this device).bin").exists());
}

/// End to end through the commands: a note grown past the size limit after
/// its last backup, edited on the other device, moves aside on `git_pull`. An
/// open editor still holding the moved revision saves at the old path and is
/// refused, the incoming note untouched; the same save then lands on the
/// copy, where the editor follows on `note:displaced`.
#[test]
fn a_save_naming_a_displaced_note_is_refused_and_lands_on_the_copy() {
    let backup = backup();
    let root = &backup.graph;
    write(root, "notes/a.md", "# A\n");
    commit_and_push(root);
    let root_b = backup.second_device();
    write(&root_b, "notes/a.md", "# A\n\nedited on the phone\n");
    commit_and_push(&root_b);
    let grown = "# A\n\nedited here, past the size limit\n";
    write(root, "notes/a.md", grown);
    let app = mock_app();
    let config = reflect_graph_io::GraphConfig {
        backup_max_file_bytes: Some(16),
        ..Default::default()
    };
    let generation = crate::fs::activate(&app.state(), root, config)
        .unwrap()
        .generation;
    tauri::async_runtime::block_on(super::git_fetch(None, generation, app.state())).unwrap();
    let pulled = tauri::async_runtime::block_on(super::git_pull(
        "Update notes".to_string(),
        generation,
        app.handle().clone(),
        app.state(),
    ))
    .unwrap();
    let copy = "notes/a (this device).md";
    assert_eq!(pulled.displaced.len(), 1, "{pulled:?}");
    assert_eq!(pulled.displaced[0].to, copy);

    let edited = "# A\n\nedited here, and more\n";
    let save = |path: &str| {
        crate::fs::note_write(
            path.to_string(),
            edited.to_string(),
            generation,
            Some(true),
            Some(grown.to_string()),
            app.state(),
        )
    };
    let refused = save("notes/a.md").unwrap_err();
    assert_eq!(refused.message(), reflect_graph_io::CHANGED_ON_DISK);
    assert_eq!(
        fs::read_to_string(root.join("notes/a.md")).unwrap(),
        "# A\n\nedited on the phone\n"
    );
    let landed = save(copy).unwrap();
    assert_eq!(landed.merged, None);
    assert_eq!(fs::read_to_string(root.join(copy)).unwrap(), edited);
}
