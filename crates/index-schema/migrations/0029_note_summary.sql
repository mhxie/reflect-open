-- `summary` holds a note's `aiSummary` frontmatter text while it summarizes the
-- current body (`summary_fresh`), and is empty otherwise. Only the All Notes
-- row shows it. `preview` goes back to the note's leading plain text for every
-- other list, search feed and AI listing; 0027's note about projecting the
-- summary into `preview` no longer holds.
--
-- No wipe here. The TS projection version bump reindexes every note, so no row
-- keeps the migration default (same contract as 0021, 0025 and 0027).

ALTER TABLE notes ADD COLUMN summary TEXT NOT NULL DEFAULT '';
