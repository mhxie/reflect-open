//! Search for the `reflect` CLI from the running app: `reflect search --mode
//! semantic|hybrid` connects to a Unix socket the app opens in the graph's
//! `.reflect/` directory and gets the answer of the app's own `retrieve()`,
//! the ranking ⌘K and the AI tools use; the CLI never loads a model or reads
//! the vector table. The main window owns the lifecycle: its responder starts
//! the socket for the open graph and stops it when the workspace goes away.
//!
//! Protocol: one request line, one answer line, then close. A request is
//! `{"v":1,"query":"…","mode":"lexical"|"semantic"|"hybrid","limit":N}`; the
//! answer, whatever the main window sent back: `{"mode":…,"results":[…]}` or
//! `{"error":"…"}`. Only the owning user may connect.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use reflect_index_schema::search_socket_path;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tokio::sync::oneshot;

use crate::error::{AppError, AppResult};
use crate::fs::{current_root, GraphState};

/// The event the main window's responder answers with `search_ipc_respond`.
const REQUEST_EVENT: &str = "search-ipc:request";
/// A request line longer than this is refused unread.
const MAX_REQUEST_BYTES: u64 = 64 * 1024;
/// How long a connection may take to send its request.
const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
/// How long the main window has to answer before the caller is told so.
const ANSWER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// The most results one request may ask for.
const MAX_LIMIT: usize = 100;
/// Longer queries are refused rather than embedded.
const MAX_QUERY_CHARS: usize = 4096;

/// A validated request, as the main window receives it.
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    v: u32,
    query: String,
    mode: String,
    limit: usize,
}

/// Parse and bound one request line.
pub fn parse_request(line: &str) -> Result<Request, String> {
    let request: Request =
        serde_json::from_str(line.trim_end()).map_err(|err| format!("bad request: {err}"))?;
    if request.v != 1 {
        return Err(format!("unsupported protocol version {}", request.v));
    }
    if !matches!(request.mode.as_str(), "lexical" | "semantic" | "hybrid") {
        return Err(format!("unknown mode {:?}", request.mode));
    }
    if request.query.trim().is_empty() || request.query.chars().count() > MAX_QUERY_CHARS {
        return Err(format!(
            "the query must be 1 to {MAX_QUERY_CHARS} characters"
        ));
    }
    if !(1..=MAX_LIMIT).contains(&request.limit) {
        return Err(format!("the limit must be 1 to {MAX_LIMIT}"));
    }
    Ok(request)
}

/// Requests sent to the main window and awaiting its answer, by id.
#[derive(Default)]
struct Pending {
    next_id: AtomicU64,
    waiting: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
}

impl Pending {
    fn waiting(&self) -> MutexGuard<'_, HashMap<u64, oneshot::Sender<Value>>> {
        self.waiting
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn register(&self) -> (u64, oneshot::Receiver<Value>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = oneshot::channel();
        self.waiting().insert(id, sender);
        (id, receiver)
    }

    /// Hand `answer` to the request `id`; false when it already timed out.
    fn resolve(&self, id: u64, answer: Value) -> bool {
        match self.waiting().remove(&id) {
            Some(sender) => sender.send(answer).is_ok(),
            None => false,
        }
    }

    fn forget(&self, id: u64) {
        self.waiting().remove(&id);
    }

    /// Answer every waiting request with `answer` (the server is stopping).
    fn drain(&self, answer: &Value) {
        for (_, sender) in self.waiting().drain() {
            let _ = sender.send(answer.clone());
        }
    }
}

/// The socket serving one graph.
struct Server {
    root: PathBuf,
    path: PathBuf,
    task: tauri::async_runtime::JoinHandle<()>,
}

/// Process-wide state: at most one graph is served at a time.
#[derive(Default)]
pub struct SearchIpcState {
    server: Mutex<Option<Server>>,
    pending: Arc<Pending>,
}

