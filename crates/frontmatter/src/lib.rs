//! Shared frontmatter reading for Reflect's native surfaces: the `reflect`
//! CLI and the desktop shell parse notes through this one crate.
//!
//! - [`split_frontmatter`] and [`parse_frontmatter`] mirror the TS
//!   `splitFrontmatter`/`parseFrontmatter` (`packages/core/src/markdown/`)
//!   for the fields native code reads: `id`, `title`, `aliases`.
//! - [`backup_privacy`] is the fail-closed privacy classifier. Its spec is
//!   shared with the TS classifier (`frontmatter-privacy.ts`) and both are
//!   pinned by `fixtures/frontmatter-privacy.json`, so a note locked for the
//!   AI gate is locked for every native gate too.
//! - [`normalize_line_endings_keeping_privacy`] is how native readers hand a
//!   note's text on: `\n` line endings, unless that would change its verdict.
//! - [`ai_summary_entry`] reads the `aiSummary` entry and where it sits, for
//!   the conflict ladder.
//! - [`frontmatter_loads`] and [`frontmatter_uses_aliases`] tell whether a
//!   block loads and whether it uses an alias, for the ladder's key-wise
//!   header merge.
//!
//! Every YAML block passes an event pre-scan (one document, bounded alias
//! expansion, yaml's alias rule) before saphyr loads it, so a hostile note
//! can't exhaust memory.

mod ai_summary;
mod classify;
mod fields;
mod line_endings;
mod scalar;
mod scan;
mod split;

pub use ai_summary::{AiSummaryEntry, GeneratedAt, ai_summary_entry};
pub use classify::{BackupPrivacy, UnreadableReason, backup_privacy};
pub use fields::{Frontmatter, frontmatter_id, parse_frontmatter};
pub use line_endings::normalize_line_endings_keeping_privacy;
pub use scan::{frontmatter_loads, frontmatter_uses_aliases};
pub use split::{FrontmatterSplit, split_frontmatter};
