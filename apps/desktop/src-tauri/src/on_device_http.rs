//! The hardened HTTP transport for model servers on this Mac (Ollama, LM
//! Studio, any OpenAI-compatible endpoint on a loopback host), reached from
//! `@reflect/core`'s `onDeviceFetch`.
//!
//! tauri-plugin-http cannot carry these calls: it builds a client per request
//! that honours the system proxy (its default `system-proxy` feature, which
//! Cargo feature unification also turns on for this crate's reqwest) and it
//! follows up to ten redirects, resending the body. A request to `localhost`
//! through it is therefore not provably local. The client here is built once,
//! with every proxy cleared, redirects off, and a resolver that answers only
//! `localhost`.
//!
//! Three things keep a request on this Mac before any byte is sent:
//! 1. [`loopback_url`]: the URL's literal host is `localhost`, 127.0.0.0/8 or
//!    `[::1]`. IP literals never reach a resolver, so this check owns them.
//! 2. [`LoopbackResolver`]: `localhost` resolves to 127.0.0.1 only, without
//!    asking the system resolver.
//! 3. `no_proxy()`: no system or environment proxy is ever consulted.
//!
//! After the send, the connected peer must be a loopback address
//! ([`ensure_loopback_peer`]). That is only a backstop: by then the request
//! has gone out.
//!
//! Responses stream by pulling: [`on_device_http_send`] returns the head and
//! parks the body in [`OnDeviceHttpState`]; each [`on_device_http_read`]
//! returns the next raw chunk, and an empty chunk means the body ended.
//! Nothing here logs URLs, headers or bodies, and no error echoes them.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use base64::Engine;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONNECTION};
use reqwest::{redirect, Client, Method, Response, Url};
use serde::{Deserialize, Serialize};
use tokio::sync::{watch, Mutex as AsyncMutex};
use url::Host;

use crate::error::{AppError, AppResult};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Applies to each read, not the whole response: generations stream for minutes.
const READ_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_REQUEST_BODY_BYTES: usize = 32 * 1024 * 1024;
const MAX_IN_FLIGHT: usize = 8;
/// A response nobody has read for this long is dropped (its reader went away).
const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How long a cancel that arrived before its send keeps refusing that send.
const EARLY_CANCEL_TTL: Duration = Duration::from_secs(60);
const MAX_EARLY_CANCELS: usize = 64;
/// Request ids are UUIDs minted by `onDeviceFetch`; anything longer is refused.
const MAX_REQUEST_ID_LEN: usize = 128;

const ALLOWED_METHODS: [Method; 7] = [
    Method::GET,
    Method::POST,
    Method::PUT,
    Method::PATCH,
    Method::DELETE,
    Method::HEAD,
    Method::OPTIONS,
];

/// The parsed URL when `value` is http(s) to a literal loopback host
/// (`localhost`, 127.0.0.0/8 or `[::1]`) with no credentials; `None`
/// otherwise. Mirrors `isLoopbackHttpUrl` in `@reflect/core`
/// (`privacy/loopback.ts`); `fixtures/loopback-urls.json` pins the two.
pub(crate) fn loopback_url(value: &str) -> Option<Url> {
    let url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let loopback = match url.host()? {
        Host::Domain(domain) => domain == "localhost",
        Host::Ipv4(address) => address.octets()[0] == 127,
        Host::Ipv6(address) => address == Ipv6Addr::LOCALHOST,
    };
    loopback.then_some(url)
}

/// Answers only the exact name `localhost`, and only with 127.0.0.1. One
/// address family on purpose: answering `::1` too would let a process bound
/// only on the other family receive the request. Servers that listen only on
/// IPv6 are configured as `http://[::1]:port`.
struct LoopbackResolver;

fn resolve_loopback(name: &str) -> io::Result<Vec<SocketAddr>> {
    if name == "localhost" {
        // Port 0 is replaced by the URL's port.
        Ok(vec![SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)])
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "on-device requests only resolve localhost",
        ))
    }
}

impl Resolve for LoopbackResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let answer = resolve_loopback(name.as_str());
        Box::pin(async move {
            answer
                .map(|addresses| Box::new(addresses.into_iter()) as Addrs)
                .map_err(|error| Box::new(error) as Box<dyn std::error::Error + Send + Sync>)
        })
    }
}

