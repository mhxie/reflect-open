//! The `search_fts.cjk` column (migration 0023).
//!
//! FTS5's `unicode61` tokenizer only splits at characters that aren't letters
//! or digits, so a run of Han, kana or Hangul indexes as one token and a word
//! inside a clause can never match. Worse, a Latin word written against a run
//! (`用Python写脚本`) joins that token, so even `python` misses it. The writer
//! stores what the other columns can't see ([`cjk_column_text`]): each run's
//! overlapping character pairs and final character, and each stretch of
//! letters or digits glued to a run. A query matches a run as the phrase of
//! its pairs ([`run_bigrams`]), which is a substring match. Mirrored by
//! `packages/core/src/indexing/cjk.ts`; the parity corpus keeps the two in
//! lockstep.

/// The fork migration version that added CJK; upstream indexes can differ.
/// Check [`has_column`] before querying the column.
pub const COLUMN_SCHEMA_VERSION: usize = 23;

/// Whether the index actually has the `search_fts.cjk` column.
pub fn has_column(conn: &rusqlite::Connection) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM pragma_table_info('search_fts') WHERE name = 'cjk')",
        [],
        |row| row.get(0),
    )
}

/// Scripts written without spaces between words (Han, kana, Hangul, Thai, …).
/// Space-delimited scripts must stay out: `car` may find `Car log` but never
/// `Oscar party`.
const UNSEGMENTED_SCRIPT_RANGES: &[(u32, u32)] = &[
    (0x0e00, 0x0eff),   // Thai, Lao
    (0x1000, 0x109f),   // Myanmar
    (0x1100, 0x11ff),   // Hangul Jamo
    (0x1780, 0x17ff),   // Khmer
    (0x3005, 0x3007),   // Japanese iteration marks (々〆〇)
    (0x3040, 0x30ff),   // Hiragana, Katakana
    (0x3130, 0x318f),   // Hangul Compatibility Jamo
    (0x31f0, 0x31ff),   // Katakana Phonetic Extensions
    (0x3400, 0x4dbf),   // CJK Extension A
    (0x4e00, 0x9fff),   // CJK Unified Ideographs
    (0xac00, 0xd7af),   // Hangul Syllables
    (0xf900, 0xfaff),   // CJK Compatibility Ideographs
    (0xff66, 0xff9f),   // Halfwidth Katakana
    (0x20000, 0x2fa1f), // CJK Extensions B–F, Compatibility Supplement
];

/// Whether `character` belongs to a script written without spaces.
pub fn is_unsegmented(character: char) -> bool {
    let code_point = character as u32;
    UNSEGMENTED_SCRIPT_RANGES
        .iter()
        .any(|&(start, end)| (start..=end).contains(&code_point))
}

/// The maximal runs of unsegmented-script characters in `text`.
pub fn unsegmented_runs(text: &str) -> Vec<&str> {
    let mut runs = Vec::new();
    let mut start = None;
    for (offset, character) in text.char_indices() {
        match (is_unsegmented(character), start) {
            (true, None) => start = Some(offset),
            (false, Some(from)) => {
                runs.push(&text[from..offset]);
                start = None;
            }
            _ => {}
        }
    }
    if let Some(from) = start {
        runs.push(&text[from..]);
    }
    runs
}

/// A run's tokens: its overlapping character pairs, or the run itself when it
/// is a single character.
pub fn run_bigrams(run: &str) -> Vec<String> {
    let characters: Vec<char> = run.chars().collect();
    if characters.len() < 2 {
        return vec![run.to_string()];
    }
    characters
        .windows(2)
        .map(|pair| pair.iter().collect())
        .collect()
}

/// Letters and digits outside the unsegmented scripts: the stretches that can
/// sit against a run without a space.
fn is_segment_character(character: char) -> bool {
    character.is_alphanumeric() && !is_unsegmented(character)
}

/// The maximal stretches of letters and digits outside the unsegmented
/// scripts in `text` (`Python` in `用Python写脚本`).
pub fn letter_segments(text: &str) -> Vec<&str> {
    let mut segments = Vec::new();
    let mut start = None;
    for (offset, character) in text.char_indices() {
        match (is_segment_character(character), start) {
            (true, None) => start = Some(offset),
            (false, Some(from)) => {
                segments.push(&text[from..offset]);
                start = None;
            }
            _ => {}
        }
    }
    if let Some(from) = start {
        segments.push(&text[from..]);
    }
    segments
}

/// What the `cjk` column holds for `text`, space-separated, in text order:
/// every run's character pairs plus its final character (so a single
/// character matches wherever it falls in a run), and every stretch of letters
/// or digits written against a run without a space.
pub fn cjk_column_text(text: &str) -> String {
    let characters: Vec<(usize, char)> = text.char_indices().collect();
    let byte_at = |index: usize| {
        characters
            .get(index)
            .map_or(text.len(), |&(offset, _)| offset)
    };
    let mut tokens: Vec<String> = Vec::new();
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index].1;
        if is_unsegmented(character) {
            let mut end = index;
            while end < characters.len() && is_unsegmented(characters[end].1) {
                end += 1;
            }
            tokens.extend(run_bigrams(&text[byte_at(index)..byte_at(end)]));
            if end - index > 1 {
                tokens.push(characters[end - 1].1.to_string());
            }
            index = end;
        } else if is_segment_character(character) {
            let mut end = index;
            while end < characters.len() && is_segment_character(characters[end].1) {
                end += 1;
            }
            let glued = (index > 0 && is_unsegmented(characters[index - 1].1))
                || (end < characters.len() && is_unsegmented(characters[end].1));
            if glued {
                tokens.push(text[byte_at(index)..byte_at(end)].to_string());
            }
            index = end;
        } else {
            index += 1;
        }
    }
    tokens.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_runs_at_other_scripts_and_punctuation() {
        assert_eq!(
            unsegmented_runs("我们下周去東京旅行，然后去大阪。用Python写脚本"),
            ["我们下周去東京旅行", "然后去大阪", "用", "写脚本"]
        );
        assert!(unsegmented_runs("plain English, no runs").is_empty());
    }

    #[test]
    fn indexes_overlapping_pairs_so_inner_words_match() {
        assert_eq!(run_bigrams("東京旅行"), ["東京", "京旅", "旅行"]);
        assert_eq!(run_bigrams("用"), ["用"]);
        assert_eq!(cjk_column_text("no cjk here"), "");
    }

    #[test]
    fn indexes_each_runs_final_character_so_single_characters_match_anywhere() {
        assert_eq!(cjk_column_text("我和小王"), "我和 和小 小王 王");
        assert_eq!(cjk_column_text("去東京。"), "去東 東京 京");
        assert_eq!(cjk_column_text("王"), "王");
    }

    #[test]
    fn indexes_letters_and_digits_written_against_a_run() {
        assert_eq!(
            cjk_column_text("用Python写脚本, then deploy 2024年"),
            "用 Python 写脚 脚本 本 2024 年"
        );
        // Separated by a space or punctuation, a word is the other columns' job.
        assert_eq!(cjk_column_text("用 Python 写"), "用 写");
        assert_eq!(cjk_column_text("C++写代码"), "写代 代码 码");
    }

    #[test]
    fn splits_a_term_into_its_letter_segments() {
        assert_eq!(letter_segments("用Python写脚本"), ["Python"]);
        assert_eq!(letter_segments("C++写v2"), ["C", "v2"]);
        assert!(letter_segments("東京").is_empty());
    }

    #[test]
    fn counts_characters_beyond_the_basic_plane_once() {
        assert_eq!(run_bigrams("𠀀𠀁"), ["𠀀𠀁"]);
    }
}
