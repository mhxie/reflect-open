use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::sync::mpsc;
use std::thread;

use serde::Deserialize;

use super::*;

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tauri::async_runtime::block_on(future)
}

fn get(url: &str) -> OnDeviceRequest {
    OnDeviceRequest {
        method: "GET".into(),
        url: url.into(),
        headers: Vec::new(),
        body: None,
    }
}

fn post(url: &str, body: &str) -> OnDeviceRequest {
    OnDeviceRequest {
        method: "POST".into(),
        url: url.into(),
        headers: vec![("Content-Type".into(), "application/json".into())],
        body: Some(RequestBody::Text { text: body.into() }),
    }
}

fn local_listener() -> (TcpListener, u16) {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    (listener, port)
}

/// Read one request (head, then a `Content-Length` body) off `stream`.
fn read_request(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut raw = Vec::new();
    let mut byte = [0u8; 1];
    while !raw.ends_with(b"\r\n\r\n") {
        assert_ne!(stream.read(&mut byte).unwrap(), 0, "no request arrived");
        raw.push(byte[0]);
    }
    let head = String::from_utf8(raw).unwrap();
    let length = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    let mut body = vec![0; length];
    stream.read_exact(&mut body).unwrap();
    head + &String::from_utf8(body).unwrap()
}

/// Serve one connection: read its request, hand the stream to `respond`,
/// and return the request as received.
fn serve_once(
    listener: TcpListener,
    respond: impl FnOnce(&mut TcpStream) + Send + 'static,
) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        // macOS hands out accepted sockets with the listener's O_NONBLOCK.
        stream.set_nonblocking(false).unwrap();
        let request = read_request(&mut stream);
        respond(&mut stream);
        request
    })
}

/// Whether nothing ever connected to `listener` (connections wait in its
/// backlog until accepted).
fn never_connected(listener: &TcpListener) -> bool {
    listener.set_nonblocking(true).unwrap();
    matches!(listener.accept(), Err(error) if error.kind() == io::ErrorKind::WouldBlock)
}

async fn read_to_end(state: &OnDeviceHttpState, id: &str) -> Vec<u8> {
    let mut body = Vec::new();
    loop {
        let chunk = state.read(id).await.unwrap();
        if chunk.is_empty() {
            return body;
        }
        body.extend(chunk);
    }
}

#[derive(Deserialize)]
struct LoopbackFixture {
    cases: Vec<LoopbackCase>,
}

#[derive(Deserialize)]
struct LoopbackCase {
    input: String,
    loopback: bool,
}

#[test]
fn loopback_url_matches_the_shared_fixture() {
    let raw = include_str!("../../../../../fixtures/loopback-urls.json");
    let fixture: LoopbackFixture = serde_json::from_str(raw).expect("valid fixture");
    for case in fixture.cases {
        assert_eq!(
            loopback_url(&case.input).is_some(),
            case.loopback,
            "{:?}",
            case.input
        );
    }
}

#[test]
fn the_resolver_answers_only_localhost_and_only_with_ipv4_loopback() {
    let resolve = |name: &str| {
        block_on(LoopbackResolver.resolve(name.parse().unwrap()))
            .map(|addresses| addresses.collect::<Vec<_>>())
    };
    assert_eq!(
        resolve("localhost").unwrap(),
        [SocketAddr::from((Ipv4Addr::LOCALHOST, 0))]
    );
    for name in [
        "example.com",
        "localhost.",
        "foo.localhost",
        "LOCALHOST",
        "127.0.0.1",
    ] {
        let error = resolve(name).expect_err(name);
        assert_eq!(
            error.downcast_ref::<io::Error>().map(io::Error::kind),
            Some(io::ErrorKind::PermissionDenied),
            "{name}"
        );
    }
}

