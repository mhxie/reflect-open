-- `summary_fresh` marks a note whose `aiSummary` frontmatter block summarizes
-- its current body (the block's hash matches the body). The index projects the
-- summary into `preview` only then, and the background summary pass selects
-- the notes still lacking one through this column instead of re-reading and
-- re-hashing every file.
--
-- No wipe here. The TS projection version bump reindexes every note, so no row
-- keeps the migration default (same contract as 0021 and 0025).

ALTER TABLE notes ADD COLUMN summary_fresh INTEGER NOT NULL DEFAULT 0;