fn build_client() -> AppResult<Client> {
    Client::builder()
        .no_proxy()
        .redirect(redirect::Policy::none())
        .dns_resolver(Arc::new(LoopbackResolver))
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()
        .map_err(|error| AppError::io(error.to_string()))
}

fn client() -> AppResult<&'static Client> {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = build_client()?;
    Ok(CLIENT.get_or_init(|| client))
}

/// The backstop after the send: the peer that answered must be this Mac.
fn ensure_loopback_peer(peer: Option<SocketAddr>) -> AppResult<()> {
    let loopback = match peer.map(|address| address.ip()) {
        Some(IpAddr::V4(address)) => address.is_loopback(),
        Some(IpAddr::V6(address)) => {
            address == Ipv6Addr::LOCALHOST
                || address
                    .to_ipv4_mapped()
                    .is_some_and(|mapped| mapped.is_loopback())
        }
        None => false,
    };
    if loopback {
        Ok(())
    } else {
        Err(AppError::io(
            "the on-device server did not answer from this Mac, so its response was dropped",
        ))
    }
}

/// Headers `onDeviceFetch` may not set: the connection's own (hop-by-hop,
/// `Host`, `Content-Length`), the proxy's, the webview's `Origin`, and
/// `Accept-Encoding`, because this client does not decode compressed bodies.
fn is_stripped_header(name: &HeaderName) -> bool {
    let name = name.as_str();
    matches!(
        name,
        "accept-encoding"
            | "connection"
            | "content-length"
            | "expect"
            | "host"
            | "keep-alive"
            | "origin"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    ) || name.starts_with("proxy-")
}

fn request_headers(pairs: &[(String, String)]) -> AppResult<HeaderMap> {
    let mut headers = HeaderMap::new();
    for (name, value) in pairs {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| AppError::parse("an on-device request header has an invalid name"))?;
        let value = HeaderValue::from_str(value)
            .map_err(|_| AppError::parse("an on-device request header has an invalid value"))?;
        headers.append(name, value);
    }
    // `Connection` can name further hop-by-hop headers.
    let named: Vec<HeaderName> = headers
        .get_all(CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|token| HeaderName::from_bytes(token.trim().as_bytes()).ok())
        .collect();
    let stripped: Vec<HeaderName> = headers
        .keys()
        .filter(|name| is_stripped_header(name))
        .cloned()
        .chain(named)
        .collect();
    for name in stripped {
        headers.remove(name);
    }
    Ok(headers)
}

/// A request body as `onDeviceFetch` sends it over the JSON IPC.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum RequestBody {
    /// Text, sent as UTF-8: the JSON body of every OpenAI-compatible call.
    Text { text: String },
    /// Raw bytes, base64-encoded.
    Base64 { data: String },
}

fn request_body(body: Option<RequestBody>) -> AppResult<Option<Vec<u8>>> {
    let bytes = match body {
        None => return Ok(None),
        Some(RequestBody::Text { text }) => text.into_bytes(),
        Some(RequestBody::Base64 { data }) => base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| AppError::parse("the on-device request body is not valid base64"))?,
    };
    if bytes.len() > MAX_REQUEST_BODY_BYTES {
        return Err(AppError::parse(
            "the on-device request body is larger than 32 MiB",
        ));
    }
    Ok(Some(bytes))
}

/// One request as `onDeviceFetch` describes it.
#[derive(Debug)]
pub(crate) struct OnDeviceRequest {
    pub(crate) method: String,
    pub(crate) url: String,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: Option<RequestBody>,
}

/// A request that passed every check and may be sent.
struct PreparedRequest {
    method: Method,
    url: Url,
    headers: HeaderMap,
    body: Option<Vec<u8>>,
}

fn prepare(request: OnDeviceRequest) -> AppResult<PreparedRequest> {
    let url = loopback_url(&request.url).ok_or_else(|| {
        AppError::parse("on-device requests only reach this Mac: localhost, 127.x.x.x or [::1]")
    })?;
    let method = Method::from_bytes(request.method.to_ascii_uppercase().as_bytes())
        .ok()
        .filter(|method| ALLOWED_METHODS.contains(method))
        .ok_or_else(|| AppError::parse("unsupported on-device request method"))?;
    Ok(PreparedRequest {
        method,
        url,
        headers: request_headers(&request.headers)?,
        body: request_body(request.body)?,
    })
}

