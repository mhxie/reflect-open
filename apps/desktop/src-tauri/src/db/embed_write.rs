//! Embedding-table writes (Plan 09): chunk rows + their vec0 vectors, applied
//! per note as one diff. Plain functions over a [`Connection`] — the command
//! layer ([`super`]) owns transactions and generation gating, mirroring
//! `write.rs`.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;

use crate::error::{AppError, AppResult};

/// One chunk of a note, built in TS (`@reflect/core` chunker). `vector` is
/// present only for new/changed chunks — `None` means "this chunk's hash
/// already has a row; keep its vector, refresh its metadata" (positions and
/// headings shift when text moves above an unchanged chunk).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedChunk {
    pub(super) heading: Option<String>,
    pub(super) pos_from: i64,
    pub(super) pos_to: i64,
    pub(super) text: String,
    pub(super) content_hash: String,
    pub(super) model_id: String,
    pub(super) vector: Option<Vec<f32>>,
    pub(super) is_private: bool,
    pub(super) source_hash: String,
    pub(super) asset_text_hash: String,
}

fn vector_json(vector: &[f32]) -> String {
    let mut out = String::with_capacity(vector.len() * 10 + 2);
    out.push('[');
    for (i, value) in vector.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&value.to_string());
    }
    out.push(']');
    out
}

/// Apply `chunks` as the note's complete new chunk set: rows whose hash isn't
/// in the set are dropped (vectors included), kept rows get fresh metadata,
/// and chunks carrying a vector are inserted. A "new" chunk without a vector
/// is a pipeline bug — fail loudly rather than store an unsearchable row.
pub(super) fn apply_chunks(
    conn: &Connection,
    note_path: &str,
    chunks: &[EmbeddedChunk],
) -> AppResult<()> {
    // Chunks only exist for indexed notes. The embedding pipeline runs on its
    // own queue, so a slow in-flight embed can land after index_remove
    // deleted the note — without this guard it would reinsert vectors for a
    // dead path (which surface as stale text if the path is later reused).
    let note_exists: bool = conn
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM notes WHERE path = ?1)")?
        .query_row(params![note_path], |row| row.get(0))?;
    if !note_exists {
        return remove_chunks(conn, note_path); // hygiene: drop any leftovers
    }
    let snapshot: (String, String) = conn.query_row(
        "SELECT file_hash, asset_text_hash FROM notes WHERE path = ?1",
        params![note_path],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if chunks
        .iter()
        .any(|chunk| chunk.source_hash != snapshot.0 || chunk.asset_text_hash != snapshot.1)
    {
        return Ok(());
    }

    // Existing rows by content hash (a note rarely has duplicate-hash chunks;
    // if it does, rows pair up by position order — both forms are identical).
    let mut existing: Vec<(i64, String)> = conn
        .prepare_cached(
            "SELECT id, content_hash FROM embedding_chunks WHERE note_path = ?1 ORDER BY pos_from",
        )?
        .query_map(params![note_path], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;

    let mut kept: Vec<i64> = Vec::new();
    for chunk in chunks {
        match chunk.vector.as_ref() {
            None => {
                let at = existing
                    .iter()
                    .position(|(_, hash)| *hash == chunk.content_hash)
                    .ok_or_else(|| {
                        AppError::parse(format!(
                            "unchanged chunk has no stored row (hash {})",
                            chunk.content_hash
                        ))
                    })?;
                let (id, _) = existing.remove(at);
                conn.prepare_cached(
                    "UPDATE embedding_chunks
                     SET heading = ?2, pos_from = ?3, pos_to = ?4, model_id = ?5, is_private = ?6, source_hash = ?7, asset_text_hash = ?8
                     WHERE id = ?1",
                )?
                .execute(params![
                    id,
                    chunk.heading,
                    chunk.pos_from,
                    chunk.pos_to,
                    chunk.model_id,
                    chunk.is_private,
                    chunk.source_hash,
                    chunk.asset_text_hash
                ])?;
                kept.push(id);
            }
            Some(vector) => {
                conn.prepare_cached(
                    "INSERT INTO embedding_chunks
                       (note_path, heading, pos_from, pos_to, text, content_hash, model_id, is_private, source_hash, asset_text_hash)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                )?
                .execute(params![
                    note_path,
                    chunk.heading,
                    chunk.pos_from,
                    chunk.pos_to,
                    chunk.text,
                    chunk.content_hash,
                    chunk.model_id,
                    chunk.is_private,
                    chunk.source_hash,
                    chunk.asset_text_hash
                ])?;
                let id = conn.last_insert_rowid();
                conn.prepare_cached(
                    "INSERT INTO embedding_vectors(rowid, embedding) VALUES (?1, ?2)",
                )?
                .execute(params![id, vector_json(vector)])?;
                kept.push(id);
            }
        }
    }

    // Whatever wasn't kept is stale: drop vector + row.
    for (id, _) in existing {
        conn.prepare_cached("DELETE FROM embedding_vectors WHERE rowid = ?1")?
            .execute(params![id])?;
        conn.prepare_cached("DELETE FROM embedding_chunks WHERE id = ?1")?
            .execute(params![id])?;
    }
    Ok(())
}

/// Drop every chunk + vector belonging to `note_path` (note deletion).
pub(super) fn remove_chunks(conn: &Connection, note_path: &str) -> AppResult<()> {
    conn.prepare_cached(
        "DELETE FROM embedding_vectors WHERE rowid IN
           (SELECT id FROM embedding_chunks WHERE note_path = ?1)",
    )?
    .execute(params![note_path])?;
    conn.prepare_cached("DELETE FROM embedding_chunks WHERE note_path = ?1")?
        .execute(params![note_path])?;
    Ok(())
}

/// The `index_meta` key naming the model the stored vectors came from.
const EMBEDDING_MODEL_KEY: &str = "embeddingModel";
/// Indexes written before the key existed hold this model's vectors.
const ORIGINAL_EMBEDDING_MODEL: &str = "all-MiniLM-L6-v2";

/// Make the vector table fit `model` (`dims` wide): when the stored vectors
/// came from another model, recreate `embedding_vectors` at the new width —
/// vec0 can't alter a column — and drop every chunk, so the backfill embeds
/// the graph afresh. Returns whether anything was reset.
pub(super) fn prepare_vectors(conn: &Connection, model: &str, dims: usize) -> AppResult<bool> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM index_meta WHERE key = ?1",
            params![EMBEDDING_MODEL_KEY],
            |row| row.get(0),
        )
        .optional()?;
    if stored.as_deref().unwrap_or(ORIGINAL_EMBEDDING_MODEL) == model {
        return Ok(false);
    }
    conn.execute_batch(&format!(
        "DELETE FROM embedding_chunks;
         DROP TABLE embedding_vectors;
         CREATE VIRTUAL TABLE embedding_vectors
           USING vec0(embedding float[{dims}] distance_metric=cosine);"
    ))?;
    conn.execute(
        "INSERT INTO index_meta(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![EMBEDDING_MODEL_KEY, model],
    )?;
    Ok(true)
}
