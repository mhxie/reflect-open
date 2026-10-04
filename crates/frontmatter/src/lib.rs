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
//!
//! Every YAML block passes an event pre-scan (one document, bounded alias
//! expansion, yaml's alias rule) before saphyr loads it, so a hostile note
//! can't exhaust memory.

mod classify;
mod fields;
mod scalar;
mod scan;
mod split;

pub use classify::{backup_privacy, BackupPrivacy, UnreadableReason};
pub use fields::{frontmatter_id, parse_frontmatter, Frontmatter};
pub use split::{split_frontmatter, FrontmatterSplit};