/// The response head handed back to `onDeviceFetch`.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResponseHead {
    status: u16,
    status_text: String,
    /// Name/value pairs in arrival order; values that are not visible ASCII
    /// are skipped, since the webview's `Headers` would reject them.
    headers: Vec<(String, String)>,
}

fn response_head(response: &Response) -> ResponseHead {
    let status = response.status();
    ResponseHead {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_owned(),
        headers: response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_owned(), value.to_owned()))
            })
            .collect(),
    }
}

/// A transport failure, described without the URL reqwest would attach.
fn transport_error(error: reqwest::Error) -> AppError {
    let error = error.without_url();
    let mut message = error.to_string();
    let mut root: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(&error);
    while let Some(next) = root.and_then(|cause| cause.source()) {
        root = Some(next);
    }
    if let Some(cause) = root {
        message.push_str(": ");
        message.push_str(&cause.to_string());
    }
    AppError::Network { message }
}

fn cancelled_error() -> AppError {
    AppError::io("the on-device request was cancelled")
}

async fn next_chunk(response: &mut Response) -> reqwest::Result<Option<Vec<u8>>> {
    // An empty chunk would read as the end of the body, so skip any.
    while let Some(chunk) = response.chunk().await? {
        if !chunk.is_empty() {
            return Ok(Some(chunk.to_vec()));
        }
    }
    Ok(None)
}

/// Resolves once the request is cancelled. A dropped sender means its entry
/// is gone, which counts as cancelled too.
async fn cancelled(receiver: &mut watch::Receiver<bool>) {
    let _ = receiver.wait_for(|cancelled| *cancelled).await;
}

struct LiveRequest {
    cancel: watch::Sender<bool>,
    /// The response, once the head arrived; its body is read chunk by chunk.
    response: Option<Arc<AsyncMutex<Response>>>,
    touched: Instant,
}

#[derive(Default)]
struct Requests {
    live: HashMap<String, LiveRequest>,
    /// Ids cancelled before their send registered (two IPC calls can land in
    /// either order); a later send with one of these ids is refused.
    early_cancels: HashMap<String, Instant>,
}

impl Requests {
    fn sweep(&mut self, now: Instant) {
        self.live.retain(|_, request| {
            let fresh = now.duration_since(request.touched) < IDLE_TIMEOUT;
            if !fresh {
                request.cancel.send_replace(true);
            }
            fresh
        });
        self.early_cancels
            .retain(|_, cancelled_at| now.duration_since(*cancelled_at) < EARLY_CANCEL_TTL);
    }
}

/// On-device requests between their send and the end of their body, keyed by
/// the id `onDeviceFetch` minted. At most [`MAX_IN_FLIGHT`] at once.
#[derive(Default)]
pub struct OnDeviceHttpState {
    requests: Mutex<Requests>,
}

impl OnDeviceHttpState {
    fn requests(&self) -> MutexGuard<'_, Requests> {
        self.requests.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn register(&self, id: &str) -> AppResult<watch::Receiver<bool>> {
        if id.is_empty() || id.len() > MAX_REQUEST_ID_LEN {
            return Err(AppError::parse("invalid on-device request id"));
        }
        let now = Instant::now();
        let mut requests = self.requests();
        requests.sweep(now);
        if requests.early_cancels.remove(id).is_some() {
            return Err(cancelled_error());
        }
        if requests.live.contains_key(id) {
            return Err(AppError::parse("duplicate on-device request id"));
        }
        if requests.live.len() >= MAX_IN_FLIGHT {
            return Err(AppError::io("too many on-device requests at once"));
        }
        let (cancel, receiver) = watch::channel(false);
        requests.live.insert(
            id.to_owned(),
            LiveRequest {
                cancel,
                response: None,
                touched: now,
            },
        );
        Ok(receiver)
    }

    fn forget(&self, id: &str) {
        if let Some(request) = self.requests().live.remove(id) {
            request.cancel.send_replace(true);
        }
    }

