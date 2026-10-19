use serde::Serialize;

/// Metadata for a file inside the graph.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    /// Graph-relative path, forward-slashed.
    pub path: String,
    pub size: u64,
    /// Last-modified time in epoch milliseconds.
    pub modified_ms: u64,
    /// True when the file is iCloud-evicted: the note exists but its content
    /// is not on disk until re-downloaded. Consumers must not read it — a
    /// read blocks on an on-demand download — and must not treat it as
    /// deleted (Plan 21). Covers both eviction forms: for a legacy `.icloud`
    /// stub, `size` and `modified_ms` describe the stub; for a modern
    /// dataless file they are the real (preserved) values. Also true for an
    /// external file whose bytes its folder's provider holds.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub placeholder: bool,
    /// Set when the file lives in the graph's external storage folder rather
    /// than the graph itself; absent for every graph file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external: Option<ExternalAvailability>,
}

/// Where an external file's bytes are.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExternalAvailability {
    /// On this device: it reads like any graph file.
    Local,
    /// With the folder's provider: reading it would download it, so only
    /// an explicit download may (the entry is also a `placeholder`).
    Offline,
}

impl ExternalAvailability {
    /// The availability of an external file that is, or is not, evicted.
    pub fn of(placeholder: bool) -> Self {
        if placeholder {
            Self::Offline
        } else {
            Self::Local
        }
    }
}
