//! End-to-end tests: run the real `reflect` binary against fixture graphs.
//! Index fixtures are built with the shared `reflect-index-schema` migrations
//! plus direct row inserts that mirror the desktop's `apply_note` write path
//! (`apps/desktop/src-tauri/src/db/write.rs`), so the CLI is tested against
//! the schema the app actually writes.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use rusqlite::params;
use tempfile::TempDir;

use reflect_cli::hash::hash_content;
use reflect_cli::keys::fold_key;
use reflect_cli::note_file::parse_note_meta;
use reflect_cli::paths::{daily_path, today_date};
use reflect_index_schema::cjk::cjk_column_text;

/// `note_claims.tier` values (the desktop's `claim_tier`): lower wins.
const TIER_DAILY_DATE: i64 = 1;
const TIER_TITLE: i64 = 2;
const TIER_ALIAS: i64 = 3;
const TIER_BASENAME: i64 = 4;

struct Fixture {
    dir: TempDir,
}

impl Fixture {
    fn root(&self) -> &Path {
        self.dir.path()
    }

    fn write_note(&self, rel_path: &str, content: &str) -> PathBuf {
        let absolute = self.root().join(rel_path);
        fs::create_dir_all(absolute.parent().unwrap()).unwrap();
        fs::write(&absolute, content).unwrap();
        absolute
    }

    /// Index every note on disk the way the desktop pipeline would: derived
    /// title/aliases/private, content hash, file mtime, FTS row.
    fn build_index(&self) {
        let conn = reflect_index_schema::open_index_at(self.root()).unwrap();
        for note in reflect_cli::note_file::walk_notes(self.root()) {
            let content = fs::read_to_string(self.root().join(&note.rel_path)).unwrap();
            let meta = parse_note_meta(&note.rel_path, &content);
            let daily_date = reflect_cli::paths::date_from_daily_path(&note.rel_path);
            let kind = if daily_date.is_some() {
                "daily"
            } else {
                "note"
            };
            conn.execute(
                "INSERT INTO notes(path, id, title, title_key, kind, daily_date, is_private,
                                   is_pinned, pinned_order, file_hash, mtime, updated_at, preview)
                 VALUES(?1, ?8, ?2, ?3, ?9, ?4, ?5, 0, NULL, ?6, ?7, ?7, '')",
                params![
                    note.rel_path,
                    meta.title,
                    fold_key(&meta.title),
                    daily_date,
                    i64::from(meta.private),
                    hash_content(&content),
                    note.mtime_ms as i64,
                    meta.id,
                    kind,
                ],
            )
            .unwrap();
            for alias in &meta.aliases {
                conn.execute(
                    "INSERT INTO aliases(note_path, alias, alias_key) VALUES(?1, ?2, ?3)",
                    params![note.rel_path, alias, fold_key(alias)],
                )
                .unwrap();
            }
            // The spellings this note answers to, mirroring the desktop's
            // `projectNoteClaims`: date, title, aliases, filename stem, first
            // claim of a key wins.
            let stem = {
                let filename = note.rel_path.rsplit('/').next().unwrap_or(&note.rel_path);
                filename.strip_suffix(".md").unwrap_or(filename)
            };
            let mut claims: Vec<(String, i64)> = Vec::new();
            let claim = |claims: &mut Vec<(String, i64)>, key: String, tier: i64| {
                if !key.is_empty() && !claims.iter().any(|(existing, _)| *existing == key) {
                    claims.push((key, tier));
                }
            };
            if let Some(date) = daily_date {
                // Calendar-valid only: an impossible `daily/2026-02-31.md` is
                // an ordinary note and must never claim a date.
                if reflect_cli::paths::parse_calendar_date(date).is_some() {
                    claim(&mut claims, date.to_string(), TIER_DAILY_DATE);
                }
            }
            claim(&mut claims, fold_key(&meta.title), TIER_TITLE);
            for alias in &meta.aliases {
                claim(&mut claims, fold_key(alias), TIER_ALIAS);
            }
            claim(&mut claims, fold_key(stem), TIER_BASENAME);
            for (key, tier) in &claims {
                conn.execute(
                    "INSERT INTO note_claims(note_path, key, tier) VALUES(?1, ?2, ?3)",
                    params![note.rel_path, key, tier],
                )
                .unwrap();
            }
            // The `cjk` column as the desktop writer fills it (`db/write.rs`).
            let cjk = format!(
                "{} {}",
                cjk_column_text(&meta.title),
                cjk_column_text(&content)
            );
            conn.execute(
                "INSERT INTO search_fts(path, title, body, cjk) VALUES(?1, ?2, ?3, ?4)",
                params![note.rel_path, meta.title, content, cjk.trim()],
            )
            .unwrap();
        }
    }
}

/// A graph with the standard layout but no index file.
fn graph() -> Fixture {
    let dir = TempDir::new().unwrap();
    for sub in [".reflect", "daily", "notes"] {
        fs::create_dir_all(dir.path().join(sub)).unwrap();
    }
    Fixture { dir }
}

fn reflect(fixture: &Fixture, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_reflect"))
        .args(args)
        .current_dir(fixture.root())
        .env_remove("REFLECT_GRAPH")
        .output()
        .unwrap()
}

fn stdout(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).unwrap()
}

fn stderr(output: &Output) -> String {
    String::from_utf8(output.stderr.clone()).unwrap()
}

fn json(output: &Output) -> serde_json::Value {
    serde_json::from_str(&stdout(output)).unwrap()
}

// ---- today ------------------------------------------------------------------

