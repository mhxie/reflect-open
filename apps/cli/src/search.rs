//! Lexical search over the FTS index. The `MATCH` expression is built exactly
//! like `buildFtsMatch` (`packages/core/src/indexing/search-query.ts`) and
//! ranking matches the desktop's palette search (`filtered-search.ts`): exact,
//! prefix, and all-terms title matches lead, then title-boosted bm25 with the
//! same column weights, pinned, recency, and `path`. Folded title recall
//! matches each term at a title word start — except terms in unsegmented
//! scripts, which match anywhere: FTS5's `unicode61` tokenizer cannot match
//! part of an uninterrupted CJK title (`titleRecallNeedles` in
//! `search-query.ts` is the TS twin). The CLI adds its privacy filter
//! (`notes.is_private = 0`) and FTS5 `snippet()`.

use std::collections::HashSet;

use reflect_index_schema::cjk::{is_unsegmented, letter_segments, run_bigrams, unsegmented_runs};
use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection};
use unicode_normalization::char::is_combining_mark;

use crate::error::CliError;
use crate::keys::contains_unsegmented_script;

const HIGHLIGHT_START: char = '\u{1}';
const HIGHLIGHT_END: char = '\u{2}';

fn public_note_predicate(conn: &Connection) -> Result<&'static str, CliError> {
    let has_device_column: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('notes') WHERE name = 'has_device_only_content')",
        [],
        |row| row.get(0),
    )?;
    Ok(if has_device_column {
        "notes.is_private = 0 AND notes.has_device_only_content = 0"
    } else {
        "notes.is_private = 0"
    })
}

/// Enclosed alphanumerics (`Ⓐ`, `🅰`): general category `So`, which `unicode61`
/// separates on, but which `char::is_alphanumeric` accepts through the
/// `Other_Alphabetic` property. Excluded so this file's token test matches
/// `FTS_TOKEN_CHAR_RE` (`search-query.ts`) codepoint for codepoint.
const LETTERLIKE_SYMBOL_RANGES: [(char, char); 4] = [
    ('\u{24B6}', '\u{24E9}'),
    ('\u{1F130}', '\u{1F149}'),
    ('\u{1F150}', '\u{1F169}'),
    ('\u{1F170}', '\u{1F189}'),
];

/// The `Co` half of `unicode61`'s default `L* N* Co` categories, which
/// `char::is_alphanumeric` does not cover.
fn is_private_use(character: char) -> bool {
    matches!(character, '\u{E000}'..='\u{F8FF}' | '\u{F0000}'..='\u{FFFFD}' | '\u{100000}'..='\u{10FFFD}')
}

/// A character `unicode61` keeps inside a token, i.e. its default `categories`
/// of `'L* N* Co'`. The twin of `FTS_TOKEN_CHAR_RE` (`search-query.ts`): both
/// sides must classify every codepoint alike, since the parity corpus compares
/// their expressions byte for byte.
fn is_fts_token_char(character: char) -> bool {
    if is_private_use(character) {
        return true;
    }
    character.is_alphanumeric()
        && !is_combining_mark(character)
        && !LETTERLIKE_SYMBOL_RANGES
            .iter()
            .any(|(first, last)| character >= *first && character <= *last)
}

/// Whether `unicode61` finds any token in a term, i.e. whether FTS can see it.
fn is_tokenizable(term: &str) -> bool {
    term.chars().any(is_fts_token_char)
}

/// Wrap a term as an FTS5 string literal, doubling quotes (FTS5's own escape).
fn quote_fts_literal(term: &str) -> String {
    format!("\"{}\"", term.replace('"', "\"\""))
}

/// The terms a search constrains on, the twin of `searchTerms`
/// (`search-query.ts`): a term of pure punctuation tokenizes to an empty
/// phrase, which as an operand of the explicit `AND` matches no rows and would
/// take the whole query with it, so it constrains neither the FTS expression
/// nor title recall. When no term survives, the originals are kept: the query
/// is punctuation only, and title recall can still match it literally.
fn search_terms(query: &str) -> Vec<&str> {
    let terms: Vec<&str> = query.split_whitespace().collect();
    let tokenizable: Vec<&str> = terms
        .iter()
        .copied()
        .filter(|term| is_tokenizable(term))
        .collect();
    if tokenizable.is_empty() {
        terms
    } else {
        tokenizable
    }
}