impl SearchIpcState {
    fn server(&self) -> MutexGuard<'_, Option<Server>> {
        self.server
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn stop(&self) {
        if let Some(server) = self.server().take() {
            server.task.abort();
            let _ = std::fs::remove_file(&server.path);
        }
        self.pending
            .drain(&json!({ "error": "Reflect stopped serving this graph" }));
    }
}

/// Serve the open graph's search on its socket; a no-op while already serving
/// it. Another graph's socket is closed first. Errors (a path too long for a
/// socket, another app serving the graph) leave search reachable only in-app.
#[tauri::command]
pub async fn search_ipc_start(
    app: AppHandle,
    graph: State<'_, GraphState>,
    state: State<'_, SearchIpcState>,
) -> AppResult<()> {
    let root = current_root(&graph)?;
    if state
        .server()
        .as_ref()
        .is_some_and(|server| server.root == root)
    {
        return Ok(());
    }
    state.stop();
    let path = search_socket_path(&root).map_err(AppError::io)?;
    let (listener, owner) = platform::bind(&path).await?;
    let pending = Arc::clone(&state.pending);
    let task = tauri::async_runtime::spawn(async move {
        platform::accept_loop(listener, owner, app, pending).await;
    });
    *state.server() = Some(Server { root, path, task });
    Ok(())
}

/// Close the socket and answer anything still waiting.
#[tauri::command]
pub fn search_ipc_stop(state: State<'_, SearchIpcState>) {
    state.stop();
}

/// The main window's answer to request `id`. An answer arriving after its
/// caller gave up is dropped.
#[tauri::command]
pub fn search_ipc_respond(id: u64, answer: Value, state: State<'_, SearchIpcState>) {
    state.pending.resolve(id, answer);
}

/// Ask the main window, wait for its answer within [`ANSWER_TIMEOUT`].
async fn answer(app: &AppHandle, pending: &Pending, request: Request) -> Value {
    use tauri::Emitter;

    let (id, receiver) = pending.register();
    let payload = json!({
        "id": id,
        "query": request.query,
        "mode": request.mode,
        "limit": request.limit,
    });
    if app
        .emit_to(crate::windows::MAIN_WINDOW_LABEL, REQUEST_EVENT, payload)
        .is_err()
    {
        pending.forget(id);
        return json!({ "error": "Reflect's main window is not open" });
    }
    match tokio::time::timeout(ANSWER_TIMEOUT, receiver).await {
        Ok(Ok(answer)) => answer,
        _ => {
            pending.forget(id);
            json!({ "error": "Reflect did not answer in time" })
        }
    }
}

#[cfg(unix)]
mod platform {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::json;
    use tauri::AppHandle;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{UnixListener, UnixStream};

    use super::{answer, parse_request, Pending, MAX_REQUEST_BYTES, READ_TIMEOUT};
    use crate::error::{AppError, AppResult};

