-- `body_chars` is the length of a note's display text: what the user wrote,
-- without Markdown syntax or the asset descriptions folded into
-- `search_fts.body`. The activity heatmap sizes daily notes by it.
--
-- No wipe here. The TS projection version bump reindexes every note, so no row
-- keeps the migration default (same contract as 0021).

ALTER TABLE notes ADD COLUMN body_chars INTEGER NOT NULL DEFAULT 0;
