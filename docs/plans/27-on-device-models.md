# Plan 27 — On-device models

**Goal:** let a model the user runs on this Mac (Ollama, LM Studio, any
OpenAI-compatible server on a loopback host) eventually read private and local-only
notes, while cloud models never can. This document covers phase **C1**: the hardened
transport and the attestation. C1 grants no private access. That arrives with C2,
behind the verification step V1 below.

**Depends on:** BYOK providers and the cloud privacy gate (Plan 10,
`packages/core/src/privacy/checkers.ts`), and OpenAI-compatible entries in
`settings.aiProviders`.

**Platforms:** the transport compiles for every target; the attestation UI is desktop
only. The mobile add-provider drawer is unchanged.

## Threat model

Reflect can prove only where a request's socket goes. It cannot see whether the
server behind a loopback socket runs the model locally or forwards the request:
Ollama cloud models, LiteLLM, SSH port-forwards and similar gateways all listen on
`localhost`. So "runs on this Mac" rests on the user's attestation of one exact
endpoint and model, and everything Reflect *can* check is checked on every call:

1. The URL's literal host is loopback.
2. `localhost` resolves to 127.0.0.1 only, without the system resolver.
3. No proxy is consulted and no redirect is followed.
4. The peer that answered is a loopback address (a backstop: the request is gone by
   then).

Before C1, OpenAI-compatible calls to `localhost` went through
`tauri-plugin-http`, which honours the macOS system proxy and follows up to ten
redirects, resending the body. That leaked API keys and note content for local
endpoints. C1 fixes it for every loopback endpoint, attested or not.

## Design

### Loopback predicate (one rule, two languages)

`isLoopbackHttpUrl` (`packages/core/src/privacy/loopback.ts`) and
`on_device_http::loopback_url` (Rust) accept http(s) without credentials to exactly
`localhost`, 127.0.0.0/8 or `[::1]`, read from the WHATWG-normalized host. So `127.1`,
`0x7f.1` and `[0:0:0:0:0:0:0:1]` count; `localhost.`, `*.localhost`,
`localhost.localdomain`, `0.0.0.0`, IPv4-mapped IPv6, zone ids, LAN/VPN addresses and
`127.0.0.1.nip.io` do not. `fixtures/loopback-urls.json` pins both sides.

The TS predicate lives in a leaf module: the settings schema reaches it through
`ai/openai-compatible.ts`, and `privacy/on-device.ts` imports the chat model
resolution, which imports the provider catalog, which imports
`ai/openai-compatible.ts` again. A leaf keeps module evaluation acyclic;
`privacy/on-device.ts` re-exports the predicate.

The plain-http warning in the add-provider forms now uses the predicate, so every
127.x host counts as this Mac (it used to accept only `127.0.0.1`).

### Rust transport (`apps/desktop/src-tauri/src/on_device_http.rs`)

One reqwest client, built once: `no_proxy()`, `redirect::Policy::none()`, a
`LoopbackResolver` that answers only `localhost` with `127.0.0.1` (one address
family, so a process bound only on `::1` never receives a `localhost` request;
IPv6-only servers are configured as `http://[::1]:port`), a 5 s connect timeout and a
300 s per-read timeout (no total timeout: generations stream for minutes).

Commands:

- `on_device_http_send {requestId, method, url, headers, body}` refuses a non-loopback
  URL before any socket opens, strips hop-by-hop, `Proxy-*`, `Host`, `Origin`,
  `Content-Length`, `Expect` and `Accept-Encoding` headers (the client does not decode
  compressed bodies), allows ordinary methods only, caps the body at 32 MiB, and
  races the send against a cancel. It returns `{status, statusText, headers}` and
  parks the response.
- `on_device_http_read {requestId}` returns the next raw chunk as a
  `tauri::ipc::Response`; an empty chunk means the body ended and forgets the
  request.
- `on_device_http_cancel {requestId}` stops a send or read in flight and drops the
  response, which closes its connection.

`OnDeviceHttpState` holds at most 8 requests and sweeps any left unread for 10
minutes. A cancel can land before its send registers (two IPC calls, either
order), so a cancel for an unknown id is remembered for a minute and refuses that
send. Nothing logs URLs, headers or bodies, and errors never echo them (reqwest's
URL is stripped from transport errors).

### Core adapter and routing

`onDeviceFetch` (`packages/core/src/ai/on-device-fetch.ts`) is a `typeof fetch` over
those commands. It re-checks the URL before touching the bridge, accepts a string,
`URL` or `Request`, sends string or `Uint8Array` bodies, maps an abort to
`on_device_http_cancel` plus an `AbortError`, and streams the body by pulling. A
transport failure rejects like fetch's own `TypeError('fetch failed')`, so the AI SDK
reports "Cannot connect to API: …".

Routing is decided in core, so no call site can pick the wrong transport:
`languageModel` uses `onDeviceFetch` for every loopback OpenAI-compatible config,
whatever fetch the caller passed; `validateApiKey` probes loopback endpoints through
it and releases the body once it has the status; background passes that default to
`fetchFn ?? fetch` are covered through `languageModel`. The browser dev bridge
answers `on_device_http_*` with a "needs the desktop app" error.

### Attestation

OpenAI-compatible entries gain three optional settings fields:

