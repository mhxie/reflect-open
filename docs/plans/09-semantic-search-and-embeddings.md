# Plan 09 — Semantic Search & Local Embeddings

**Goal:** Local-only semantic search and a shared retrieval layer: chunk notes, embed
them locally (no cloud embedding APIs), store vectors in SQLite, and serve nearest-note
retrieval to search and AI.

**Depends on:** Plan 04 (index + chunk source), Plan 08 (search surface to augment).
**Unlocks:** Plan 10 (AI context retrieval rides this layer).

**Architecture:** the embedding runtime (model download + `embed`) is a Rust primitive;
chunking, the `retrieve()` API, and ranking live in `@reflect/core` (`actions/embeddings`,
`actions/search`). See [Architecture & Conventions](architecture-conventions.md).

**Libraries:** `fastembed` (Rust, local embeddings) + `sqlite-vec` (vectors). See
[Libraries](libraries.md).

## Delivery (decided 2026-06-09)

Both halves ship together on one branch, commits sequenced runtime-first so the
native risk is reviewable in isolation:

- **09a — embedding runtime + vector store:** `fastembed` **in-process,
  off-thread** (decided — sidecar isolation only if crashes materialize) with
  **all-MiniLM-L6-v2** (384-dim, ~90MB, decided), downloaded on demand into app
  data with status surfaced through the operations store; the same
  recoverable-init contract as sqlite-vec (failure = "semantic unavailable",
  never a crash). Migration 0002 adds `embedding_chunks` + the `vec0` vector
  table + `index_meta.embeddingModel`; vector writes are generation-pinned
  commands, vector KNN reads go through the ordinary read-only `db_query`
  (sqlite-vec accepts JSON-text vectors, so no bespoke read command).
- **09b — chunking, retrieval, hybrid search, related notes:** sentence-aware
  chunker in core (pure); incremental hash-diff embedding pass riding the
  post-index-apply hook (TS orchestration per conventions — Rust stays
  primitives); one `retrieve()` with **reciprocal rank fusion** for hybrid
  (deterministic, no tuned weights); **⌘K goes hybrid by default with no
  toggle** (decided — exact lexical matches keep top billing through RRF, and
  the surface degrades invisibly to lexical-only without the model); and the
  **related-notes panel** (decided — the Plan 07 "suggested backlinks"
  deferral lands here) under the backlinks panel, seeded by the note's own
  content, self-excluded, hidden when unavailable.

**Recorded consequences:** `fastembed` pulls ONNX Runtime — its dylib must be
code-signed at notarization time (Plan 15), and model-dependent Rust tests are
gated behind an ignored integration flag (unit tests use a fake embedder).
kysely-codegen replays migrations through better-sqlite3, so the codegen script
loads the `sqlite-vec` npm extension to create the `vec0` table.

## Scope

**In:** local embedding runtime in Rust, sentence-aware chunking, `sqlite-vec` storage,
incremental (hash-based) re-embedding, a unified retrieval API, blended lexical+semantic
results, graceful unavailable states, `private: true` handling.
**Out:** BYOK/cloud embeddings (explicitly not first wave), mobile semantic search
(lexical-only first), generative AI (Plan 10).

## Key decision: embeddings run locally, in Rust, outside the WebView

Per the indexing strategy: **first-wave embeddings are local, not cloud BYOK**, and
embedding execution should leave the WebView for performance.

- **Runtime:** a Rust embedding crate (e.g. `fastembed`/ONNX Runtime) running a small
  sentence-embedding model (e.g. `all-MiniLM-L6-v2` / `bge-small`). The **model is
  downloaded on demand**, not bundled, with device-capability checks + a graceful
  "semantic search unavailable" state on unsupported devices.
- **Storage:** `sqlite-vec` virtual tables in the same `.reflect/index.sqlite` (loaded in
  Rust alongside FTS5, Plan 04).
- **Record the embedding model/runtime per vector** so the index can be rebuilt when the
  model changes.

## Schema additions (additive to Plan 04)

- `embedding_chunks` — chunk id, note id, heading, char/line range, text, content hash.
- `embedding_vectors` — `sqlite-vec` table: chunk id ↔ vector, with model id.
- `index_meta.embeddingModel` — current model identifier (rebuild trigger on change).

## Steps

1. **Chunking.** Split note plain text (Plan 03 extraction) into sentence-aware chunks
   with stable back-references (note path/id, heading, range). Hash each chunk so
   unchanged chunks are not re-embedded — mirrors V1 behavior.

2. **Rust embedding service** (`src-tauri/src/embed/`): load/download model; `embed(texts)
   → vectors`; commands `embed_index_note(id)` and `embed_rebuild()`. Runs off the UI
   thread; reports progress via events.

3. **Incremental pipeline.** On note index (Plan 04), diff chunk hashes; embed only
   new/changed chunks; upsert into `sqlite-vec`; drop vectors for removed chunks. Full
   `embed_rebuild()` on model change or repair.

4. **Retrieval API (shared contract).** One `retrieve(query, opts)` that returns ranked
   note/chunk hits, used by both search and AI:

   ```ts
   export interface RetrievalHit {
     noteId: string
     chunkId: string
     score: number
     snippet: string
     heading?: string
     isPrivate: boolean
   }
   export interface RetrieveOptions {
     limit: number
     mode: 'semantic' | 'lexical' | 'hybrid'
     excludePrivateContent: boolean // AI callers set true
   }
   ```
   Vector search → dedupe chunks back to notes → optionally blend with FTS (hybrid).

