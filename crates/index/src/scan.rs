//! The native half of the open-path reconcile (`index_reconcile_scan`).
//!
//! Comparing the file listing against the stored index rows used to happen in
//! the webview: `list_files` serialized every entry over IPC, TS loaded every
//! stored row through the query bridge, and a JS loop with event-loop yields
//! crawled the listing — seconds of overhead on a large graph to conclude,
//! almost always, "nothing changed". This module does the same comparison in
//! native code and returns only the **delta**, so the TS reconcile touches
//! exactly the files that need work (typically none).

use std::collections::{HashMap, HashSet};
use std::path::Path;

use reflect_graph_paths::LocalOnlyFolders;
use rusqlite::Connection;

use reflect_types::{AppResult, FileMeta, ReconcileScan, ScanCandidate, ScanOrphan};

/// Mirrors `MTIME_TRUST_AGE_MS` in `packages/core/src/indexing/hash.ts`: an
/// mtime match may only skip the read once the file has settled — local write
/// echoes stamp rows at write time, so two same-millisecond saves could
/// otherwise read as "unchanged".
const MTIME_TRUST_AGE_MS: u64 = 5_000;

/// Compare `files` (the note listing) against the stored `notes` rows.
///
/// Classification mirrors the TS reconcile it replaces: an eviction
/// placeholder is present-but-unreadable (never a candidate, never orphaned);
/// a row whose mtime equals the listing and has settled past
/// [`MTIME_TRUST_AGE_MS`] is skipped without a read; everything else — moved
/// mtimes, too-fresh mtimes, and rowless arrivals — is a candidate the TS
/// side reads and hashes (hashes stay the authority for "did content
/// change"). Rows with no listed file are orphans, except those `unreachable`
/// claims: present but out of the walk's reach ([`behind_unfollowed_link`]).
pub(super) fn scan_reconcile(
    conn: &Connection,
    files: &[FileMeta],
    now_ms: u64,
    mut unreachable: impl FnMut(&str) -> bool,
) -> AppResult<ReconcileScan> {
    let mut stored: HashMap<String, (i64, String)> = HashMap::new();
    let mut stmt = conn.prepare_cached("SELECT path, mtime, file_hash FROM notes")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, (row.get(1)?, row.get(2)?)))
    })?;
    for row in rows {
        let (path, facts) = row?;
        stored.insert(path, facts);
    }

    let mut candidates = Vec::new();
    let mut stale_placeholders = Vec::new();
    let mut on_disk: HashSet<&str> = HashSet::with_capacity(files.len());
    for file in files {
        on_disk.insert(file.path.as_str());
        if file.placeholder {
            // Evicted to iCloud — unreadable until re-download, so never a
            // candidate. But when the index has no current row for it, the
            // content is *missing*, not merely offloaded: report it so the
            // caller can request exactly that download.
            let current = stored
                .get(&file.path)
                .is_some_and(|(mtime, _)| *mtime == file.modified_ms as i64);
            if !current {
                stale_placeholders.push(file.path.clone());
            }
            continue;
        }
        let facts = stored.get(&file.path);
        let settled = now_ms.saturating_sub(file.modified_ms) >= MTIME_TRUST_AGE_MS;
        if settled && facts.is_some_and(|(mtime, _)| *mtime == file.modified_ms as i64) {
            continue; // untouched since it was indexed
        }
        candidates.push(ScanCandidate {
            path: file.path.clone(),
            modified_ms: file.modified_ms,
            stored_mtime: facts.map(|(mtime, _)| *mtime),
            stored_hash: facts.map(|(_, hash)| hash.clone()),
        });
    }

    let mut orphans: Vec<ScanOrphan> = stored
        .into_iter()
        .filter(|(path, _)| !on_disk.contains(path.as_str()) && !unreachable(path))
        .map(|(path, (stored_mtime, stored_hash))| ScanOrphan {
            path,
            stored_mtime,
            stored_hash,
        })
        .collect();
    // HashMap iteration order is arbitrary; a stable order keeps move-healing
    // pairing and removal deterministic across runs.
    orphans.sort_by(|first, second| first.path.cmp(&second.path));

    Ok(ReconcileScan {
        total: files.len() as u64,
        candidates,
        orphans,
        stale_placeholders,
    })
}

/// Whether a stored row lies behind a local-only link the walk could not
/// follow: the first configured folder on its path that is a symlink has no
/// allowed target ([`LocalOnlyFolders::link_target`]: the raw store is
/// unmounted, the link dangles, or `rawRoot` is unusable). The listing says
/// nothing about such a note, so its row is kept rather than orphaned —
/// dropping it would lose the private references the asset privacy gate
/// counts, and force a full re-index once the store is back. A real
/// local-only directory, or a link the walk follows, is listed as usual and
/// its vanished notes are ordinary orphans. Verdicts are cached per folder.
pub(super) fn behind_unfollowed_link<'folders>(
    root: &'folders Path,
    folders: &'folders LocalOnlyFolders,
) -> impl FnMut(&str) -> bool + 'folders {
    // Per folder prefix: `None` for anything but a symlink (walked as
    // usual), else whether the walk could not follow it.
    let mut verdicts: HashMap<String, Option<bool>> = HashMap::new();
    move |path: &str| {
        if !folders.contains(path) {
            return false;
        }
        let components: Vec<&str> = path
            .split('/')
            .filter(|component| !component.is_empty() && *component != ".")
            .collect();
        let directories = &components[..components.len().saturating_sub(1)];
        let mut prefix = String::new();
        for directory in directories {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(directory);
            if !folders.is_folder_name(directory) {
                continue;
            }
            let verdict = *verdicts.entry(prefix.clone()).or_insert_with(|| {
                let is_link = std::fs::symlink_metadata(root.join(&prefix))
                    .is_ok_and(|meta| meta.file_type().is_symlink());
                is_link.then(|| folders.link_target(root, Path::new(&prefix)).is_none())
            });
            if let Some(unfollowed) = verdict {
                // The walk follows at most one link per path: the first.
                return unfollowed;
            }
        }
        false
    }
}
