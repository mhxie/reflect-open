//! `reflect search <query>` — ranked lexical search over the FTS index. The
//! one command that requires the index: missing/unusable is exit 4 (the CLI
//! never builds or repairs the index — that's the desktop app's job). A stale
//! index warns and still returns rows.

use std::collections::HashSet;
use std::path::Path;

use reflect_graph_paths::LocalOnlyFolders;
use reflect_index_schema::{INDEX_FILE, REFLECT_DIR};

use crate::app_search::search_app;
use crate::commands::output::{print_json, HitJson, SearchJson};
use crate::commands::warn;
use crate::error::CliError;
use crate::graph::Graph;
use crate::index::{detect_staleness, local_only_folders, open_read_only, IndexOpen, OpenIndex};
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

/// The graph's index, or why search can't run without it (exit 4).
fn open_index(graph: &Graph) -> Result<OpenIndex, CliError> {
    match open_read_only(&graph.root) {
        IndexOpen::Opened(opened) => Ok(opened),
        IndexOpen::Missing => Err(CliError::NoIndex(format!(
            "no search index at {REFLECT_DIR}/{INDEX_FILE} — open this graph in Reflect to build it"
        ))),
        IndexOpen::Unusable(message) => Err(CliError::NoIndex(message)),
    }
}

/// The index's own ranking: every term must match, sentences topped up.
/// Returns whether the index looks stale, the hits, and the graph's
/// local-only folders.
fn lexical_hits(
    graph: &Graph,
    query: &str,
    limit: usize,
) -> Result<(bool, Vec<SearchHit>, Option<LocalOnlyFolders>), CliError> {
    let opened = open_index(graph)?;
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
        Some(match_expr) => search_index(&opened.conn, &match_expr, query, limit)?,
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
    Ok((staleness.is_stale(), hits, local_only))
}

/// How `search` ranks: by the index alone, or by asking the running app.
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum SearchMode {
    Lexical,
    Semantic,
    Hybrid,
}

impl SearchMode {
    fn as_str(self) -> &'static str {
        match self {
            SearchMode::Lexical => "lexical",
            SearchMode::Semantic => "semantic",
            SearchMode::Hybrid => "hybrid",
        }
    }
}

pub fn run(
    graph: &Graph,
    json: bool,
    query: &str,
    limit: usize,
    mode: SearchMode,
) -> Result<(), CliError> {
    let (ran, stale, hits, local_only) = if mode == SearchMode::Lexical {
        let (stale, hits, local_only) = lexical_hits(graph, query, limit)?;
        ("lexical".to_string(), stale, hits, local_only)
    } else {
        // The app's index is live, so ours is read only for the local-only
        // folders the privacy re-check below needs, on this path too.
        let local_only = local_only_folders(&open_index(graph)?.conn)?;
        let answer = search_app(&graph.root, query, mode.as_str(), limit)?;
        let hits = answer
            .results
            .into_iter()
            .map(|hit| SearchHit {
                path: hit.path,
                title: hit.title,
                snippet: hit.snippet,
                score: hit.score,
            })
            .collect();
        (answer.mode, false, hits, local_only)
    };
    let hits: Vec<SearchHit> = hits
        .into_iter()
        .filter(|hit| still_public_on_disk(&graph.root, &hit.path, local_only.as_ref()))
        .collect();

    if json {
        return print_json(&SearchJson {
            query,
            mode: &ran,
            stale,
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