    /// Send `request`, park its body under `id`, and return the head.
    pub(crate) async fn send(&self, id: &str, request: OnDeviceRequest) -> AppResult<ResponseHead> {
        let prepared = prepare(request)?;
        let client = client()?;
        let mut cancel = self.register(id)?;
        let mut builder = client
            .request(prepared.method, prepared.url)
            .headers(prepared.headers);
        if let Some(body) = prepared.body {
            builder = builder.body(body);
        }
        let outcome = tokio::select! {
            biased;
            () = cancelled(&mut cancel) => Err(cancelled_error()),
            sent = builder.send() => sent.map_err(transport_error),
        };
        let response = match outcome.and_then(|response| {
            ensure_loopback_peer(response.remote_addr())?;
            Ok(response)
        }) {
            Ok(response) => response,
            Err(error) => {
                self.forget(id);
                return Err(error);
            }
        };
        let head = response_head(&response);
        let mut requests = self.requests();
        // Absent when a cancel landed after the send finished.
        let live = requests.live.get_mut(id).ok_or_else(cancelled_error)?;
        live.response = Some(Arc::new(AsyncMutex::new(response)));
        live.touched = Instant::now();
        Ok(head)
    }

    /// The next chunk of `id`'s body; empty once the body ended, which also
    /// forgets the request.
    pub(crate) async fn read(&self, id: &str) -> AppResult<Vec<u8>> {
        let (response, mut cancel) = {
            let now = Instant::now();
            let mut requests = self.requests();
            requests.sweep(now);
            let live = requests
                .live
                .get_mut(id)
                .ok_or_else(|| AppError::not_found("no such on-device request"))?;
            let response = live
                .response
                .clone()
                .ok_or_else(|| AppError::io("the on-device response has not arrived yet"))?;
            live.touched = now;
            (response, live.cancel.subscribe())
        };
        let mut body = response.lock().await;
        let chunk = tokio::select! {
            biased;
            () = cancelled(&mut cancel) => Err(cancelled_error()),
            chunk = next_chunk(&mut body) => chunk.map_err(transport_error),
        };
        drop(body);
        match chunk {
            Ok(Some(bytes)) => {
                if let Some(live) = self.requests().live.get_mut(id) {
                    live.touched = Instant::now();
                }
                Ok(bytes)
            }
            Ok(None) => {
                self.forget(id);
                Ok(Vec::new())
            }
            Err(error) => {
                self.forget(id);
                Err(error)
            }
        }
    }

    /// Stop `id` wherever it is: a send in flight, a read in flight, or a body
    /// waiting to be read. Dropping the response closes its connection.
    pub(crate) fn cancel(&self, id: &str) {
        let now = Instant::now();
        let mut requests = self.requests();
        requests.sweep(now);
        if let Some(request) = requests.live.remove(id) {
            request.cancel.send_replace(true);
        } else if requests.early_cancels.len() < MAX_EARLY_CANCELS {
            requests.early_cancels.insert(id.to_owned(), now);
        }
    }
}

/// Command: send one request to a server on this Mac and return the response
/// head. The body waits for [`on_device_http_read`].
#[tauri::command]
pub(crate) async fn on_device_http_send(
    state: tauri::State<'_, OnDeviceHttpState>,
    request_id: String,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<RequestBody>,
) -> AppResult<ResponseHead> {
    state
        .send(
            &request_id,
            OnDeviceRequest {
                method,
                url,
                headers,
                body,
            },
        )
        .await
}

/// Command: the next raw chunk of a response body; empty at its end.
#[tauri::command]
pub(crate) async fn on_device_http_read(
    state: tauri::State<'_, OnDeviceHttpState>,
    request_id: String,
) -> AppResult<tauri::ipc::Response> {
    Ok(tauri::ipc::Response::new(state.read(&request_id).await?))
}

/// Command: stop a request and drop its response.
#[tauri::command]
pub(crate) async fn on_device_http_cancel(
    state: tauri::State<'_, OnDeviceHttpState>,
    request_id: String,
) -> AppResult<()> {
    state.cancel(&request_id);
    Ok(())
}

#[cfg(test)]
mod tests;