/// Build an FTS5 `MATCH` expression from a free-text query, or `None` when
/// there is nothing to search. Every whitespace-split term is double-quoted
/// (embedded quotes doubled), then matched as a prefix in the title or body
/// column. User operators like `AND`/`*` therefore cannot change the query's
/// meaning or raise syntax errors.
///
/// A punctuation-only query has no tokenizable term to constrain on, so it
/// gets the quoted join: a valid, matchless expression that still lets title
/// recall admit rows.
///
/// `cjk_column` says whether the index has the `cjk` column
/// ([`reflect_index_schema::cjk::COLUMN_SCHEMA_VERSION`] on); an index the app
/// hasn't migrated yet is
/// searched by title and body alone, as before the column existed.
pub fn build_fts_match(query: &str, cjk_column: bool) -> Option<String> {
    let terms = search_terms(query);
    if terms.is_empty() {
        return None;
    }
    if !terms.iter().any(|term| is_tokenizable(term)) {
        return Some(
            terms
                .into_iter()
                .map(quote_fts_literal)
                .collect::<Vec<_>>()
                .join(" "),
        );
    }
    Some(
        terms
            .into_iter()
            .map(|term| {
                let literal = quote_fts_literal(term);
                let mut alternatives =
                    vec![format!("title : {literal}*"), format!("body : {literal}*")];
                if cjk_column {
                    alternatives.push(cjk_term_match(term, &literal));
                }
                format!("({})", alternatives.join(" OR "))
            })
            .collect::<Vec<_>>()
            .join(" AND "),
    )
}

/// A term's match in the `cjk` column. A word written against a run indexes
/// only there; a term holding runs (`用Python写脚本`) matches each run as a
/// substring and each letter stretch in any column, since a note may spell it
/// glued or spaced. The twin of `cjkTermMatch` (`search-query.ts`).
fn cjk_term_match(term: &str, literal: &str) -> String {
    let runs = unsegmented_runs(term);
    if runs.is_empty() {
        return format!("cjk : {literal}*");
    }
    let mut parts: Vec<String> = runs.into_iter().map(cjk_run_match).collect();
    parts.extend(letter_segments(term).into_iter().map(|segment| {
        let quoted = quote_fts_literal(segment);
        format!("(cjk : {quoted}* OR title : {quoted}* OR body : {quoted}*)")
    }));
    if parts.len() == 1 {
        parts.remove(0)
    } else {
        format!("({})", parts.join(" AND "))
    }
}

/// A run of an unsegmented script as a substring of the `cjk` column: the
/// phrase of its character pairs, or — for one character — any token it
/// starts (a pair, or a run's final character). The twin of `cjkRunMatch`
/// (`search-query.ts`).
fn cjk_run_match(run: &str) -> String {
    if run.chars().count() == 1 {
        format!("cjk : {}*", quote_fts_literal(run))
    } else {
        format!("cjk : {}", quote_fts_literal(&run_bigrams(run).join(" ")))
    }
}

/// One search result row.
#[derive(Debug)]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    /// FTS5 `snippet()` over the indexed plain-text body.
    pub snippet: String,
    /// Title-boosted bm25 score (more negative = better); `0` for title-recall hits.
    pub score: f64,
}

/// The `instr` needles for title recall, one per folded query term — the twin
/// of `titleRecallNeedles` (`search-query.ts`). Matched against
/// `' ' || notes.title_key`: terms in space-delimited scripts carry a leading
/// space so they only match at word starts (`car` finds `Car log`, not
/// `Oscar party`), while unsegmented-script terms match anywhere. Built from
/// the same [`search_terms`] the FTS expression uses, so a term FTS ignores
/// cannot go on constraining recall.
fn title_recall_needles(title_key: &str) -> Vec<String> {
    search_terms(title_key)
        .into_iter()
        .map(|term| {
            if contains_unsegmented_script(term) {
                term.to_owned()
            } else {
                format!(" {term}")
            }
        })
        .collect()
}

/// The palette search's bm25 column weights (`filtered-search.ts`): path
/// unranked, title boosted 10× over body and CJK pairs. Must stay in lockstep.
const RANK_EXPR: &str = "bm25(search_fts, 0, 10.0, 1.0, 1.0)";

