# What leaves the device, and when

Reflect is local-first: your notes are markdown files in a folder you chose, the search
index is SQLite in `.reflect/` beside them, and **no Reflect-hosted server exists in any
path** — there is no product analytics and no account. Official release builds send
scrubbed WebView diagnostics to Sentry, and official iOS release builds also send scrubbed
native crash diagnostics. Every network call the app can make is listed here, with what it
carries.

The one hard rule sits above all of it: **a note with `private: true` frontmatter never
has its content sent to any external service.** This is enforced in code at every AI
call site (the `CloudSafe` type brand in `packages/core/src/ai/` — content for a
provider cannot even be constructed from a private note, and the flag is re-read from
disk at call time), and it is covered by tests.

## AI chat (off until you add a key)

- **Where:** directly to the provider whose API key *you* added — OpenAI, Anthropic,
  Google, or OpenRouter. Keys are bring-your-own; Reflect proxies nothing.
- **What:** your chat messages and configured system prompt, plus what the model's
  tools read from your graph: search snippets, note content, and note listings. The
  configured prompt is stored in the device's ordinary settings file and is sent with
  every chat turn. Private notes are dropped from every tool result, and reading one is
  refused outright — the model sees a refusal, not the content. That protection cannot
  identify note content you manually paste into a message or the configured prompt.
- **When:** only while you use chat (⌘J). No background calls.

## Audio memos (off until you add a key)

- **Where:** directly to your configured providers. OpenAI or Google receives the
  recording for speech-to-text. A small text model from your configured OpenAI,
  Anthropic, or Google provider receives the fresh transcript to create the memo
  title and, when Transcription auto-format is enabled, add punctuation, paragraphs,
  and light Markdown to the body.
- **What:** the recorded audio bytes and the transcript produced from that recording.
  Existing note content is never read or sent. The resulting Markdown is written
  locally. Because no note content is read, recording works even when today's note is
  private. Turn Transcription auto-format off in Settings to store the raw provider
  transcript; the title-generation call still receives that transcript.
- **When:** when you record a memo, and on retry for memos still awaiting
  transcription.
- **On-device engine (macOS):** choosing *On this Mac* in Settings transcribes with a
  Whisper model running locally on Metal; the recording never leaves the device. The
  model downloads **from Hugging Face** when you ask for it (0.6–1.6 GB), carrying no
  user data. While *Check for model updates* is on (the default), Reflect asks Hugging
  Face at most once a day whether the downloaded model has newer weights; that request
  carries no user data either, and newer weights install only when you accept them.
  Nothing else leaves the device either: on-device memos skip the text-model pass,
  keeping the raw transcript and a title taken from its first words.

## Semantic search (off by default)

- Embeddings are computed **on-device** (a bundled ONNX runtime; `all-MiniLM-L6-v2`)
  and stored in `.reflect/`. Note content never leaves the machine for embedding.
- Enabling it downloads the model (~90 MB) **from Hugging Face, once**. That request
  carries no user data; the model is cached locally afterwards.

## Backup & sync (off until you connect)

- **Where:** the git repository you connect — GitHub guided in-app (created **private**
  by default; a public repo requires explicit confirmation), or any git host over SSH.