#[test]
fn a_chunked_body_arrives_in_order_across_reads() {
    let (listener, port) = local_listener();
    let (release, released) = mpsc::channel::<()>();
    let server = serve_once(listener, move |stream| {
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
                  Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n",
            )
            .unwrap();
        stream.flush().unwrap();
        released.recv().unwrap();
        stream.write_all(b"6\r\n world\r\n0\r\n\r\n").unwrap();
    });
    let state = OnDeviceHttpState::default();
    let url = format!("http://127.0.0.1:{port}/v1/chat/completions");
    block_on(async {
        let head = state.send("chunked", post(&url, "{}")).await.unwrap();
        assert_eq!(head.status, 200);
        assert_eq!(head.status_text, "OK");
        assert!(head
            .headers
            .contains(&("content-type".into(), "text/event-stream".into())));
        assert_eq!(state.read("chunked").await.unwrap(), b"hello");
        release.send(()).unwrap();
        assert_eq!(state.read("chunked").await.unwrap(), b" world");
        assert_eq!(state.read("chunked").await.unwrap(), b"");
        // The end of the body forgot the request.
        assert!(matches!(
            state.read("chunked").await,
            Err(AppError::NotFound { .. })
        ));
    });
    assert!(server.join().unwrap().ends_with("\r\n\r\n{}"));
}

#[test]
fn request_headers_lose_connection_proxy_and_origin_fields() {
    let (listener, port) = local_listener();
    let server = serve_once(listener, |stream| {
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .unwrap();
    });
    let state = OnDeviceHttpState::default();
    let mut request = post(
        &format!("http://localhost:{port}/v1/chat/completions"),
        r#"{"model":"llama"}"#,
    );
    request.headers.extend(
        [
            ("Origin", "tauri://localhost"),
            ("Host", "evil.example"),
            ("Proxy-Authorization", "Basic c2VjcmV0"),
            ("Accept-Encoding", "gzip"),
            ("Connection", "x-hop"),
            ("X-Hop", "1"),
            ("Authorization", "Bearer local-key"),
        ]
        .map(|(name, value)| (name.to_owned(), value.to_owned())),
    );
    let body = block_on(async {
        state.send("headers", request).await.unwrap();
        read_to_end(&state, "headers").await
    });
    assert_eq!(body, b"ok");
    let received = server.join().unwrap().to_ascii_lowercase();
    assert!(received.starts_with("post /v1/chat/completions http/1.1\r\n"));
    assert!(received.contains(&format!("host: localhost:{port}\r\n")));
    assert!(received.contains("authorization: bearer local-key\r\n"));
    assert!(received.contains("content-type: application/json\r\n"));
    for absent in [
        "origin:",
        "evil.example",
        "proxy-authorization:",
        "accept-encoding:",
        "x-hop:",
    ] {
        assert!(!received.contains(absent), "{absent} was forwarded");
    }
    assert!(received.ends_with(r#"{"model":"llama"}"#));
}

#[test]
fn a_redirect_comes_back_unfollowed() {
    let (first, first_port) = local_listener();
    let (second, second_port) = local_listener();
    let server = serve_once(first, move |stream| {
        write!(
            stream,
            "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:{second_port}/v1\r\n\
             Content-Length: 0\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
    });
    let state = OnDeviceHttpState::default();
    let url = format!("http://127.0.0.1:{first_port}/v1/chat/completions");
    let head = block_on(state.send("redirect", post(&url, "{}"))).unwrap();
    assert_eq!(head.status, 307);
    assert!(head
        .headers
        .iter()
        .any(|(name, value)| name == "location" && value.ends_with(&format!(":{second_port}/v1"))));
    assert_eq!(block_on(state.read("redirect")).unwrap(), b"");
    server.join().unwrap();
    assert!(never_connected(&second));
}

#[test]
fn a_non_loopback_url_is_refused_before_any_socket_opens() {
    let (witness, port) = local_listener();
    let state = OnDeviceHttpState::default();
    for url in [
        format!("http://user:secret@127.0.0.1:{port}/v1"),
        format!("http://[::ffff:127.0.0.1]:{port}/v1"),
        format!("http://127.0.0.1.nip.io:{port}/v1"),
        format!("http://localhost.:{port}/v1"),
        format!("ftp://127.0.0.1:{port}/v1"),
        "http://192.168.1.5:1234/v1".to_owned(),
    ] {
        let refused = block_on(state.send("refused", get(&url)));
        assert!(
            matches!(refused, Err(AppError::Parse { .. })),
            "{url}: {refused:?}"
        );
    }
    assert!(state.requests().live.is_empty());
    assert!(never_connected(&witness));
}

#[test]
fn a_cancel_that_lands_before_its_send_refuses_the_send() {
    let (witness, port) = local_listener();
    let state = OnDeviceHttpState::default();
    state.cancel("early");
    let url = format!("http://127.0.0.1:{port}/v1/models");
    assert!(block_on(state.send("early", get(&url))).is_err());
    assert!(never_connected(&witness));
    assert!(state.requests().early_cancels.is_empty());
}

#[test]
fn cancelling_mid_stream_closes_the_server_socket() {
    let (listener, port) = local_listener();
    let (closed_tx, closed_rx) = mpsc::channel();
    let server = serve_once(listener, move |stream| {
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n\
                  5\r\nhello\r\n",
            )
            .unwrap();
        stream.flush().unwrap();
        let mut byte = [0u8; 1];
        // Times out (an error that is not a reset) if the socket stays open.
        let closed = match stream.read(&mut byte) {
            Ok(read) => read == 0,
            Err(error) => error.kind() == io::ErrorKind::ConnectionReset,
        };
        closed_tx.send(closed).unwrap();
    });
    let state = OnDeviceHttpState::default();
    let url = format!("http://127.0.0.1:{port}/v1/chat/completions");
    block_on(async {
        state.send("stream", post(&url, "{}")).await.unwrap();
        assert_eq!(state.read("stream").await.unwrap(), b"hello");
        // The next read waits on the server when the cancel lands.
        let (read, ()) = tokio::join!(state.read("stream"), async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            state.cancel("stream");
        });
        assert!(read.is_err());
    });
    assert!(
        closed_rx.recv_timeout(Duration::from_secs(20)).unwrap(),
        "the server socket stayed open"
    );
    server.join().unwrap();
    assert!(state.requests().live.is_empty());
}

#[test]
fn a_peer_outside_this_mac_is_refused() {
    for peer in [
        SocketAddr::from((Ipv4Addr::LOCALHOST, 11434)),
        SocketAddr::from(([127, 0, 0, 2], 80)),
        SocketAddr::from((Ipv6Addr::LOCALHOST, 1234)),
    ] {
        assert!(ensure_loopback_peer(Some(peer)).is_ok(), "{peer}");
    }
    assert!(ensure_loopback_peer(None).is_err());
    for peer in [
        SocketAddr::from(([192, 168, 1, 5], 1234)),
        SocketAddr::from(([0, 0, 0, 0], 1234)),
        SocketAddr::from((Ipv6Addr::UNSPECIFIED, 1234)),
        SocketAddr::from((Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1), 1234)),
    ] {
        assert!(ensure_loopback_peer(Some(peer)).is_err(), "{peer}");
    }
}

