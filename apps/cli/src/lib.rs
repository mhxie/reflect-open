//! `reflect` — read/discovery CLI over a Reflect graph (Plan 14).
//!
//! Self-contained: reads the graph's markdown files directly and opens
//! `.reflect/index.sqlite` strictly read-only — no Node runtime, no running
//! desktop app. The one exception is `search --mode semantic|hybrid`, which
//! asks the running app over a local socket (`app_search`) rather than load a
//! model or read the vector table itself. The modules mirror the small read-side contract owned
//! by `@reflect/core` (paths, fold keys, title derivation, hashing, FTS match
//! syntax); each one names its TS counterpart and is parity-tested against
//! the same expected values. Frontmatter comes from the shared
//! `reflect-frontmatter` crate. Keep this surface frozen — the CLI must never
//! grow its own parser or indexer beyond it.
//!
//! Privacy contract: notes with `private: true` frontmatter are invisible
//! through this CLI — excluded from `search`, refused by `show`/`today`/`path`
//! — with no override flag, and so are notes whose frontmatter can't be read
//! (`BackupPrivacy::Unreadable`): the CLI fails closed like every other gate.
//! The resolved file's own frontmatter is checked, never just the index row,
//! so a stale index can't leak a just-flagged note.

pub mod app_search;
pub mod commands;
pub mod error;
pub mod graph;
pub mod hash;
pub mod index;
pub mod keys;
pub mod note_file;
pub mod paths;
pub mod resolve;
pub mod search;
