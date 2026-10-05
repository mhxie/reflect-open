ALTER TABLE notes ADD COLUMN has_device_only_content INTEGER NOT NULL DEFAULT 0;
ALTER TABLE embedding_chunks ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;
UPDATE embedding_chunks SET is_private = 1 WHERE note_path IN (SELECT path FROM notes WHERE is_private);
ALTER TABLE notes ADD COLUMN asset_text_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE embedding_chunks ADD COLUMN source_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE embedding_chunks ADD COLUMN asset_text_hash TEXT NOT NULL DEFAULT '';