#[test]
fn localhost_never_reaches_a_listener_bound_only_on_ipv6() {
    let Ok(listener) = TcpListener::bind((Ipv6Addr::LOCALHOST, 0)) else {
        // No IPv6 loopback on this machine: nothing can squat there either.
        return;
    };
    let port = listener.local_addr().unwrap().port();
    let state = OnDeviceHttpState::default();
    let missed = block_on(state.send("v4", get(&format!("http://localhost:{port}/v1/models"))));
    assert!(
        matches!(missed, Err(AppError::Network { .. })),
        "{missed:?}"
    );
    assert!(never_connected(&listener));
    // Control: the literal address does reach it.
    listener.set_nonblocking(false).unwrap();
    let server = serve_once(listener, |stream| {
        stream
            .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
            .unwrap();
    });
    let url = format!("http://[::1]:{port}/v1/models");
    let head = block_on(state.send("v6", get(&url))).unwrap();
    assert_eq!(head.status, 204);
    state.cancel("v6");
    server.join().unwrap();
}

#[test]
fn at_most_eight_requests_are_in_flight() {
    let state = OnDeviceHttpState::default();
    let receivers: Vec<_> = (0..MAX_IN_FLIGHT)
        .map(|index| state.register(&format!("request-{index}")).unwrap())
        .collect();
    assert!(state.register("one-too-many").is_err());
    assert!(state.register("request-1").is_err(), "duplicate id");
    state.cancel("request-0");
    assert!(*receivers[0].borrow(), "the cancel reached the request");
    assert!(state.register("one-too-many").is_ok());
    assert!(state.register("").is_err());
    assert!(state.register(&"x".repeat(MAX_REQUEST_ID_LEN + 1)).is_err());
}

