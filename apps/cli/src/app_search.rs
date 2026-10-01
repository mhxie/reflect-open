//! `reflect search --mode semantic|hybrid`: the one path that needs the
//! running app. The CLI never loads an embedding model or reads the vector
//! table; it asks the app serving this graph over the Unix socket in
//! `.reflect/` (`search_ipc.rs` on the app side) and gets the app's own
//! retrieval, the ranking ⌘K and the AI tools use. Private notes never come
//! back, and the caller still re-checks every path against the file itself.

use std::path::Path;

use serde::Deserialize;

use crate::error::CliError;

/// One result as the app sends it.
#[derive(Debug, Deserialize)]
pub struct AppHit {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub score: f64,
}

/// The app's answer: the mode that actually ran (lexical when the app's
/// semantic search is off or its model isn't loaded) and its results.
#[derive(Debug)]
pub struct AppAnswer {
    pub mode: String,
    pub results: Vec<AppHit>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Reply {
    Answer { mode: String, results: Vec<AppHit> },
    Failure { error: String },
}

/// Seconds to wait for the app, which may be embedding the query.
const TIMEOUT_SECONDS: u64 = 15;
/// An answer longer than this is not one the app sends.
const MAX_REPLY_BYTES: u64 = 8 * 1024 * 1024;

#[cfg(unix)]
pub fn search_app(
    root: &Path,
    query: &str,
    mode: &str,
    limit: usize,
) -> Result<AppAnswer, CliError> {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    let path = reflect_index_schema::search_socket_path(root).map_err(CliError::AppUnavailable)?;
    let mut stream = UnixStream::connect(&path).map_err(|_| {
        CliError::AppUnavailable(
            "Reflect isn't serving this graph: open it in the Reflect app (semantic and hybrid \
             search run there)"
                .to_string(),
        )
    })?;
    let unavailable = |err: std::io::Error| {
        CliError::AppUnavailable(format!("talking to the Reflect app failed: {err}"))
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(TIMEOUT_SECONDS)))
        .map_err(unavailable)?;
    stream
        .set_write_timeout(Some(Duration::from_secs(TIMEOUT_SECONDS)))
        .map_err(unavailable)?;
    let request = serde_json::json!({ "v": 1, "query": query, "mode": mode, "limit": limit });
    stream
        .write_all(format!("{request}\n").as_bytes())
        .map_err(unavailable)?;
    let mut line = String::new();
    BufReader::new(stream.take(MAX_REPLY_BYTES))
        .read_line(&mut line)
        .map_err(unavailable)?;
    match serde_json::from_str::<Reply>(&line) {
        Ok(Reply::Answer { mode, results }) => Ok(AppAnswer { mode, results }),
        Ok(Reply::Failure { error }) => Err(CliError::AppUnavailable(format!(
            "the Reflect app couldn't search: {error}"
        ))),
        Err(_) => Err(CliError::AppUnavailable(
            "the Reflect app sent an answer this CLI can't read — update Reflect".to_string(),
        )),
    }
}

#[cfg(not(unix))]
pub fn search_app(
    _root: &Path,
    _query: &str,
    _mode: &str,
    _limit: usize,
) -> Result<AppAnswer, CliError> {
    Err(CliError::AppUnavailable(
        "semantic and hybrid search through the CLI need Unix sockets".to_string(),
    ))
}