- **What:** the whole graph as git commits — including notes marked `private: true`.
  The privacy flag blocks *services that read your content*; backup is your own
  repository, and excluding private notes from it would silently lose them. The
  one exception is [local-only folders](#local-only-folders-macos), which are
  never staged.
- **When:** after you connect, on the background backup cadence and on "Back up now".
- **Large files stay out.** A file of 95 MiB or more is never committed (GitHub
  rejects files over 100 MB, failing the whole push); Reflect reports each one whose
  changes it withheld. To lower the limit for a graph, add an entry to the settings
  file (`~/Library/Application Support/reflect-open/settings.json`), keyed by the
  graph's root path, giving a whole number of MiB from 1 to 95:

  ```json
  "backupMaxFileMiB": { "/Users/me/Notes": 32 }
  ```

  It applies the next time the graph opens, and Reflect keeps the entry as written
  when it saves its own settings, as it does for
  [local-only folders](#local-only-folders-macos). A value outside that range, or an
  entry for a path that does not exist, is shown as a warning when the graph opens,
  and the 95 MiB limit applies.
- **Separate histories are never joined on their own** (this fork). Every backup
  history starts from a root commit. Reflect pauses sync instead of pulling in commits
  that start from a root this graph has not accepted, whether they arrive as a merge
  of two unrelated histories or as a fast-forward that carries one in (a device still
  on a history you replaced merging it back in), and it refuses to push a history
  whose root the backup lacks, checked against the backup as it stands when the push
  starts. The pause comes before your notes, the branch, the index, or the merge
  state change (the fetch that found the other history has already downloaded its
  commits into the graph's `.git` folder), shows in Settings → Backup, and names each
  commit. If the other history is expected (say, a device that started its own graph
  joined this backup), list the full 40-character ids under the graph's root path in
  the settings file, then reopen the graph:

  ```json
  "acceptedHistoryRoots": { "/Users/me/Notes": ["<40-character commit id>"] }
  ```

  Connecting a graph that already has history (local history included) to an
  existing backup is such a join: its first sync pauses, naming the backup's root
  and the graph's own, until both are listed. Once a device joins, every other device
  running this fork pauses on that device's root at its next pull, and needs the same
  entry in its own settings file. If the other history is not expected, don't accept
  it: when the backup's history is the one to keep (it was rewritten on purpose, say),
  re-clone this graph from the backup; otherwise restore the backup repository from a
  good copy (see [generic git remotes](./generic-git-remotes.md#when-it-fails)). Roots
  already in this graph's history are never checked again; a graph with no commits
  yet adopts the backup's history as before, and the first push to an empty backup
  goes out as before. The check compares root commits only: a rewrite that kept the
  original root (one that removed files the first commit never held, say) is not a
  separate history to it, so a device still on the old history would merge it back in
  without a pause. Stop those devices before such a rewrite. Reflect keeps the entry
  as written when it saves its own settings; an id that is not a full commit id, or an
  entry for a path that does not exist, is shown as a warning when the graph opens and
  is ignored.
- GitHub sign-in uses the OAuth device flow against `github.com`; the token is stored
  in the OS keychain.

## Browser capture (the Chrome extension)

- **Where:** nowhere on the network. The **Reflect Capture** extension hands each
  capture to a local native-messaging host (`reflect-capture-host`) that the desktop
  app registers on your machine; the host spools it to the capture inbox on disk
  (`<graph>/.reflect/inbox/`) and the app drains it on next launch. **No Reflect-hosted
  server, no third party, and no other destination is ever contacted** — the extension
  stores no keys and makes no AI or network calls of its own.
- **What:** the page you explicitly capture (toolbar button or ⌘⇧K): its URL,
  title, your current text selection, a screenshot of the visible tab, and, only when
  you tick "Capture page text", the page's extracted text. When enabled, X bookmark
  and like capture observe the corresponding request on x.com and save the post
  identifier and available post snapshot locally. Bookmark capture defaults to on;
  like capture defaults to off. Both settings are independent in the extension's
  options page. Existing likes and actions in native X apps are not imported.
  Unliking does not remove content from Reflect. A request can be saved even if
  X later rejects it. Unrelated browsing content is not captured.
- **When:** when you capture a page or perform an enabled bookmark or like action
  on x.com in this browser. Disabling a setting stops new captures; accepted ones
  remain queued. If the desktop app isn't reachable yet, the capture is
  held in the browser's local extension storage and retried automatically until it
  spools — it is never sent anywhere else in the meantime.
- Once a capture lands in your graph, the desktop app's rules above apply unchanged:
  enrichment may request the captured URL directly to read page metadata. On macOS and
  iOS, Reflect also asks Apple's LinkPresentation framework for one representative
  image when the capture has no screenshot. These requests go to the captured website
  and any redirects or subresources selected by the operating system, never through a
  Reflect server. The app re-reads the capture and daily note before and after each
  request; `private: true` prevents the request or discards its result. A successful
  image is downscaled and stored as a local JPEG in the graph. Any BYOK AI enrichment
  then follows the provider rules above.

## Local-only folders (macOS, off by default)

Some notes should never leave this Mac at all — not even to your own backup
repository. A graph can name **local-only folders**: every folder with one of
the configured names (at any depth) is local-only. Typically each is a symlink
from the graph into a separate "raw store" directory outside it (for example
`finance/secure` → `<raw store>/finance/secure`), so the files themselves never
sit inside the synced graph.

- **Where:** nowhere. Notes inside a local-only folder are listed, opened,
  previewed, searched locally (including on-device semantic search), and
  resolved as link and backlink targets — and that is all.
- **What is blocked:** they are private whatever their frontmatter says (every
  AI surface, asset descriptions of images they reference or contain, gist
  publishing, link previews, and X/YouTube/remote-image embeds); they open
  read-only and the app never writes, creates, moves, or deletes anything
  inside them; Git backup never stages the folder entry or anything in it; and
  the `reflect` CLI treats them as private.
- **Git pulls never write into them.** Another device's changes inside a
  local-only folder stay in the backup's history but are not applied on this
  Mac, and Reflect warns when a pull skips one. Files committed before a
  folder became local-only stay frozen: never updated, deleted, or checked
  out again here.
- **Git pulls never start tracking a folder this Mac's history does not
  track.** If the backup gains files inside a local-only folder this Mac's
  history does not track (another device added them, or a bad merge brought
  them back), sync pauses before your notes, the branch, or the index change:
  once tracked, they would ride along in every later backup from this Mac.
  Reflect never deletes them itself. To go on, remove them from the backup in
  a separate clone (`git rm -r --cached <folder>`, then commit and push), or
  restore the backup repository from a good copy. A folder this Mac's history
  already tracks (say, one committed before it became local-only) keeps
  following the backup in history, new files included, and is still never
  written here; the same command, run in this graph, takes it out of the
  backup's later commits at the next sync (the files stay on this Mac's disk
  and in history). Either way, every other device that tracks the folder, the
  phone included, deletes its copies at its next sync (history keeps them):
  copy what you need off those devices first, and stop editing the folder
  there, or an edit made there brings the files back and this Mac's next pull
  pauses again.
- **How to configure:** add an entry for the graph to the settings file
  (`~/Library/Application Support/reflect-open/settings.json`), keyed by the
  graph's root path. It applies the next time the graph opens (switch to it
  again, or relaunch); Reflect keeps the entry as written when it saves its
  own settings. If the file stops parsing (say, a stray comma), Reflect
  refuses to save *any* setting until it is fixed or removed, rather than
  overwrite it and lose this entry.

  ```json
  "localOnlyFolders": {
    "/Users/me/Notes": { "folders": ["secure"], "rawRoot": "/Users/me/Raw" }
  }
  ```

  Folder names are plain ASCII, one folder name each, and never one of the
  folders Reflect manages (`daily`, `notes`, `templates`, `assets`,
  `audio-memos`). A link is followed only when its target resolves to a
  directory inside `rawRoot`, which must neither contain the graph nor lie
  inside it; nothing inside the raw store is followed further. Without a
  valid `rawRoot` the folders stay private, read-only, and out of Git
  backups, but unreadable. Reflect shows every problem it finds when the graph opens
  (a dropped name, an unusable `rawRoot`, an entry for a path that no longer
  exists or is not a graph you have opened).
- **If the configuration goes missing, the folders stay local-only.**
  Reflect remembers, in the graph's index, which folders were local-only
  when the graph last opened; while a pause lasts it only adds to that list,
  so a folder you list meanwhile is remembered even if it is dropped again
  before the pause ends. When the settings file cannot be read, or no
  longer lists one of them (moving or renaming the graph changes its key, for
  example), that folder stays private and read-only, and Reflect pauses Git
  sync, the iCloud conflict sweep and move-in, and every path that sends a
  note's or attachment's content off the device (the AI chat's note and
  attachment reads, transcription, asset descriptions, capture enrichment,
  gist publishing) until the configuration lists it again. Two of those
  pauses are partial: on-device transcription keeps running (its recordings
  stay on the Mac, and it never transcribes one inside a local-only folder),
  and so does enrichment of captures without a screenshot, which reads no
  attachment. The editor's AI selection menu and the chat's graph statistics
  keep working: neither can carry content from those folders, which open
  read-only (without that menu) and are left out of the statistics.
- **If that memory cannot be read,** Reflect pauses the same way. While it
  is damaged (it no longer parses, or is not text), the `reflect` CLI
  refuses every note (`reflect today` aside: daily notes are never
  local-only), and when the graph's own entry names at least one valid
  folder and none in both lists, Reflect records the entry in its place,
  names what it records, and resumes at the next open. Check that list: a folder it leaves out is no longer
  remembered. To end up with no local-only folders at all, list a placeholder
  name in `folders` (for example `placeholder`; no such folder needs to
  exist), open the graph once, then release it as described next.
- **To stop treating a folder as local-only on purpose,** take it out of
  `folders` and add it to `released` in the graph's own entry, for example
  `{ "folders": [], "released": ["secure"] }`. The next time the graph opens,
  Reflect lets it go and says so; after that you can remove the `released`
  list. A released name only counts in the entry for this graph and only for
  a folder Reflect remembers, so a moved graph or a typo still keeps the
  folder local-only. A name listed in both `folders` and `released` stays
  local-only, and Reflect warns and pauses the same way until you remove it
  from one of the two lists: from `released` to keep the folder local-only,
  or from `folders` to let it go. Do it right away, because while the pause
  lasts, any edit that drops the name from `folders` (a typo included)
  releases the folder.
- **A released folder is ordinary again, Git backups included.** For a real
  directory, the next commit stages this Mac's copies of its files,
  including ones frozen since it became local-only, and the deletion of any
  this Mac no longer has, so the backup's latest version can undo other
  devices' changes inside it (the history keeps them). For a linked folder,
  the link itself (its target path) is committed unless the graph's
  `.gitignore` lists the name.
- **That memory stays with this copy of the graph.** It lives in the graph's
  `.reflect/` folder, which Git backups, sync providers, and Time Machine do
  not carry (Reflect excludes it from backups). A graph restored or moved
  without `.reflect/`, whose local-only folder is a real directory and whose
  settings entry no longer matches, loses this protection. A linked folder
  stays safe: without a configuration Reflect never follows the link.
- **Unpublish first.** A gist published from a note before its folder became
  local-only stays published, and the read-only view cannot unpublish it:
  unpublish before moving the note in.
- **Also list the names in the graph's `.gitignore`** (for example
  `secure`, without a trailing slash, which would match only a real
  directory and not a link). Reflect's own commits never need it, but `git`
  run outside Reflect does not read Reflect's settings.
- **Keep the raw store available offline.** Evicted (cloud-only) files in it
  are skipped rather than downloaded on demand.
- **iCloud Drive and other sync folders.** When the graph itself lives in a
  synced folder (iCloud Drive, Dropbox, Google Drive, OneDrive), that
  provider still syncs a *real* local-only folder inside it: Reflect cannot
  stop another app's sync, and it never marks your folders to try (the marks
  would also drop them from Time Machine, and Dropbox deletes an ignored
  folder from your other devices). Keep such notes in a raw store outside the
  synced graph and link them in. Reflect's own iCloud conflict sweep never
  reads, merges, or writes inside a local-only folder, and moving a graph into
  iCloud Drive leaves local-only folders and links behind; configure the new
  root and recreate the links there.

## Apple Contacts (off by default)

- **Where:** nowhere on the network. Enabling the Contacts integration reads the
  **macOS/iOS contacts store on-device** (the same store System Settings governs),
  behind the standard OS permission prompt. There is no Reflect copy of your address
  book: lookups are live queries, nothing is mirrored into `.reflect/`, and Reflect
  never writes back to Contacts.
- **What:** a note title or a meeting attendee's email is matched against your
  contacts; a match's name, email, and phone are shown on a suggestion card. Contact
  details enter a note **only when you click Add**, at which point they are ordinary
  markdown you own — covered by the same rules as anything else you type (including
  `private: true` and backup).
- **When:** only while the integration is on, and only for the note being viewed (or
  the meeting being added). Turning it off — in Settings or in the OS privacy pane —
  stops all reads immediately.

## Exception diagnostics (on in official release builds)

- **Where:** Sentry. The React/WebView SDK handles JavaScript exceptions; on iOS a
  native SDK handles host-process crashes, fully blocking main-thread hangs, watchdog
  terminations, and converted Apple MetricKit diagnostics — the failures that never
  reach the JavaScript layer, and that arrive in TestFlight with no usable stack.
- **What:** an allow-listed diagnostic containing the JavaScript exception class (or a
  fixed native failure category), sanitized stack locations, the app/build version, and
  whether the exception was marked handled. Native reports also carry non-identifying
  OS/device model, architecture, memory, storage, battery, and thermal facts, which are
  what distinguish a resource termination from a code defect. A small set of vetted
  JavaScript structural error messages that cannot contain document data is kept; every
  native exception value and all other exception text is redacted. JavaScript filenames
  and native loaded-image names are reduced to basenames.
- **Never collected:** request data, note content, note titles, graph paths, local
  filesystem paths, native source paths, frame variables, source context lines, thread
  names, breadcrumbs, console or Rust tracing output, session replay, performance
  traces and profiles, screenshots, view hierarchy, raw MetricKit payloads, and user
  identifiers. Sentry is also configured not to store the transport IP address with
  events.
- **When:** only when an official desktop or iOS release raises an uncaught JavaScript
  error, an unhandled promise rejection, or a caught/recoverable React error — and on
  iOS, the native failure categories above. The WebView SDK initializes only in official
  builds carrying the release DSN. The iOS native SDK initializes only in release
  configurations of the official `app.reflect.ios` bundle; debug builds compile the
  call out entirely, and forks run under their own bundle identifier and stay silent.
- **Operational safeguards:** Sentry's server-side and default scrubbers are enabled, IP
  address storage and server-side JavaScript source scraping are disabled, and explicit
  sensitive-field rules cover notes, graph paths, requests, and user identifiers. Private
  JavaScript source maps and native dSYMs are uploaded during official builds so stacks
  are readable; native symbol uploads exclude sources, and neither kind of symbol file
  ships as readable source in the app bundle.

## Housekeeping calls

- **API key validation:** adding a provider key sends one cheap authenticated probe to
  that provider to test it. No content.
- **Update check:** the packaged app fetches a release manifest (`latest.json`) from
  this repository's GitHub Releases on launch and every six hours. Stable builds check
  the latest stable release; beta builds check the beta feed. The app downloads the
  update archive only when you ask it to install. No user data is sent; payloads are
  verified against a public key compiled into the app before installing. Offline, the
  check fails silently and the app carries on.

## Secrets

API keys and tokens live in the **OS keychain only** — never in markdown, never in
`.reflect/`, never in git. Deleting a provider in Settings deletes its keychain entry.

## Summary table

| Call | Destination | Carries note content? | Off by default? |
| --- | --- | --- | --- |
| AI chat | Your chosen provider | Yes — private-note tool reads are blocked | Yes (needs your key) |
| Audio transcription | Your chosen providers | No existing note content; audio and its fresh transcript | Yes (needs your key) |
| On-device transcription | Nowhere (on-device) | — (audio stays on your Mac) | Yes (opt-in download) |
| Transcription model update check | Hugging Face | No | On once the model is downloaded |
| Embeddings | Nowhere (on-device) | — | Yes (opt-in download) |
| Model download | Hugging Face | No | Yes (opt-in) |
| Backup | Your git repository | Yes — including private notes, never local-only folders | Yes (needs connecting) |
| Key validation | The provider | No | — (only when adding a key) |
| Update check | GitHub Releases | No | On in packaged builds |
| Browser capture | Nowhere (local host on disk) | — (stays on your machine) | — (only when you capture) |
| Capture metadata and preview | The captured website, via Reflect and Apple LinkPresentation | URL only; private captures are blocked | No (after an explicit capture) |
| Contacts lookup | Nowhere (on-device OS store) | — (stays on your machine) | Yes (opt-in) |
| Exception diagnostics | Sentry | No — free-form messages and context are redacted | No (official releases) |
