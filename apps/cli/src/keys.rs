//! Match-key folding and script classification — the Rust mirror of
//! `packages/core/src/markdown/keys.ts` and `containsUnsegmentedScript`
//! (`packages/core/src/indexing/search-query.ts`). This must produce the same
//! keys the TS indexer wrote to `notes.title_key` / `aliases.alias_key` and
//! classify query terms the same way the app's search does, or lookups
//! silently miss and CLI/app result orders drift.

use reflect_index_schema::cjk::is_unsegmented;
use unicode_normalization::UnicodeNormalization;

/// Trim surrounding whitespace and case-fold `value` to its match key. NFC
/// first, exactly like `foldKey`: macOS hands back NFD filenames, and a
/// stem-derived key must equal the same name typed by hand. The shared corpus
/// `fixtures/fold-key-parity.json` pins the two implementations together.
pub fn fold_key(value: &str) -> String {
    value.nfc().collect::<String>().trim().to_lowercase()
}

/// True when `value` contains a character from a script written without
/// spaces (Han, kana, Hangul, Thai, …). Such a title run indexes as one token,
/// so a shorter query term needs anywhere-in-the-title substring recall.
/// Space-delimited scripts must not get it: `car` may find `Car log` but
/// never `Oscar party`. The table is shared with the index writer
/// (`reflect_index_schema::cjk`).
pub fn contains_unsegmented_script(value: &str) -> bool {
    value.chars().any(is_unsegmented)
}

#[cfg(test)]
mod tests {
    use super::{contains_unsegmented_script, fold_key};

    /// Parity with `foldKey` (`keys.ts`): NFC + trim + Unicode lowercase. JS
    /// `toLowerCase` and Rust `to_lowercase` agree on all common inputs; known
    /// divergence is limited to locale-specific edge cases (e.g. Turkish
    /// dotless-i), accepted in the Plan 14 contract.
    #[test]
    fn folds_like_the_ts_indexer() {
        assert_eq!(fold_key("  MiXeD Case  "), "mixed case");
        assert_eq!(fold_key("ALPHA"), "alpha");
        assert_eq!(fold_key(""), "");
    }

    /// The shared corpus (`fixtures/fold-key-parity.json`) both sides fold;
    /// `keys.test.ts` asserts the same rows against `foldKey`.
    #[test]
    fn folds_the_shared_parity_corpus_like_the_ts_indexer() {
        #[derive(serde::Deserialize)]
        struct Row {
            input: String,
            key: String,
        }
        let raw = include_str!("../../../fixtures/fold-key-parity.json");
        let rows: Vec<Row> = serde_json::from_str(raw).expect("valid parity corpus");
        assert!(!rows.is_empty());
        for row in rows {
            assert_eq!(fold_key(&row.input), row.key, "input {:?}", row.input);
        }
    }

    /// Parity with `containsUnsegmentedScript` (`search-query.ts`): the same
    /// inputs must classify the same way in the CLI and the app.
    #[test]
    fn classifies_scripts_like_the_ts_search() {
        assert!(contains_unsegmented_script("東京"));
        assert!(contains_unsegmented_script("とうきょう"));
        assert!(contains_unsegmented_script("トウキョウ"));
        assert!(contains_unsegmented_script("人々"));
        assert!(contains_unsegmented_script("서울"));
        assert!(contains_unsegmented_script("กรุงเทพ"));
        assert!(contains_unsegmented_script("𠮷野")); // CJK Extension B
        assert!(contains_unsegmented_script("東京trip")); // mixed runs count
        assert!(!contains_unsegmented_script("tokyo"));
        assert!(!contains_unsegmented_script("café"));
        assert!(!contains_unsegmented_script("Москва"));
        assert!(!contains_unsegmented_script(""));
    }
}
