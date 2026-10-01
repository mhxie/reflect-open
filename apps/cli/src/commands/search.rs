//! `reflect search <query>` — ranked lexical search over the FTS index. The
//! one command that requires the index: missing/unusable is exit 4 (the CLI
//! never builds or repairs the index — that's the desktop app's job). A stale
//! index warns and still returns rows.

use std::collections::HashSet;
use std::path::Path;

use reflect_index_schema::{INDEX_FILE, REFLECT_DIR};

use crate::commands::output::{print_json, HitJson, SearchJson};
use crate::commands::warn;
use crate::error::CliError;
use crate::graph::Graph;
use crate::index::{detect_staleness, local_only_folders, open_read_only, IndexOpen};
use crate::keys::fold_key;
use crate::note_file::{read_note, subject_display_title};
use crate::search::{
    any_term_index, build_fts_any_match, build_fts_match, is_sentence_like, search_index, SearchHit,
};

/// The privacy re-check: the index row said public, but the file's own
/// frontmatter is the truth — a note flagged private after the last index run
/// must not surface. Unreadable, missing, and iCloud-placeholder files fail
/// closed: their current privacy state cannot be proven from disk, and a note
/// inside a local-only folder never passes.
fn still_public_on_disk(
    root: &Path,
    rel_path: &str,
    local_only: Option<&reflect_graph_paths::LocalOnlyFolders>,
) -> bool {
    read_note(root, rel_path, local_only).is_ok()
}

pub fn run(graph: &Graph, json: bool, query: &str, limit: usize) -> Result<(), CliError> {
    let opened = match open_read_only(&graph.root) {
        IndexOpen::Opened(opened) => opened,
        IndexOpen::Missing => {
            return Err(CliError::NoIndex(format!(
                "no search index at {REFLECT_DIR}/{INDEX_FILE} — open this graph in Reflect to build it"
            )))
        }
        IndexOpen::Unusable(message) => return Err(CliError::NoIndex(message)),
    };
    if opened.newer_schema {
        warn("the index schema is newer than this CLI — update Reflect");
    }

    let local_only = local_only_folders(&opened.conn)?;
    let staleness = detect_staleness(&opened.conn, &graph.root, local_only.as_ref())?;
    if staleness.is_stale() {
        warn(format!(
            "the index may be stale ({} file(s) differ from it) — open the graph in Reflect to refresh",
            staleness.total()
        ));
    }

    let mut hits: Vec<SearchHit> = match build_fts_match(query, opened.cjk_column) {
        Some(match_expr) => search_index(&opened.conn, &match_expr, &fold_key(query), limit)?,
        None => Vec::new(),
    };
    // A sentence rarely has every word in one note: top it up with the notes
    // sharing the most, and rarest, of its words, as the app's search does.
    if hits.len() < limit && is_sentence_like(query) {
        if let Some(any_match) = build_fts_any_match(query, opened.cjk_column) {
            let listed: HashSet<String> = hits.iter().map(|hit| hit.path.clone()).collect();
            hits.extend(any_term_index(
                &opened.conn,
                &any_match,
                limit - hits.len(),
                &listed,
            )?);
        }
    }
    let hits: Vec<SearchHit> = hits
        .into_iter()
        .filter(|hit| still_public_on_disk(&graph.root, &hit.path, local_only.as_ref()))
        .collect();

    if json {
        return print_json(&SearchJson {
            query,
            stale: staleness.is_stale(),
            results: hits
                .into_iter()
                .map(|hit| HitJson {
                    path: hit.path,
                    title: hit.title,
                    snippet: hit.snippet,
                    score: hit.score,
                })
                .collect(),
        });
    }
    for hit in &hits {
        println!("{}\t{}", hit.path, subject_display_title(&hit.title));
        if !hit.snippet.is_empty() {
            println!("    {}", hit.snippet.replace('\n', " "));
        }
    }
    Ok(())
}