#[test]
fn idle_requests_and_stale_early_cancels_are_swept() {
    let state = OnDeviceHttpState::default();
    let receiver = state.register("idle").unwrap();
    state.cancel("never-sent");
    state
        .requests()
        .sweep(Instant::now() + IDLE_TIMEOUT + EARLY_CANCEL_TTL);
    let requests = state.requests();
    assert!(requests.live.is_empty());
    assert!(requests.early_cancels.is_empty());
    assert!(*receiver.borrow(), "a swept request is cancelled");
}

#[test]
fn request_bodies_are_decoded_and_capped() {
    assert_eq!(request_body(None).unwrap(), None);
    assert_eq!(
        request_body(Some(RequestBody::Base64 {
            data: "aGk=".into()
        }))
        .unwrap(),
        Some(b"hi".to_vec())
    );
    assert!(request_body(Some(RequestBody::Base64 {
        data: "not base64!".into()
    }))
    .is_err());
    assert!(request_body(Some(RequestBody::Text {
        text: "x".repeat(MAX_REQUEST_BODY_BYTES + 1)
    }))
    .is_err());
}

#[test]
fn only_ordinary_methods_are_sent() {
    let url = "http://localhost:11434/v1/models";
    for method in ["GET", "post", "DELETE", "options"] {
        let mut request = get(url);
        request.method = method.into();
        assert!(prepare(request).is_ok(), "{method}");
    }
    for method in ["CONNECT", "TRACE", "BREW", ""] {
        let mut request = get(url);
        request.method = method.into();
        assert!(prepare(request).is_err(), "{method}");
    }
}

const PROXY_CHILD_PHASE: &str = "REFLECT_ON_DEVICE_PROXY_CHILD";

/// The proxy variables must be in place before the client is built, and
/// changing them under other tests would race, so each phase runs
/// [`proxy_child`] in a process of its own with the variables set from birth.
/// The control phase proves the variables do reach an ordinary client.
#[test]
fn a_proxy_in_the_environment_never_carries_an_on_device_request() {
    for (phase, expect_proxied) in [("hardened", false), ("control", true)] {
        let (proxy, proxy_port) = local_listener();
        let proxy_url = format!("http://127.0.0.1:{proxy_port}");
        let mut child = Command::new(std::env::current_exe().unwrap());
        child
            .args([
                "on_device_http::tests::proxy_child",
                "--exact",
                "--ignored",
                "--test-threads=1",
            ])
            .env(PROXY_CHILD_PHASE, phase)
            .env_remove("NO_PROXY")
            .env_remove("no_proxy");
        for name in [
            "ALL_PROXY",
            "all_proxy",
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
        ] {
            child.env(name, &proxy_url);
        }
        let output = child.output().unwrap();
        assert!(
            output.status.success(),
            "{phase} phase failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(!never_connected(&proxy), expect_proxied, "{phase} phase");
    }
}

#[test]
#[ignore = "runs in its own process, from a_proxy_in_the_environment_never_carries_an_on_device_request"]
fn proxy_child() {
    let Ok(phase) = std::env::var(PROXY_CHILD_PHASE) else {
        return;
    };
    let (listener, port) = local_listener();
    let url = format!("http://127.0.0.1:{port}/v1/models");
    if phase == "control" {
        // The proxy never answers, so this times out after reaching it.
        let client = Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let _ = block_on(async { client.get(&url).send().await });
        return;
    }
    let server = serve_once(listener, |stream| {
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .unwrap();
    });
    let state = OnDeviceHttpState::default();
    let body = block_on(async {
        tokio::time::timeout(Duration::from_secs(20), async {
            let head = state.send("direct", get(&url)).await.unwrap();
            assert_eq!(head.status, 200);
            read_to_end(&state, "direct").await
        })
        .await
    })
    .expect("the request reached the server directly");
    assert_eq!(body, b"ok");
    server.join().unwrap();
}