    /// Bind `path`, replacing a socket file a crashed app left behind but
    /// never one another app is still serving. Returns the listener and the
    /// uid allowed to connect: the socket file is ours, so its owner.
    pub async fn bind(path: &Path) -> AppResult<(UnixListener, u32)> {
        if path.exists() {
            if UnixStream::connect(path).await.is_ok() {
                return Err(AppError::io(
                    "another Reflect is already serving search for this graph",
                ));
            }
            std::fs::remove_file(path)?;
        }
        let listener = UnixListener::bind(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        let owner = std::fs::metadata(path)?.uid();
        Ok((listener, owner))
    }

    pub async fn accept_loop(
        listener: UnixListener,
        owner: u32,
        app: AppHandle,
        pending: Arc<Pending>,
    ) {
        loop {
            let stream = match listener.accept().await {
                Ok((stream, _)) => stream,
                // Out of file descriptors and the like: wait rather than spin.
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            let same_user = stream
                .peer_cred()
                .is_ok_and(|credentials| credentials.uid() == owner);
            if !same_user {
                continue;
            }
            let app = app.clone();
            let pending = Arc::clone(&pending);
            tauri::async_runtime::spawn(async move {
                serve(stream, &app, &pending).await;
            });
        }
    }

    async fn serve(stream: UnixStream, app: &AppHandle, pending: &Pending) {
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader.take(MAX_REQUEST_BYTES));
        let mut line = String::new();
        let read = tokio::time::timeout(READ_TIMEOUT, reader.read_line(&mut line)).await;
        let reply = match read {
            Ok(Ok(read)) if read > 0 && line.ends_with('\n') => match parse_request(&line) {
                Ok(request) => answer(app, pending, request).await,
                Err(message) => json!({ "error": message }),
            },
            _ => json!({ "error": "expected one request line" }),
        };
        let mut bytes = reply.to_string().into_bytes();
        bytes.push(b'\n');
        let _ = writer.write_all(&bytes).await;
        let _ = writer.shutdown().await;
    }
}

#[cfg(not(unix))]
mod platform {
    use std::path::Path;
    use std::sync::Arc;

    use tauri::AppHandle;

    use super::Pending;
    use crate::error::{AppError, AppResult};

    pub struct Listener;

    pub async fn bind(_path: &Path) -> AppResult<(Listener, u32)> {
        Err(AppError::io("search for the CLI needs Unix sockets"))
    }

    pub async fn accept_loop(
        _listener: Listener,
        _owner: u32,
        _app: AppHandle,
        _pending: Arc<Pending>,
    ) {
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{parse_request, Pending, Request};

    #[test]
    fn a_well_formed_request_parses() {
        let request =
            parse_request("{\"v\":1,\"query\":\"東京 trip\",\"mode\":\"hybrid\",\"limit\":20}\n")
                .unwrap();
        assert_eq!(
            request,
            Request {
                v: 1,
                query: "東京 trip".to_string(),
                mode: "hybrid".to_string(),
                limit: 20,
            }
        );
    }

    #[test]
    fn malformed_or_unbounded_requests_are_refused() {
        for line in [
            "not json",
            "{\"v\":2,\"query\":\"a\",\"mode\":\"hybrid\",\"limit\":5}",
            "{\"v\":1,\"query\":\"a\",\"mode\":\"vector\",\"limit\":5}",
            "{\"v\":1,\"query\":\"   \",\"mode\":\"hybrid\",\"limit\":5}",
            "{\"v\":1,\"query\":\"a\",\"mode\":\"hybrid\",\"limit\":0}",
            "{\"v\":1,\"query\":\"a\",\"mode\":\"hybrid\",\"limit\":101}",
            "{\"v\":1,\"query\":\"a\",\"mode\":\"hybrid\",\"limit\":5,\"sql\":\"x\"}",
        ] {
            assert!(parse_request(line).is_err(), "{line}");
        }
    }

    #[test]
    fn an_answer_reaches_its_request_once_and_late_ones_are_dropped() {
        let pending = Pending::default();
        let (id, receiver) = pending.register();
        assert!(pending.resolve(id, json!({ "results": [] })));
        assert_eq!(
            tauri::async_runtime::block_on(receiver).unwrap(),
            json!({ "results": [] })
        );
        assert!(!pending.resolve(id, json!({ "results": [] })));

        let (gone, _) = pending.register();
        pending.forget(gone);
        assert!(!pending.resolve(gone, json!({})));
    }

    #[test]
    fn stopping_answers_every_waiting_request() {
        let pending = Pending::default();
        let (_, first) = pending.register();
        let (_, second) = pending.register();
        pending.drain(&json!({ "error": "stopped" }));
        for receiver in [first, second] {
            assert_eq!(
                tauri::async_runtime::block_on(receiver).unwrap(),
                json!({ "error": "stopped" })
            );
        }
    }
}
