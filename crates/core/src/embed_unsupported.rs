//! Stand-in for the embedding runtime on platforms that have none: the
//! commands stay registered so the IPC surface is identical everywhere, and
//! the status reports `unsupported` so the frontend can turn semantic search
//! off. Search stays lexical (FTS5).

use reflect_types::{AppError, AppResult};
use serde::{Deserialize, Serialize};

use crate::Core;

/// Empty stand-in for the runtime state, so [`Core`] holds the same type name
/// on every platform.
#[derive(Default)]
pub struct EmbedState {}

/// Whether a text is a search query or a stored passage (see the supported
/// runtime's `TextRole`).
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TextRole {
    Query,
    #[default]
    Passage,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum EmbedStatus {
    /// This platform has no embedding runtime.
    Unsupported,
}

impl Core {
    pub fn embed_status(&self) -> AppResult<EmbedStatus> {
        Ok(EmbedStatus::Unsupported)
    }

    pub async fn embed_ensure(&self, _model: Option<String>) -> AppResult<EmbedStatus> {
        Ok(EmbedStatus::Unsupported)
    }

    /// Fails loudly: the frontend never embeds on an `unsupported` runtime.
    pub async fn embed_texts(
        &self,
        _texts: Vec<String>,
        _role: Option<TextRole>,
        _model: Option<String>,
    ) -> AppResult<Vec<Vec<f32>>> {
        Err(AppError::Unknown {
            message: "the embedding runtime is not supported on this platform".into(),
        })
    }
}