#[test]
fn today_prints_the_daily_note_with_no_index() {
    let fixture = graph();
    let content = "remember the milk\n";
    fixture.write_note(&daily_path(&today_date()), content);

    let output = reflect(&fixture, &["today"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    assert_eq!(stdout(&output), content);
}

#[test]
fn today_path_prints_the_would_be_path_before_the_file_exists() {
    let fixture = graph();
    let output = reflect(&fixture, &["today", "--path"]);
    assert!(output.status.success());
    let expected = daily_path(&today_date());
    assert!(stdout(&output).trim_end().ends_with(&expected));

    let missing = reflect(&fixture, &["today"]);
    assert_eq!(missing.status.code(), Some(3));
    assert!(stderr(&missing).contains("no daily note"));
}

#[test]
fn today_json_shape() {
    let fixture = graph();
    fixture.write_note(&daily_path(&today_date()), "# Plans\nship it\n");

    let value = json(&reflect(&fixture, &["today", "--json"]));
    assert_eq!(value["date"], today_date());
    assert_eq!(value["path"], daily_path(&today_date()));
    assert_eq!(value["title"], "Plans");
    assert_eq!(value["content"], "# Plans\nship it\n");
    assert!(value["absolutePath"].as_str().unwrap().starts_with('/'));
}

#[test]
fn today_refuses_a_private_daily() {
    let fixture = graph();
    fixture.write_note(
        &daily_path(&today_date()),
        "---\nprivate: true\n---\nsecret plans\n",
    );

    let output = reflect(&fixture, &["today"]);
    assert_eq!(output.status.code(), Some(3));
    assert_eq!(stdout(&output), "");
    assert!(stderr(&output).contains("private"));

    let path_output = reflect(&fixture, &["today", "--path"]);
    assert_eq!(path_output.status.code(), Some(3));
}

// ---- graph resolution ---------------------------------------------------------

#[test]
fn graph_resolves_by_walking_up_from_a_subdirectory() {
    let fixture = graph();
    let content = "found from a subdir\n";
    fixture.write_note(&daily_path(&today_date()), content);

    let output = Command::new(env!("CARGO_BIN_EXE_reflect"))
        .args(["today"])
        .current_dir(fixture.root().join("notes"))
        .env_remove("REFLECT_GRAPH")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(stdout(&output), content);
}

#[test]
fn explicit_graph_flag_rejects_a_non_graph() {
    let fixture = graph();
    let not_a_graph = TempDir::new().unwrap();
    let output = reflect(
        &fixture,
        &["--graph", not_a_graph.path().to_str().unwrap(), "today"],
    );
    assert_eq!(output.status.code(), Some(1));
    assert!(stderr(&output).contains("not a Reflect graph"));
}

#[test]
fn reflect_graph_env_var_resolves_the_graph() {
    let fixture = graph();
    let content = "via env\n";
    fixture.write_note(&daily_path(&today_date()), content);

    let elsewhere = TempDir::new().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_reflect"))
        .args(["today"])
        .current_dir(elsewhere.path())
        .env("REFLECT_GRAPH", fixture.root())
        .output()
        .unwrap();
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    assert_eq!(stdout(&output), content);
}

// ---- search -------------------------------------------------------------------

#[test]
fn search_ranks_hits_and_excludes_private_notes() {
    let fixture = graph();
    fixture.write_note(
        "notes/zebra.md",
        "# Zebra Migration\nzebra migration zebra migration details\n",
    );
    fixture.write_note("notes/other.md", "# Other\nmentions zebra once\n");
    fixture.write_note(
        "notes/secret.md",
        "---\nprivate: true\n---\n# Secret\nzebra zebra zebra\n",
    );
    fixture.build_index();

    let output = reflect(&fixture, &["search", "zebra"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let text = stdout(&output);
    assert!(text.contains("notes/zebra.md"));
    assert!(text.contains("notes/other.md"));
    assert!(!text.contains("secret"));
    let zebra_pos = text.find("notes/zebra.md").unwrap();
    let other_pos = text.find("notes/other.md").unwrap();
    assert!(
        zebra_pos < other_pos,
        "expected zebra.md ranked first:\n{text}"
    );
}

/// Ranking parity with the desktop palette search (`filtered-search.ts`):
/// title hits are bm25-boosted 10× over body hits, so a title-only match must
/// outrank a body-only match.
#[test]
fn search_boosts_title_matches_over_body_matches() {
    let fixture = graph();
    fixture.write_note("notes/title-hit.md", "# Quokka Habitat\nnothing else\n");
    fixture.write_note(
        "notes/body-hit.md",
        "# Unrelated\na quokka appears mid-body\n",
    );
    fixture.build_index();

    let text = stdout(&reflect(&fixture, &["search", "quokka"]));
    let title_pos = text.find("notes/title-hit.md").unwrap();
    let body_pos = text.find("notes/body-hit.md").unwrap();
    assert!(
        title_pos < body_pos,
        "expected the title match ranked first:\n{text}"
    );
}

/// `unicode61` treats an uninterrupted Japanese title as one token. Search
/// therefore supplements MATCH with folded title-substring recall, including
/// common two-character queries that a trigram-only index would miss.
#[test]
fn search_finds_a_short_japanese_term_inside_a_title() {
    let fixture = graph();
    fixture.write_note(
        "notes/title-hit.md",
        "# 来週の東京旅行計画\nan otherwise unrelated body\n",
    );
    fixture.write_note(
        "notes/body-hit.md",
        "# 別のノート\nan otherwise unrelated 東京 body token\n",
    );
    fixture.build_index();

    let text = stdout(&reflect(&fixture, &["search", "東京"]));
    let title_pos = text.find("notes/title-hit.md").unwrap();
    let body_pos = text.find("notes/body-hit.md").unwrap();
    assert!(
        title_pos < body_pos,
        "expected the title substring match before the body match:\n{text}"
    );

    let multi_term = stdout(&reflect(&fixture, &["search", "東京 旅行"]));
    assert!(multi_term.contains("notes/title-hit.md"));
    assert!(!multi_term.contains("notes/body-hit.md"));
}

/// `unicode61` indexes a clause as one token, so a CJK word inside it — or a
/// Latin word written against it, or a lone character ending it — is found
/// only through the `cjk` column.
#[test]
fn search_finds_words_inside_cjk_clauses_through_the_cjk_column() {
    let fixture = graph();
    fixture.write_note(
        "notes/clause.md",
        "# 周记\n我们下周去東京旅行，今天看了Transformer的论文。还有我和小王\n",
    );
    fixture.write_note("notes/other.md", "# Other\nnothing relevant here\n");
    fixture.build_index();

    for query in ["東京", "transformer", "王", "看了Transformer"] {
        let text = stdout(&reflect(&fixture, &["search", query]));
        assert!(
            text.contains("notes/clause.md"),
            "expected {query:?} to find the clause note:\n{text}"
        );
        assert!(!text.contains("notes/other.md"));
    }
}

/// A sentence rarely has every word in one note, so it is topped up with the
/// notes sharing the most, and rarest, of its words, after any note that holds
/// them all; a few keywords stay strict. Private notes never surface.
#[test]
fn search_tops_up_a_sentence_with_partial_matches() {
    let fixture = graph();
    fixture.write_note(
        "notes/storage.md",
        "# Storage\nWombat keeps columnar data on disk.\n",
    );
    fixture.write_note(
        "notes/formats.md",
        "# Formats\ncolumnar formats compress well\n",
    );
    fixture.write_note(
        "notes/secret.md",
        "---\nprivate: true\n---\n# Secret\ncolumnar wombat storage formats\n",
    );
    fixture.write_note("notes/unrelated.md", "# Garden\ntomatoes and basil\n");
    fixture.build_index();

    let sentence = "how does wombat store columnar formats on disk";
    let value = json(&reflect(&fixture, &["search", sentence, "--json"]));
    let paths: Vec<&str> = value["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|hit| hit["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["notes/storage.md", "notes/formats.md"], "{value}");

    // Two keywords that no note holds together: strict, so nothing.
    let strict = stdout(&reflect(&fixture, &["search", "wombat tomatoes"]));
    assert!(strict.trim().is_empty(), "{strict}");
}

/// An index the app hasn't migrated to the `cjk` column yet (schema 22) is
/// searched by title and body alone rather than failing on the column.
#[test]
fn search_on_an_index_without_the_cjk_column_still_answers() {
    let fixture = graph();
    fixture.write_note("notes/tokyo.md", "# 東京\nbody\n");
    fixture.build_index();
    let conn = rusqlite::Connection::open(fixture.root().join(".reflect/index.sqlite")).unwrap();
    conn.execute_batch(
        "DROP TABLE search_fts;
         CREATE VIRTUAL TABLE search_fts USING fts5(path UNINDEXED, title, body);
         INSERT INTO search_fts(path, title, body) VALUES('notes/tokyo.md', '東京', 'body');
         PRAGMA user_version = 22;",
    )
    .unwrap();
    drop(conn);

    let output = reflect(&fixture, &["search", "東京"]);
    assert!(output.status.success(), "{output:?}");
    assert!(stdout(&output).contains("notes/tokyo.md"));
}

/// Title recall anchors space-delimited terms at word starts: `car` leads
/// with the title-prefix note, still returns the body match, and never
/// surfaces a mid-word title hit like `Oscar party plans`.
#[test]
fn search_matches_latin_title_terms_at_word_starts_only() {
    let fixture = graph();
    fixture.write_note(
        "notes/car-log.md",
        "# Car maintenance log\nan otherwise unrelated body\n",
    );
    fixture.write_note(
        "notes/oscar.md",
        "# Oscar party plans\nan otherwise unrelated body\n",
    );
    fixture.write_note("notes/garage.md", "# Garage\nthe car needs new brakes\n");
    fixture.build_index();

    let text = stdout(&reflect(&fixture, &["search", "car"]));
    let title_pos = text.find("notes/car-log.md").unwrap();
    let body_pos = text.find("notes/garage.md").unwrap();
    assert!(
        title_pos < body_pos,
        "expected the title-prefix match before the body match:\n{text}"
    );
    assert!(
        !text.contains("notes/oscar.md"),
        "a mid-word title substring must not match:\n{text}"
    );
}

/// Multi-term Latin title recall accepts a prefix of each word while keeping
/// title-only presentation independent of the lexical implementation.
#[test]
fn search_finds_a_multi_term_partial_latin_title() {
    let fixture = graph();
    fixture.write_note("notes/Tim MacCaw.md", "an otherwise unrelated body\n");
    fixture.build_index();

    let text = stdout(&reflect(&fixture, &["search", "Tim Mac"]));
    assert!(
        text.contains("notes/Tim MacCaw.md"),
        "expected the partial title match:\n{text}"
    );

    let value = json(&reflect(&fixture, &["search", "Tim Mac", "--json"]));
    assert_eq!(value["results"][0]["snippet"], "");
    assert_eq!(value["results"][0]["score"], 0.0);
}

#[test]
fn search_keeps_tokenizer_normalized_title_matches_above_body_matches() {
    let fixture = graph();
    fixture.write_note("notes/Café Alpha.md", "an otherwise unrelated body\n");
    fixture.write_note(
        "notes/body-hit.md",
        "# Unrelated note\na cafe appears here\n",
    );
    fixture.build_index();

    let value = json(&reflect(&fixture, &["search", "cafe", "--json"]));
    assert_eq!(value["results"][0]["path"], "notes/Café Alpha.md");
    assert_eq!(value["results"][0]["snippet"], "");
    assert!(value["results"][0]["score"].as_f64().unwrap() < 0.0);
    assert_eq!(value["results"][1]["path"], "notes/body-hit.md");
}

#[test]
fn search_breaks_title_prefix_ties_by_pinned_then_recency() {
    let fixture = graph();
    fixture.write_note(
        "notes/Tim MacCaw Extended Project Planning.md",
        "an otherwise unrelated body\n",
    );
    fixture.write_note("notes/Tim MacRae.md", "an otherwise unrelated body\n");
    fixture.build_index();

    let conn = rusqlite::Connection::open(fixture.root().join(".reflect/index.sqlite")).unwrap();
    conn.execute(
        "UPDATE notes SET mtime = 100, is_pinned = 1 WHERE path = 'notes/Tim MacCaw Extended Project Planning.md'",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE notes SET mtime = 200, is_pinned = 0 WHERE path = 'notes/Tim MacRae.md'",
        [],
    )
    .unwrap();
    drop(conn);

    let text = stdout(&reflect(&fixture, &["search", "Tim Mac"]));
    let pinned_pos = text
        .find("notes/Tim MacCaw Extended Project Planning.md")
        .unwrap();
    let plain_pos = text.find("notes/Tim MacRae.md").unwrap();
    assert!(
        pinned_pos < plain_pos,
        "expected pinning to break the title-prefix tie:\n{text}"
    );
}

/// Body search uses the same word-prefix behavior as title recall, so users
/// get results while they are still typing each term.
#[test]
fn search_finds_partial_terms_in_note_bodies() {
    let fixture = graph();
    fixture.write_note(
        "notes/security-rollout.md",
        "# Security Rollout\nthe plan covers authentication migration\n",
    );
    fixture.build_index();

    let text = stdout(&reflect(&fixture, &["search", "authent migr"]));
    assert!(
        text.contains("notes/security-rollout.md"),
        "expected partial body terms to match:\n{text}"
    );

    let mixed = stdout(&reflect(&fixture, &["search", "secur migr"]));
    assert!(
        mixed.contains("notes/security-rollout.md"),
        "expected partial title and body terms to match together:\n{mixed}"
    );
}

/// A term of punctuation alone tokenizes to an empty FTS phrase, which would
/// empty the whole `AND` chain; it is dropped, while a query of nothing but
/// punctuation still matches nothing.
#[test]
fn search_ignores_terms_that_tokenize_to_nothing() {
    let fixture = graph();
    fixture.write_note(
        "notes/meeting-notes.md",
        "# Meeting Notes\nagenda items for the sync\n",
    );
    fixture.build_index();

    let text = stdout(&reflect(&fixture, &["search", "meeting - notes"]));
    assert!(
        text.contains("notes/meeting-notes.md"),
        "expected the punctuation term to be ignored:\n{text}"
    );

    let punctuation = stdout(&reflect(&fixture, &["search", ". -"]));
    assert!(
        !punctuation.contains("notes/meeting-notes.md"),
        "expected a punctuation-only query to match nothing:\n{punctuation}"
    );
}

/// The V1-style exact-title boost (`filtered-search.ts`): a note whose title
/// *is* the query ranks ahead of a louder lexical (bm25) match whose title only
/// contains the query among other words — exact title is promoted before bm25.
#[test]
fn search_promotes_exact_title_over_a_stronger_lexical_match() {
    let fixture = graph();
    fixture.write_note("notes/exact.md", "# Zebra\na single zebra\n");
    fixture.write_note(
        "notes/loud.md",
        "# Zebra Zebra Zebra Notes\nzebra zebra zebra zebra\n",
    );
    fixture.build_index();

    let text = stdout(&reflect(&fixture, &["search", "zebra"]));
    let exact_pos = text.find("notes/exact.md").unwrap();
    let loud_pos = text.find("notes/loud.md").unwrap();
    assert!(
        exact_pos < loud_pos,
        "expected the exact-title note ranked first:\n{text}"
    );
}

/// Pinned and recency are tiebreakers *after* exact-title and bm25 ordering:
/// two equally-ranked body hits order pinned-first, and pinned wins over a
/// newer mtime (mirrors the desktop's lexical ordering).
#[test]
fn search_breaks_ties_by_pinned_then_recency() {
    let fixture = graph();
    fixture.write_note("notes/older-pinned.md", "# Notes\napricot apricot\n");
    fixture.write_note("notes/newer-plain.md", "# Notes\napricot apricot\n");
    fixture.build_index();

    // Identical title + body → identical title-rank and bm25; only the
    // tiebreakers differ. Pin the older note: pinned must win over recency.
    let conn = rusqlite::Connection::open(fixture.root().join(".reflect/index.sqlite")).unwrap();
    conn.execute(
        "UPDATE notes SET mtime = 100, is_pinned = 1 WHERE path = 'notes/older-pinned.md'",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE notes SET mtime = 200, is_pinned = 0 WHERE path = 'notes/newer-plain.md'",
        [],
    )
    .unwrap();
    drop(conn);

    let text = stdout(&reflect(&fixture, &["search", "apricot"]));
    let pinned_pos = text.find("notes/older-pinned.md").unwrap();
    let plain_pos = text.find("notes/newer-plain.md").unwrap();
    assert!(
        pinned_pos < plain_pos,
        "expected the pinned note ranked before the newer unpinned note:\n{text}"
    );
}

#[test]
fn search_without_an_index_exits_4() {
    let fixture = graph();
    fixture.write_note("notes/a.md", "anything\n");
    let output = reflect(&fixture, &["search", "anything"]);
    assert_eq!(output.status.code(), Some(4));
    assert!(stderr(&output).contains("no search index"));
}

#[test]
fn search_warns_when_the_index_is_stale_but_still_returns_rows() {
    let fixture = graph();
    fixture.write_note("notes/a.md", "alpha content here\n");
    fixture.build_index();
    // An external edit after indexing: same mtime gate can't catch everything,
    // so force divergence (older mtime in the index row + different hash).
    let conn = rusqlite::Connection::open(fixture.root().join(".reflect/index.sqlite")).unwrap();
    conn.execute("UPDATE notes SET mtime = 1, file_hash = 'stale'", [])
        .unwrap();
    drop(conn);

    let output = reflect(&fixture, &["search", "alpha"]);
    assert!(output.status.success());
    assert!(stderr(&output).contains("stale"));
    assert!(stdout(&output).contains("notes/a.md"));

    let value = json(&reflect(&fixture, &["search", "alpha", "--json"]));
    assert_eq!(value["stale"], true);
}

#[test]
fn search_fails_closed_when_an_indexed_note_is_unavailable() {
    let fixture = graph();
    let note = fixture.write_note("Projects/plan.md", "# Plan\nsecret searchable text\n");
    fixture.build_index();
    fs::remove_file(note).unwrap();
    fs::write(
        fixture.root().join("Projects/.plan.md.icloud"),
        b"placeholder",
    )
    .unwrap();

    let output = reflect(&fixture, &["search", "searchable"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    assert_eq!(stdout(&output), "");
}

#[cfg(unix)]
#[test]
fn stale_index_never_follows_a_note_replaced_by_a_symlink() {
    use std::os::unix::fs::symlink;

    let fixture = graph();
    let note = fixture.write_note("Projects/plan.md", "# Plan\nindexed text\n");
    fixture.build_index();
    let outside = tempfile::NamedTempFile::new().unwrap();
    fs::write(outside.path(), "outside secret\n").unwrap();
    fs::remove_file(note).unwrap();
    symlink(outside.path(), fixture.root().join("Projects/plan.md")).unwrap();

    let show = reflect(&fixture, &["show", "Plan"]);
    assert!(!show.status.success());
    assert!(!stdout(&show).contains("outside secret"));

    let search = reflect(&fixture, &["search", "indexed"]);
    assert!(search.status.success(), "stderr: {}", stderr(&search));
    assert_eq!(stdout(&search), "");
}

#[test]
fn search_json_shape() {
    let fixture = graph();
    fixture.write_note("notes/a.md", "# Alpha\nsearchable text\n");
    fixture.build_index();

    let value = json(&reflect(&fixture, &["search", "searchable", "--json"]));
    assert_eq!(value["query"], "searchable");
    assert_eq!(value["mode"], "lexical");
    assert_eq!(value["stale"], false);
    let results = value["results"].as_array().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["path"], "notes/a.md");
    assert_eq!(results[0]["title"], "Alpha");
    assert!(results[0]["snippet"]
        .as_str()
        .unwrap()
        .contains("searchable"));
    assert!(results[0]["score"].is_number());
}

/// A stand-in for the app's search socket: answers one connection with
/// `reply` and hands back the request line it read.
#[cfg(unix)]
fn serve_search_once(fixture: &Fixture, reply: &str) -> std::thread::JoinHandle<String> {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;

    let listener = UnixListener::bind(fixture.root().join(".reflect/search.sock")).unwrap();
    let reply = format!("{reply}\n");
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = String::new();
        BufReader::new(stream.try_clone().unwrap())
            .read_line(&mut request)
            .unwrap();
        stream.write_all(reply.as_bytes()).unwrap();
        request
    })
}

/// Hybrid search asks the app over the socket, reports the mode the app ran,
/// and still re-checks every path against the file: a note the app's index
/// thinks public but whose file says `private: true` never prints.
#[cfg(unix)]
#[test]
fn search_hybrid_asks_the_app_and_keeps_the_privacy_recheck() {
    let fixture = graph();
    fixture.write_note("notes/a.md", "# Alpha\nwombat storage\n");
    fixture.write_note(
        "notes/secret.md",
        "---\nprivate: true\n---\n# Secret\nwombat\n",
    );
    fixture.build_index();
    let server = serve_search_once(
        &fixture,
        r#"{"mode":"hybrid","results":[
            {"path":"notes/a.md","title":"Alpha","snippet":"wombat storage","score":0.03},
            {"path":"notes/secret.md","title":"Secret","snippet":"wombat","score":0.02}]}"#
            .replace('\n', "")
            .as_str(),
    );

    let output = reflect(
        &fixture,
        &["search", "wombat", "--mode", "hybrid", "--json"],
    );
    assert!(output.status.success(), "{}", stderr(&output));
    let value = json(&output);
    assert_eq!(value["mode"], "hybrid");
    let paths: Vec<&str> = value["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|hit| hit["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["notes/a.md"]);

    let request: serde_json::Value = serde_json::from_str(&server.join().unwrap()).unwrap();
    assert_eq!(
        request,
        serde_json::json!({ "v": 1, "query": "wombat", "mode": "hybrid", "limit": 20 })
    );
}

/// No app serving the graph, or an app that couldn't answer: exit 5, so a
/// caller can fall back to lexical search or another engine.
#[cfg(unix)]
#[test]
fn semantic_search_without_a_serving_app_exits_5() {
    let fixture = graph();
    fixture.build_index();
    let output = reflect(&fixture, &["search", "wombat", "--mode", "semantic"]);
    assert_eq!(output.status.code(), Some(5));
    assert!(stderr(&output).contains("open it in the Reflect app"));

    let server = serve_search_once(&fixture, r#"{"error":"the index is closed"}"#);
    let output = reflect(&fixture, &["search", "wombat", "--mode", "semantic"]);
    server.join().unwrap();
    assert_eq!(output.status.code(), Some(5));
    assert!(stderr(&output).contains("the index is closed"));
}

#[test]
fn search_drops_a_note_flagged_private_after_indexing() {
    let fixture = graph();
    let note = fixture.write_note("notes/a.md", "# Alpha\nsearchable text\n");
    fixture.build_index();
    fs::write(&note, "---\nprivate: true\n---\n# Alpha\nsearchable text\n").unwrap();

    let output = reflect(&fixture, &["search", "searchable"]);
    assert!(output.status.success());
    assert_eq!(stdout(&output), "", "a just-flagged note must not surface");
}

// ---- show / path ----------------------------------------------------------------

#[test]
fn show_resolves_by_title_alias_date_and_path() {
    let fixture = graph();
    fixture.write_note(
        "notes/project-x.md",
        "---\naliases: [PX]\n---\n# Project X\nthe plan\n",
    );
    fixture.write_note("daily/2026-01-02.md", "daily body\n");
    fixture.build_index();

    for arg in ["Project X", "project x", "PX", "notes/project-x.md"] {
        let output = reflect(&fixture, &["show", arg]);
        assert!(output.status.success(), "show {arg}: {}", stderr(&output));
        assert!(stdout(&output).contains("the plan"), "show {arg}");
    }
    let by_date = reflect(&fixture, &["show", "2026-01-02"]);
    assert_eq!(stdout(&by_date), "daily body\n");

    let missing_daily = reflect(&fixture, &["show", "2026-01-03"]);
    assert_eq!(missing_daily.status.code(), Some(3));

    let unknown = reflect(&fixture, &["show", "No Such Note"]);
    assert_eq!(unknown.status.code(), Some(3));
    assert!(stderr(&unknown).contains("no note matching"));
}

#[test]
fn show_resolves_by_title_and_alias_without_an_index() {
    let fixture = graph();
    fixture.write_note(
        "notes/project-x.md",
        "---\naliases: [PX]\n---\n# Project X\nthe plan\n",
    );

    for arg in ["project x", "PX"] {
        let output = reflect(&fixture, &["show", arg]);
        assert!(output.status.success(), "show {arg}: {}", stderr(&output));
        assert!(stdout(&output).contains("the plan"));
    }
}

#[test]
fn show_blocks_a_private_note_even_when_the_index_says_public() {
    let fixture = graph();
    let note = fixture.write_note("notes/a.md", "# Alpha\npublic at index time\n");
    fixture.build_index();
    fs::write(&note, "---\nprivate: true\n---\n# Alpha\nnow secret\n").unwrap();

    let output = reflect(&fixture, &["show", "Alpha"]);
    assert_eq!(output.status.code(), Some(3));
    assert_eq!(stdout(&output), "");
    assert!(stderr(&output).contains("private"));

    let path_output = reflect(&fixture, &["path", "Alpha"]);
    assert_eq!(path_output.status.code(), Some(3));
}

#[test]
fn show_json_includes_the_daily_date() {
    let fixture = graph();
    fixture.write_note("daily/2026-01-02.md", "daily body\n");

    let value = json(&reflect(&fixture, &["show", "2026-01-02", "--json"]));
    assert_eq!(value["date"], "2026-01-02");
    assert_eq!(value["path"], "daily/2026-01-02.md");
    assert_eq!(value["title"], "2026-01-02");
    assert_eq!(value["content"], "daily body\n");
}

#[test]
fn path_resolves_notes_and_would_be_dailies() {
    let fixture = graph();
    fixture.write_note("notes/project-x.md", "# Project X\n");
    fixture.build_index();

    let by_title = reflect(&fixture, &["path", "Project X"]);
    assert!(by_title.status.success());
    assert!(stdout(&by_title).trim_end().ends_with("notes/project-x.md"));

    let value = json(&reflect(&fixture, &["path", "2099-01-01", "--json"]));
    assert_eq!(value["date"], "2099-01-01");
    assert_eq!(value["path"], "daily/2099-01-01.md");
    assert_eq!(value["exists"], false);

    let existing = json(&reflect(
        &fixture,
        &["path", "notes/project-x.md", "--json"],
    ));
    assert_eq!(existing["exists"], true);
    assert!(existing.get("date").is_none());
}

// ---- open -----------------------------------------------------------------------

#[test]
fn open_print_prefers_the_frontmatter_id() {
    let fixture = graph();
    fixture.write_note(
        "notes/project-x.md",
        "---\nid: 01hzy3v9k2m4n6p8q0r2s4t6vw\n---\n# Project X\n",
    );
    fixture.build_index();

    let output = reflect(&fixture, &["open", "Project X", "--print"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    assert_eq!(
        stdout(&output),
        "reflect://note/01hzy3v9k2m4n6p8q0r2s4t6vw\n"
    );
}

#[test]
fn open_print_falls_back_to_the_encoded_path_without_an_id() {
    let fixture = graph();
    fixture.write_note("notes/no id here.md", "# No Id Here\n");
    fixture.build_index();

    let output = reflect(&fixture, &["open", "No Id Here", "--print"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    assert_eq!(
        stdout(&output),
        "reflect://note/notes%2Fno%20id%20here.md\n"
    );
}

#[test]
fn open_print_gives_dailies_the_date_form_even_before_the_file_exists() {
    let fixture = graph();

    let would_be = reflect(&fixture, &["open", "2099-01-01", "--print"]);
    assert!(would_be.status.success(), "stderr: {}", stderr(&would_be));
    assert_eq!(stdout(&would_be), "reflect://daily/2099-01-01\n");

    // An existing daily resolved by explicit path gets the date form too.
    fixture.write_note("daily/2026-01-02.md", "daily body\n");
    let by_path = reflect(&fixture, &["open", "daily/2026-01-02.md", "--print"]);
    assert_eq!(stdout(&by_path), "reflect://daily/2026-01-02\n");
}

#[test]
fn open_resolves_by_title_and_alias_without_an_index() {
    let fixture = graph();
    fixture.write_note(
        "notes/project-x.md",
        "---\nid: 01hzy3v9k2m4n6p8q0r2s4t6vw\naliases: [PX]\n---\n# Project X\n",
    );

    for arg in ["project x", "PX"] {
        let output = reflect(&fixture, &["open", arg, "--print"]);
        assert!(output.status.success(), "open {arg}: {}", stderr(&output));
        assert_eq!(
            stdout(&output),
            "reflect://note/01hzy3v9k2m4n6p8q0r2s4t6vw\n",
            "open {arg}"
        );
    }
}

#[test]
fn open_refuses_private_notes_and_unknown_targets() {
    let fixture = graph();
    fixture.write_note("notes/a.md", "---\nprivate: true\n---\n# Alpha\n");
    fixture.build_index();

    let private = reflect(&fixture, &["open", "notes/a.md", "--print"]);
    assert_eq!(private.status.code(), Some(3));
    assert_eq!(
        stdout(&private),
        "",
        "a private note's address must not leak"
    );
    assert!(stderr(&private).contains("private"));

    let unknown = reflect(&fixture, &["open", "No Such Note", "--print"]);
    assert_eq!(unknown.status.code(), Some(3));
    assert!(stderr(&unknown).contains("no note matching"));
}

#[test]
fn open_json_shape() {
    let fixture = graph();
    fixture.write_note(
        "notes/project-x.md",
        "---\nid: 01hzy3v9k2m4n6p8q0r2s4t6vw\n---\n# Project X\n",
    );
    fixture.build_index();

    let note = json(&reflect(
        &fixture,
        &["open", "Project X", "--print", "--json"],
    ));
    assert_eq!(note["path"], "notes/project-x.md");
    assert_eq!(note["url"], "reflect://note/01hzy3v9k2m4n6p8q0r2s4t6vw");
    assert_eq!(note["launched"], false);
    assert!(note.get("date").is_none());

    let daily = json(&reflect(
        &fixture,
        &["open", "2026-01-02", "--json", "--print"],
    ));
    assert_eq!(daily["date"], "2026-01-02");
    assert_eq!(daily["path"], "daily/2026-01-02.md");
    assert_eq!(daily["url"], "reflect://daily/2026-01-02");
}

#[test]
fn show_resolves_a_note_by_its_filename_stem() {
    // The H1 differs from the filename: Obsidian's convention. Both spellings
    // must resolve, with or without an index.
    let fixture = graph();
    fixture.write_note("Projects/Plan.md", "# Weekly Planning\nstem body\n");

    let by_stem = reflect(&fixture, &["show", "Plan"]);
    assert!(by_stem.status.success(), "{}", stderr(&by_stem));
    assert!(stdout(&by_stem).contains("stem body"));

    fixture.build_index();
    let indexed = reflect(&fixture, &["show", "Plan"]);
    assert!(indexed.status.success(), "{}", stderr(&indexed));
    assert!(stdout(&indexed).contains("stem body"));
}

#[test]
fn show_prefers_a_title_over_a_filename_stem() {
    let fixture = graph();
    fixture.write_note("Archive/old.md", "# Plan\ntitled body\n");
    fixture.write_note("Projects/Plan.md", "# Weekly Planning\nstem body\n");

    let scanned = reflect(&fixture, &["show", "Plan"]);
    assert!(scanned.status.success(), "{}", stderr(&scanned));
    assert!(stdout(&scanned).contains("titled body"));

    fixture.build_index();
    let indexed = reflect(&fixture, &["show", "Plan"]);
    assert!(indexed.status.success(), "{}", stderr(&indexed));
    assert!(stdout(&indexed).contains("titled body"));
}

#[test]
fn show_resolves_a_nested_vault_path_argument() {
    let fixture = graph();
    fixture.write_note("Projects/deep/Plan.md", "# Anything\nnested body\n");

    let output = reflect(&fixture, &["show", "Projects/deep/Plan.md"]);
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(stdout(&output).contains("nested body"));
}

#[test]
fn scan_resolution_agrees_with_the_index_on_stems() {
    // The same vault answers the same way whether or not `.reflect` has an
    // index — the parity commit 4 exists to keep.
    let fixture = graph();
    fixture.write_note("a/Plan.md", "# One Thing\nfirst body\n");
    fixture.write_note("b/Plan.md", "# Another Thing\nsecond body\n");

    let scanned = reflect(&fixture, &["path", "Plan"]);
    assert!(scanned.status.success(), "{}", stderr(&scanned));
    let scanned_path = stdout(&scanned);

    fixture.build_index();
    let indexed = reflect(&fixture, &["path", "Plan"]);
    assert!(indexed.status.success(), "{}", stderr(&indexed));
    assert_eq!(stdout(&indexed), scanned_path);
    assert!(scanned_path.contains("a/Plan.md"));
}

// ---- local-only folders -----------------------------------------------------

/// The record the desktop writes for the fixture's `finance/secure`.
#[cfg(unix)]
const SECURE: &str = r#"["secure"]"#;

/// A graph whose `finance/secure` links into a raw store outside it, indexed
/// the way the desktop does it: the public note by the shared fixture path,
/// the local-only note as a private row the CLI's own walk can never see,
/// and `record` (the raw `index_meta` value, normally the folder names).
#[cfg(unix)]
fn graph_with_local_only_note(record: Option<&str>) -> (Fixture, TempDir) {
    let fixture = graph();
    fixture.write_note("notes/public.md", "# Public\nledger overview\n");
    fixture.build_index();
    let raw = TempDir::new().unwrap();
    let bank = "# Bank\nledger account 1234\n";
    fs::create_dir_all(raw.path().join("secure")).unwrap();
    fs::write(raw.path().join("secure/bank.md"), bank).unwrap();
    fs::create_dir_all(fixture.root().join("finance")).unwrap();
    std::os::unix::fs::symlink(
        raw.path().join("secure"),
        fixture.root().join("finance/secure"),
    )
    .unwrap();

    let conn = rusqlite::Connection::open(fixture.root().join(".reflect/index.sqlite")).unwrap();
    conn.execute(
        "INSERT INTO notes(path, id, title, title_key, kind, daily_date, is_private,
                           is_pinned, pinned_order, file_hash, mtime, updated_at, preview)
         VALUES('finance/secure/bank.md', NULL, 'Bank', 'bank', 'note', NULL, 1, 0, NULL,
                ?1, 1, 1, '')",
        params![hash_content(bank)],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO note_claims(note_path, key, tier) VALUES('finance/secure/bank.md', 'bank', ?1)",
        params![TIER_TITLE],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO search_fts(path, title, body) VALUES('finance/secure/bank.md', 'Bank', ?1)",
        params![bank],
    )
    .unwrap();
    if let Some(record) = record {
        conn.execute(
            "INSERT INTO index_meta(key, value) VALUES(?1, ?2)",
            params![reflect_index_schema::LOCAL_ONLY_FOLDERS_KEY, record],
        )
        .unwrap();
    }
    (fixture, raw)
}

#[cfg(unix)]
#[test]
fn local_only_rows_never_read_as_stale_or_surface_in_search() {
    let (fixture, _raw) = graph_with_local_only_note(Some(SECURE));
    let value = json(&reflect(&fixture, &["search", "ledger", "--json"]));
    assert_eq!(value["stale"], false, "local-only rows must not count");
    let results = value["results"].as_array().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["path"], "notes/public.md");

    // Control: without the desktop's record the hidden row reads as deleted.
    let (unrecorded, _raw) = graph_with_local_only_note(None);
    let value = json(&reflect(&unrecorded, &["search", "ledger", "--json"]));
    assert_eq!(value["stale"], true);
}

/// Answers from the app's socket pass the same re-check: a note in a
/// local-only folder never prints, whatever the app sends back.
#[cfg(unix)]
#[test]
fn app_search_results_skip_local_only_notes() {
    let (fixture, _raw) = graph_with_local_only_note(Some(SECURE));
    let server = serve_search_once(
        &fixture,
        r#"{"mode":"hybrid","results":[
            {"path":"finance/secure/bank.md","title":"Bank","snippet":"ledger","score":0.03},
            {"path":"notes/public.md","title":"Public","snippet":"ledger","score":0.02}]}"#
            .replace('\n', "")
            .as_str(),
    );
    let output = reflect(
        &fixture,
        &["search", "ledger", "--mode", "hybrid", "--json"],
    );
    server.join().unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    let value = json(&output);
    let paths: Vec<&str> = value["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|hit| hit["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["notes/public.md"]);
    assert!(!stdout(&output).contains("1234"));
}

#[cfg(unix)]
#[test]
fn resolving_to_a_local_only_note_is_refused_as_private() {
    let (fixture, _raw) = graph_with_local_only_note(Some(SECURE));
    for command in ["show", "path", "open"] {
        let output = reflect(&fixture, &[command, "Bank", "--json"]);
        assert_eq!(output.status.code(), Some(3), "{command}");
        assert!(stderr(&output).contains("private"), "{command}");
        assert!(!stdout(&output).contains("1234"), "{command}");
    }
}

/// A record that is present but unreadable leaves which notes are local-only
/// unknown, so every note read is refused (exit 3), public notes included:
/// one that does not parse, and one the query cannot read at all (its table
/// renamed away), which must not pass for "no record". The control with a
/// readable record shows the public note.
#[cfg(unix)]
#[test]
fn an_unreadable_local_only_record_refuses_every_note_read() {
    let (unparsable, _raw) = graph_with_local_only_note(Some("not json"));
    let (unqueryable, _raw_too) = graph_with_local_only_note(Some(SECURE));
    rusqlite::Connection::open(unqueryable.root().join(".reflect/index.sqlite"))
        .unwrap()
        .execute_batch("ALTER TABLE index_meta RENAME TO index_meta_old")
        .unwrap();
    let reads: [&[&str]; 5] = [
        &["show", "Public"],
        &["path", "Public"],
        &["open", "Public", "--print"],
        &["search", "ledger"],
        &["search", "ledger", "--mode", "hybrid"],
    ];
    for fixture in [&unparsable, &unqueryable] {
        for args in reads {
            let output = reflect(fixture, args);
            assert_eq!(output.status.code(), Some(3), "{args:?}");
            assert!(
                stderr(&output).contains("record of local-only folders is unreadable"),
                "{args:?}: {}",
                stderr(&output)
            );
            assert!(stdout(&output).is_empty(), "{args:?}");
        }
    }
    let (readable, _raw) = graph_with_local_only_note(Some(SECURE));
    let shown = reflect(&readable, &["show", "Public"]);
    assert!(shown.status.success(), "{}", stderr(&shown));
    assert!(stdout(&shown).contains("ledger overview"));
}

/// Like the desktop, the CLI keeps every recorded name, even one today's
/// rules refuse (here a folder Reflect now manages), so the notes in it stay
/// private; the control without the record shows the same note.
#[cfg(unix)]
#[test]
fn a_recorded_name_todays_rules_refuse_keeps_its_notes_private() {
    let (fixture, _raw) = graph_with_local_only_note(Some(r#"["notes"]"#));
    for command in ["show", "path"] {
        let output = reflect(&fixture, &[command, "Public"]);
        assert_eq!(
            output.status.code(),
            Some(3),
            "{command}: {}",
            stderr(&output)
        );
        assert!(stdout(&output).is_empty(), "{command}");
    }
    let (unrecorded, _raw) = graph_with_local_only_note(None);
    let shown = reflect(&unrecorded, &["show", "Public"]);
    assert!(shown.status.success(), "{}", stderr(&shown));
}

/// An index file that exists but cannot be read (here bytes that are not a
/// database; in practice, say, a write-ahead log only the app can recover)
/// may record local-only folders the CLI cannot see, so `show`, `path` and
/// `open` refuse every note (exit 3), a real-directory local-only note
/// included, and `today` keeps working without the index. Control: with no
/// index file at all, the same graph resolves by scanning the files.
#[test]
fn an_index_that_cannot_be_read_refuses_every_note_read() {
    let fixture = graph();
    fixture.write_note("notes/public.md", "# Public\nledger overview\n");
    fixture.write_note("people/secure/visa.md", "# Visa\npassport 1234\n");
    let index = fixture.root().join(".reflect/index.sqlite");
    fs::write(&index, b"not a database").unwrap();
    let reads: [&[&str]; 4] = [
        &["show", "Public"],
        &["show", "people/secure/visa.md"],
        &["path", "Public"],
        &["open", "Public", "--print"],
    ];
    for args in reads {
        let output = reflect(&fixture, args);
        assert_eq!(
            output.status.code(),
            Some(3),
            "{args:?}: {}",
            stderr(&output)
        );
        assert!(
            stderr(&output).contains("which notes are local-only is unknown"),
            "{args:?}: {}",
            stderr(&output)
        );
        assert!(stdout(&output).is_empty(), "{args:?}");
    }
    assert!(reflect(&fixture, &["today", "--path"]).status.success());

    fs::remove_file(&index).unwrap();
    for args in [&["show", "Public"][..], &["path", "Public"]] {
        let output = reflect(&fixture, args);
        assert!(output.status.success(), "{args:?}: {}", stderr(&output));
    }
}
