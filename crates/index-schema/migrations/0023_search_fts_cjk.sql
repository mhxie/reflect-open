-- CJK bigrams beside the raw text. `unicode61` keeps a run of Han, kana or
-- Hangul as one token, so a word inside a clause was unmatchable; the writer
-- now fills `cjk` with each run's overlapping character pairs (index-schema
-- `cjk.rs`), and queries match a run as the phrase of its pairs. FTS5 tables
-- can't gain a column in place, so the table is recreated empty; the
-- projection version bump that ships with this migration rebuilds its rows.
DROP TABLE search_fts;
CREATE VIRTUAL TABLE search_fts USING fts5(path UNINDEXED, title, body, cjk);