/// Ranked, private-excluded search mirroring the desktop palette ordering
/// (`filtered-search.ts`): exact, prefix, and all-terms title matches first,
/// then title-boosted bm25, pinned and recency tiebreakers, then `path`. A
/// materialized CTE runs MATCH once because SQLite rejects it beneath a plain
/// OR and otherwise flattens a derived FTS join into one scan per note. The
/// LEFT JOIN admits title-recall-only rows. Matches already covered by title
/// recall keep an empty snippet and score `0`, while tokenizer-normalized title
/// matches retain their lexical rank. The caller re-checks each hit's file
/// frontmatter (the index row may lag a just-flagged note).
pub fn search_index(
    conn: &Connection,
    match_expr: &str,
    title_key: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, CliError> {
    let needles = title_recall_needles(title_key);
    if needles.is_empty() {
        return Ok(Vec::new());
    }
    let title_term_predicate = needles
        .iter()
        .enumerate()
        .map(|(index, _)| format!("instr(' ' || notes.title_key, ?{}) > 0", index + 3))
        .collect::<Vec<String>>()
        .join(" AND ");
    let limit_parameter = needles.len() + 3;
    let public_predicate = public_note_predicate(conn)?;
    let mut statement = conn.prepare(&format!(
        "WITH lexical AS MATERIALIZED (
           SELECT path, snippet(search_fts, 2, char(1), char(2), '…', 12) AS snippet,
                  {RANK_EXPR} AS rank
           FROM search_fts
           WHERE search_fts MATCH ?1
         )
         SELECT notes.path, notes.title, coalesce(lexical.snippet, ''),
                CASE
                  WHEN instr(coalesce(lexical.snippet, ''), char(1)) > 0
                    OR NOT ({title_term_predicate})
                    THEN coalesce(lexical.rank, 0)
                  ELSE 0
                END AS effective_rank
         FROM notes
         LEFT JOIN lexical ON lexical.path = notes.path
         WHERE (lexical.path IS NOT NULL OR ({title_term_predicate}))
           AND {public_predicate} AND notes.kind != 'template'
         ORDER BY CASE
                    WHEN notes.title_key = ?2 THEN 0
                    WHEN instr(notes.title_key, ?2) = 1 THEN 1
                    WHEN {title_term_predicate} THEN 2
                    ELSE 3
                  END,
                  effective_rank,
                  notes.is_pinned DESC,
                  notes.mtime DESC,
                  notes.path ASC
         LIMIT ?{limit_parameter}",
    ))?;
    let mut parameters = vec![
        Value::Text(match_expr.to_owned()),
        Value::Text(title_key.to_owned()),
    ];
    parameters.extend(needles.into_iter().map(Value::Text));
    parameters.push(Value::Integer(limit as i64));
    let rows = statement.query_map(params_from_iter(parameters), |row| {
        let marked_snippet: String = row.get(2)?;
        let has_body_match = marked_snippet.contains(HIGHLIGHT_START);
        let snippet = if has_body_match {
            marked_snippet.replace([HIGHLIGHT_START, HIGHLIGHT_END], "")
        } else {
            String::new()
        };
        Ok(SearchHit {
            path: row.get(0)?,
            title: row.get(1)?,
            snippet,
            score: row.get(3)?,
        })
    })?;
    let mut hits = Vec::new();
    for row in rows {
        hits.push(row?);
    }
    Ok(hits)
}

/// Words too common to tell notes apart: bm25 already discounts them, but
/// dropping them keeps a sentence's expression short. The twin of
/// `ANY_TERM_STOPWORDS` (`search-query.ts`).
const ANY_TERM_STOPWORDS: &[&str] = &[
    "a", "about", "after", "all", "also", "an", "and", "any", "are", "as", "at", "be", "been",
    "but", "by", "can", "could", "did", "do", "does", "for", "from", "had", "has", "have", "he",
    "her", "his", "how", "i", "if", "in", "into", "is", "it", "its", "just", "like", "may", "me",
    "more", "most", "my", "no", "not", "of", "on", "one", "only", "or", "other", "our", "out",
    "over", "she", "so", "some", "such", "than", "that", "the", "their", "them", "then", "there",
    "these", "they", "this", "those", "to", "too", "up", "us", "very", "was", "we", "were", "what",
    "when", "where", "which", "while", "who", "why", "will", "with", "would", "you", "your",
];

/// Bounds on an any-term expression, so one pasted page can't cost a full
/// scan per word.
const ANY_TERM_MAX_WORDS: usize = 64;
const ANY_TERM_MAX_PAIRS: usize = 128;

/// Words from which a query reads as a sentence rather than a few keywords.
const SENTENCE_MIN_WORDS: usize = 4;