- `onDevice: {baseUrl, model} | null`: the attestation. Absent, `null` and malformed
  all mean "not attested".
- `contextWindow`: whole tokens, at least 2048. A malformed value is dropped
  rather than the whole entry (dropping the entry would orphan its keychain key).
- `supportsImages`: absent or malformed means no.

`resolveOnDeviceTarget(resolved)` (`privacy/on-device.ts`) mints a branded
`OnDeviceTarget` only when the resolved config (after the picked model id is applied)
is OpenAI-compatible, its base URL is loopback, and the attestation names exactly that
base URL and model. The target carries a frozen copy of the config, and
`languageModelFor(target, apiKey, cloudFetch)` builds the model from that copy alone,
returning a `TargetModel` bound to its target. Anything else is a `CloudTarget`
(`modelTarget`). `isOnDeviceOption` applies `resolveChatModel`'s rule to one picker
option, and `pickOnDeviceProvider` prefers the default entry, then the first entry,
that resolves on-device.

An attestation never outlives what it names: changing an entry's default model drops
an attestation for another model (`withAiProviderModel`), attesting is refused for a
non-loopback base URL (`withAiProviderOnDevice`), and a hand-edited base URL or model
leaves the attestation inert. The settings row then asks the user to re-confirm.

### Settings UI

Copy stays neutral until C2 makes private access real.

- Add form, OpenAI-compatible: Ollama and LM Studio quick-fill buttons, a "Runs on
  this Mac" switch (enabled only for a loopback URL; otherwise the hint "Only for
  localhost, 127.x.x.x or [::1]"), "Can read images", and an optional "Context
  length (tokens)".
- Provider row: an "On this Mac · <model>" badge (a laptop icon; the lock already
  means "Lock note"), the switch (turning it on opens a dialog naming the exact model
  and endpoint; turning it off applies at once), a "Re-confirm: endpoint or model
  changed" alert for a stale attestation, and the two capability fields.
- The chat picker labels attested options "· On this Mac".

The confirm dialog: Reflect will treat <model> at <baseUrl> as running on this Mac.
Reflect connects only to this Mac, with no proxy and no redirects, but cannot see
what the server does next. Turn this on only if the server runs the model on this
Mac and does not forward requests (Ollama cloud models, LiteLLM, SSH tunnels and
similar gateways do). The copy never claims "never".

## V1: verify Ollama's API (pending)

`verifyOnDeviceServer(target)` is the hook C2 calls on every turn and run before
content the cloud gate withholds reaches an on-device model. Until V1 is done it
answers `'ok'`. **C2's private access does not ship until V1 is resolved:** either
the probe below is implemented, or the user chooses attestation only (open
decision 1 of the C plan).

V1 is manual. It needs a machine with Ollama installed and network access to install
it; the environment C1 was built in had neither.

TODO, on a current Ollama release, check and record the findings and versions here:

- [ ] (a) Whether /api/tags and /api/show report remote_host and remote_model (or
  equivalent fields) for a cloud model such as gpt-oss:120b-cloud, and omit them for
  a local model. Also check an alias made with ollama cp from a cloud model, and a
  Modelfile FROM <x>-cloud. Inference, medium confidence.
- [ ] (b) What /api/version returns.
- [ ] (c) Whether there is a setting that disables cloud models. Inference, low
  confidence.
- [ ] (d) The default context lengths on Ollama's OpenAI-compatible endpoint and on LM
  Studio. These feed ON_DEVICE_DEFAULT_CONTEXT.

If (a) holds, implement `verifyOnDeviceServer` in `privacy/server-probe.ts` over
`onDeviceFetch`:

- GET `{origin}/api/version`. A JSON `{version}` answer identifies an Ollama server.
- For an Ollama server, POST `{origin}/api/show` with `{model}`.
- Refuse ("This model runs in Ollama's cloud") when the remote fields are present,
  when the probe errors, or when the response does not parse. This fails closed.
- A server that does not answer as Ollama gets `'ok'` and relies on the attestation
  alone.
- Nothing is cached across turns; each probe is a loopback call of a few
  milliseconds.

Tests, with a fake bridge: Ollama with a local model is ok; with a cloud model,
refused; `/api/show` erroring, refused; a non-Ollama server (404 on `/api/version`),
ok; malformed JSON from an Ollama server, refused; the provider fetch is never
called.

If (a) does not hold, follow the user's choice in open decision 1.

## Rejected alternatives

- **tauri-plugin-http for loopback calls:** a client per request, the system proxy by
  default (and through feature unification for the app's own reqwest), redirects
  followed. Not provably local.
- **A boolean "runs locally" flag:** consent would carry over to any model id the
  entry later uses, including the catalog's `local-model` placeholder.
- **Refusing `-cloud` model names:** binds to nothing; `ollama cp` and
  `FROM <x>-cloud` produce aliases without the suffix.
- **Answering `localhost` with both 127.0.0.1 and ::1:** a squatter bound only on the
  other family would receive the request.

## Next: C2

The LocalSafe brand and on-device mints, `note_read_for_device`, on-device chat tools
built on the cloud path, conversation pinning, the AI menu on private notes, and
on-device memo titling. The switch label gains "(can read private notes)" and
`AGENTS.md`/`docs/privacy.md` gain the on-device clause in the same change.