5. **Search integration.** Blend semantic hits into the `⌘K` surface (Plan 08) — hybrid
   by default with **no toggle** (decided, see Delivery): "meat dishes" finds recipe
   notes lacking those exact words. Same UI, additive ranking; lexical-only when the
   model is unavailable.

6. **Privacy contract.** `private: true` notes may stay in the **local** lexical + vector
   indexes (local recall is fine), but retrieval used for cloud AI (Plan 10) must exclude
   their *content*. `RetrieveOptions.excludePrivateContent` + per-hit `isPrivate` give the
   AI layer what it needs to filter before any external call. Enforced again at the AI
   call site (defense in depth).

7. **Tests.** Chunk stability + hash-skip (unchanged note re-embeds nothing); vector round
   trip; hybrid ranking sanity; private content excluded when
   `excludePrivateContent: true`; unavailable-model path degrades to lexical-only.

## Key decisions / contracts

- **Local embeddings only** for first wave; cloud embeddings explicitly out.
- **Embeddings in Rust, model downloaded on demand**, recorded per vector for rebuilds.
- **One `retrieve()` API** is the single retrieval contract for search + AI.
- **Private notes: locally recallable, never sent to cloud** — enforced in retrieval and
  again at the AI boundary.

## Acceptance criteria

- First semantic use downloads the model with progress; later uses are instant.
- Semantic/hybrid search finds conceptually-related notes lacking exact keywords.
- Editing a note re-embeds only changed chunks (hash-skip verified).
- `retrieve({ excludePrivateContent: true })` never returns private-note content.
- On an unsupported device, search degrades to lexical with a clear state.
- `pnpm typecheck` + tests pass.

## Risks

- **Whole feature is independently deferrable.** Semantic search is the riskiest infra
  here (native ML runtime + model + vector store). It sits behind the `retrieve()` API and
  a capability check, so **M2 can ship on lexical search alone** (Plan 08) if this slips —
  keep it strictly additive, never a blocker for search/AI.
- **Bundling a native ML runtime is heavy** (ONNX Runtime is a large dependency, ships a
  **dylib that must be code-signed for notarization** — Plan 15, both arm64 + x64), and
  adds build/CI complexity. Mitigate: gate behind capability detection; consider a sidecar
  process so a runtime crash can't take down the app.
- **Model download size/time + device variance.** Mitigate with on-demand download,
  capability checks, progress UX, and a lexical fallback.
- **`sqlite-vec` maturity / portability.** Keep vector access behind the retrieval API so
  the store can be swapped without touching callers (noted open question).
- **Indexing latency on large graphs.** Background, batched, incremental; never block
  the editor or search.

## Multilingual retrieval (fork addendum)

The first wave's model is English-only and its chunker assumed a space after every
sentence end, so graphs written largely in Chinese or Japanese got little from the
semantic half and almost nothing from lexical body search. The fork changes:

- **Lexical.** `unicode61` keeps an unsegmented run (Han, kana, Hangul, Thai, …) as
  one token, so a word inside a clause never matched. `search_fts` gains a `cjk`
  column holding each run's overlapping character pairs (migration 0023, mirrored in
  TS and Rust and locked by the parity corpus); a query run matches as the phrase of
  its pairs, which is a substring match. A sentence-long query that no note matches
  in full is topped up by an any-term bm25 pass.
- **Models.** The `semanticModel` setting picks from one catalog (`MODELS` in
  `embed.rs`, `SEMANTIC_MODELS` in `models.ts`): MiniLM, still the default so an
  existing index keeps its vectors, and EmbeddingGemma for every other language.
  Each carries its own query/passage prefixes and noise cutoff
  (`maxCosineDistance`). Switching refits `embedding_vectors` to the new width and
  re-embeds the graph, with progress in Settings; projection rebuilds keep vectors,
  so an index format change no longer re-embeds anything.
- **Model choice.** On a real multilingual graph and 200 link-prediction queries,
  EmbeddingGemma alone ranked 60.5% of the targets in its top 10 (MiniLM 38.5%),
  and hybrid search with it 64.5%, against 62.5% for lexical alone, at about 70 ms
  a query. Multilingual E5 base (45.5%) and BGE-M3 (53.5%, with twice the download
  and embedding time) were measured and left out; E5 also scores real and
  gibberish queries alike at 0.8 to 0.9 similarity, so no noise cutoff works for it.
- **Noise cutoff.** EmbeddingGemma's 0.63 is the tightest distance that keeps every
  link target it ranks in its top 10 on those queries; 17 of 20 gibberish queries
  find no neighbor that close.
- **Chunks.** Sized in approximate tokens (one per CJK character, four characters
  each otherwise; target 300, ceiling 450), broken at `。！？；` as well as `.!?`,
  and embedded with the note title and heading as context.
- **Background work.** The backfill runs in the main window's scripts, which
  WebKit suspends while the window is hidden unless it may only throttle them
  (`backgroundThrottling: "throttle"`). A hidden macOS app is also napped to
  background priority, which slowed a full re-embed several fold; the backfill
  holds an `NSProcessInfo` activity (`activity.rs`) for its duration.
- **Runtime.** CPU ONNX Runtime throughout: the CoreML execution provider ran these
  models slower under variable input lengths, or failed to load their external
  weight files. Model runs take eight texts at a time: a long note's chunks in one
  padded batch let the runtime's memory arena grow by gigabytes and keep it.
- **No rerank stage.** A multilingual cross-encoder (Jina v2, BGE v2 M3) rescoring
  the fused top 30 cost 2 to 9 seconds a query on CPU and did not improve ranking
  on the link-prediction query set this work was measured on, so it was left out.