/// The query's stretches of `unicode61` token characters outside the
/// unsegmented scripts, which stand in as spaces.
fn latin_words(query: &str) -> Vec<String> {
    let latin: String = query
        .chars()
        .map(|character| {
            if is_unsegmented(character) {
                ' '
            } else {
                character
            }
        })
        .collect();
    latin
        .split(|character: char| !is_fts_token_char(character))
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Whether `query` reads as a sentence: four words or more, a run of CJK
/// characters counting one word per two characters. Few notes hold every word
/// of a sentence, so search tops such a query up with any-term matches. The
/// twin of `isSentenceLike` (`search-query.ts`).
pub fn is_sentence_like(query: &str) -> bool {
    let cjk_words: usize = unsegmented_runs(query)
        .into_iter()
        .map(|run| run.chars().count().div_ceil(2))
        .sum();
    latin_words(query).len() + cjk_words >= SENTENCE_MIN_WORDS
}

/// An any-term FTS5 expression for a sentence, or `None` when nothing in it
/// is searchable: each word and each CJK character pair counts on its own, and
/// bm25 ranks notes by how many of the rarer ones they hold. Words of four
/// letters or more match as prefixes. The twin of `buildFtsAnyMatch`
/// (`search-query.ts`); pairs need the `cjk` column.
pub fn build_fts_any_match(query: &str, cjk_column: bool) -> Option<String> {
    let mut words: Vec<String> = Vec::new();
    for word in latin_words(&query.to_lowercase()) {
        if word.chars().count() >= 2
            && !ANY_TERM_STOPWORDS.contains(&word.as_str())
            && !words.contains(&word)
            && words.len() < ANY_TERM_MAX_WORDS
        {
            words.push(word);
        }
    }
    let mut pairs: Vec<String> = Vec::new();
    if cjk_column {
        for pair in unsegmented_runs(query).into_iter().flat_map(run_bigrams) {
            if !pairs.contains(&pair) && pairs.len() < ANY_TERM_MAX_PAIRS {
                pairs.push(pair);
            }
        }
    }
    let alternatives: Vec<String> = words
        .iter()
        .map(|word| {
            let prefix = if word.chars().count() >= 4 { "*" } else { "" };
            format!("{}{prefix}", quote_fts_literal(word))
        })
        .chain(
            pairs
                .iter()
                .map(|pair| format!("cjk : {}", quote_fts_literal(pair))),
        )
        .collect();
    if alternatives.is_empty() {
        None
    } else {
        Some(alternatives.join(" OR "))
    }
}

/// The notes matching an any-term expression, best bm25 first, skipping
/// `exclude` (the every-term hits already listed) and private notes.
pub fn any_term_index(
    conn: &Connection,
    match_expr: &str,
    limit: usize,
    exclude: &HashSet<String>,
) -> Result<Vec<SearchHit>, CliError> {
    let public_predicate = public_note_predicate(conn)?;
    let mut statement = conn.prepare(&format!(
        "SELECT search_fts.path, notes.title,
                snippet(search_fts, 2, char(1), char(2), '…', 12), {RANK_EXPR}
         FROM search_fts
         JOIN notes ON notes.path = search_fts.path
         WHERE search_fts MATCH ?1 AND {public_predicate} AND notes.kind != 'template'
         ORDER BY {RANK_EXPR}
         LIMIT ?2",
    ))?;
    let rows = statement.query_map(
        params_from_iter([
            Value::Text(match_expr.to_owned()),
            Value::Integer((limit + exclude.len()) as i64),
        ]),
        |row| {
            let marked_snippet: String = row.get(2)?;
            Ok(SearchHit {
                path: row.get(0)?,
                title: row.get(1)?,
                snippet: marked_snippet.replace([HIGHLIGHT_START, HIGHLIGHT_END], ""),
                score: row.get(3)?,
            })
        },
    )?;
    let mut hits = Vec::new();
    for row in rows {
        let hit = row?;
        if !exclude.contains(&hit.path) {
            hits.push(hit);
            if hits.len() == limit {
                break;
            }
        }
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::{build_fts_match, title_recall_needles};

    /// Parity with `titleRecallNeedles` (`search-query.ts`): space-delimited
    /// terms anchor at word starts (leading space); unsegmented-script terms
    /// match anywhere (no anchor).
    #[test]
    fn needles_match_the_ts_builder() {
        assert_eq!(title_recall_needles("tokyo 東京"), vec![" tokyo", "東京"]);
        assert_eq!(title_recall_needles("car"), vec![" car"]);
        assert_eq!(title_recall_needles(""), Vec::<String>::new());
    }

    /// Parity with `buildFtsMatch` (`search-query.test.ts`) — same inputs,
    /// same expressions, byte for byte.
    #[test]
    fn match_expressions_match_the_ts_builder() {
        assert_eq!(build_fts_match("", true), None);
        assert_eq!(build_fts_match("   \t \n ", true), None);
        assert_eq!(
            build_fts_match("hello", true),
            Some("(title : \"hello\"* OR body : \"hello\"* OR cjk : \"hello\"*)".to_string())
        );
        assert_eq!(
            build_fts_match("cats AND (dogs*)", true),
            Some(
                "(title : \"cats\"* OR body : \"cats\"* OR cjk : \"cats\"*) AND (title : \"AND\"* OR body : \"AND\"* OR cjk : \"AND\"*) AND (title : \"(dogs*)\"* OR body : \"(dogs*)\"* OR cjk : \"(dogs*)\"*)"
                    .to_string()
            )
        );
        assert_eq!(
            build_fts_match("say \"hi\"", true),
            Some(
                "(title : \"say\"* OR body : \"say\"* OR cjk : \"say\"*) AND (title : \"\"\"hi\"\"\"* OR body : \"\"\"hi\"\"\"* OR cjk : \"\"\"hi\"\"\"*)"
                    .to_string()
            )
        );
        assert_eq!(
            build_fts_match("  alpha   beta ", true),
            Some(
                "(title : \"alpha\"* OR body : \"alpha\"* OR cjk : \"alpha\"*) AND (title : \"beta\"* OR body : \"beta\"* OR cjk : \"beta\"*)"
                    .to_string()
            )
        );
        assert_eq!(
            build_fts_match("meeting - notes", true),
            Some(
                "(title : \"meeting\"* OR body : \"meeting\"* OR cjk : \"meeting\"*) AND (title : \"notes\"* OR body : \"notes\"* OR cjk : \"notes\"*)"
                    .to_string()
            )
        );
        assert_eq!(
            build_fts_match("東京 ・", true),
            Some("(title : \"東京\"* OR body : \"東京\"* OR cjk : \"東京\")".to_string())
        );
        assert_eq!(
            build_fts_match("用Python写脚本", true),
            Some(
                "(title : \"用Python写脚本\"* OR body : \"用Python写脚本\"* OR (cjk : \"用\"* AND cjk : \"写脚 脚本\" AND (cjk : \"Python\"* OR title : \"Python\"* OR body : \"Python\"*)))"
                    .to_string()
            )
        );
        assert_eq!(build_fts_match("-", true), Some("\"-\"".to_string()));
        assert_eq!(
            build_fts_match(". -", true),
            Some("\".\" \"-\"".to_string())
        );
    }

    /// An index the app hasn't migrated to the `cjk` column yet must not be
    /// asked about it: FTS5 rejects an unknown column outright.
    #[test]
    fn an_index_without_the_cjk_column_is_searched_by_title_and_body() {
        assert_eq!(
            build_fts_match("東京 hello", false),
            Some(
                "(title : \"東京\"* OR body : \"東京\"*) AND (title : \"hello\"* OR body : \"hello\"*)"
                    .to_string()
            )
        );
    }

    /// The token test follows unicode61's `L* N* Co` categories, not Rust's
    /// `Alphabetic` property: private use constrains, while combining marks
    /// and enclosed alphanumerics (both `Alphabetic`) do not.
    #[test]
    fn token_classification_matches_the_tokenizer_categories() {
        assert_eq!(
            build_fts_match("\u{F8FF}", true),
            Some(
                "(title : \"\u{F8FF}\"* OR body : \"\u{F8FF}\"* OR cjk : \"\u{F8FF}\"*)"
                    .to_string()
            )
        );
        assert_eq!(
            build_fts_match("hello \u{345}", true),
            Some("(title : \"hello\"* OR body : \"hello\"* OR cjk : \"hello\"*)".to_string())
        );
        assert_eq!(
            build_fts_match("hello \u{24B6}", true),
            Some("(title : \"hello\"* OR body : \"hello\"* OR cjk : \"hello\"*)".to_string())
        );
    }

    /// Title recall drops the same terms the FTS expression drops, so a
    /// punctuation term cannot go on constraining recall.
    #[test]
    fn needles_drop_terms_the_fts_expression_ignores() {
        assert_eq!(title_recall_needles("tokyo -"), vec![" tokyo"]);
        // Punctuation only: recall still matches it literally.
        assert_eq!(title_recall_needles("-"), vec![" -"]);
    }
}
