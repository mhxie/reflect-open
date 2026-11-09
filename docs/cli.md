# The `reflect` CLI

A small, self-contained read/discovery CLI over a Reflect graph (Plan 14). It
reads the graph's markdown files directly and opens `.reflect/index.sqlite`
strictly read-only, so no running desktop app is required except for semantic
and hybrid `search`, which ask it. It never writes: markdown edits are the
write path, and the desktop app refreshes the index.

```
reflect today              # print today's daily note
reflect search <query>     # ranked full-text search over the index
reflect show <note>        # print a note by date, path, title, or alias
reflect path <note>        # resolve a note to its absolute path
reflect open <note>        # open a note in the app (reflect:// deep link)
reflect trust-report       # where agent harnesses publish wiki trust verdicts
```

`reflect --help` lists the flags, graph resolution order, and exit codes
(`apps/cli/src/main.rs`). Built from `apps/cli` (`cargo build -p reflect-cli`);
bundled with the desktop app as a Tauri sidecar (macOS:
`Reflect.app/Contents/MacOS/reflect`, Linux `.deb`: `/usr/bin/reflect`). For
local development: `cargo install --path apps/cli`.

## Design choices

- **No fallback to the desktop app's recent-graphs config.** The graph comes
  only from `--graph`, `$REFLECT_GRAPH`, or a `.reflect/` walk-up, so the CLI
  stays deterministic for scripts and agents.
- **Private notes are invisible.** Notes with `private: true` give no content,
  no paths, and no search hits, and no flag overrides this. `show`, `today`,
  `path`, and `open` explain on stderr and exit `3`. The check reads the
  resolved file's own frontmatter, never just the index row, so a stale index
  can't leak a just-flagged note.
- **stdout carries only data** (content, paths, or JSON). Warnings and errors
  go to stderr.
- **The CLI never runs the indexer.** `search` exits `4` without an index
  (open the graph in Reflect to build it). When files diverge from the index,
  results still return with a stderr warning and `"stale": true`.
- **Search ranks like the app.** Terms match literally (FTS5 operators have no
  meaning) at word starts, so `car` finds `Car log`, never `Oscar party`.
- **`today --path` and `path YYYY-MM-DD` print the would-be daily path** before
  the file exists. Dailies are created lazily, so this is how scripts create
  them.
- **`open` uses the most durable address**: the date for dailies, the
  frontmatter `id` when present (it survives renames), else the path
  ([docs/deep-links.md](deep-links.md)). The CLI does not mint ids; "Copy deep
  link" in the app does. `--print` prints the URL without launching the app.
- Ambiguous `show`/`path` matches resolve to the first path alphabetically and
  list the others on stderr.

Terms in scripts written without spaces match anywhere in titles or bodies through
overlapping character pairs. A Latin word glued to a run (`Python` in `用Python写脚本`) is
found too. Queries of four words or more (two CJK characters count as one word)
are topped up after all-term matches with notes holding the most and rarest
terms, ranked by bm25. Punctuation-only terms are ignored in mixed queries. Body matches include
snippets; CJK matches show the body around the first occurrence. The default
limit is 20; semantic and hybrid searches allow at most 100. Human-readable
results show the first segment of a `Title // Alias` title; JSON keeps it whole.

### Privacy and local-only folders

Frontmatter the CLI can't read with certainty (YAML that
doesn't parse but mentions `private` or holds a backslash, a `private` value
that is neither true nor false, a block behind a byte-order mark) is treated
as private too; the stderr message says why, so the YAML can be fixed. The
desktop app classifies with the same rules, pinned against this crate
(`crates/frontmatter`) by a shared corpus; on some malformed YAML the two
parsers disagree on whether the block parses at all
(`fixtures/parity/README.txt`).

Notes inside the graph's local-only folders (configured in the desktop app,
which records the folder names in the index) are treated the same way: never
returned, refused with exit `3`, and left out of the staleness check — the CLI
never follows the symlinks such folders usually are, so their indexed rows
would otherwise read as deleted. The CLI keeps every name the record lists,
as the desktop does, even one the desktop would no longer accept. If the
record is present but cannot be read, which notes are local-only is unknown,
so `show`, `path`, `open`, and `search` refuse every note with exit `3` until
Reflect records the folders again (`today` reads only `daily/`, which can
never be local-only). The same holds when `.reflect/index.sqlite` exists but
cannot be read at all (for example a write-ahead log only the app can
recover): `show`, `path`, and `open` refuse every note with exit `3` rather
than scan the files, and `search` exits `4` as before. With no index file at
all, they scan the files, and the local-only folders come from the desktop
app's settings document instead (`<config dir>/reflect-open/settings.json`,
this graph's `"localOnlyFolders"` entry): a real directory configured there
is refused like any local-only folder. If that document cannot be read or
its entry for this graph is malformed, they refuse every note with exit `3`.

### Semantic and hybrid search

```text
reflect search <query> [--limit N] [--mode lexical|semantic|hybrid] [--json]
```

`--mode` defaults to `lexical`, everything above. `semantic` and `hybrid` rank
by meaning as well, which needs the embedding model the Reflect app runs: the
CLI asks the app serving this graph over a Unix socket in `.reflect/`
(`search.sock`, owner-only), and the app answers with the same retrieval ⌘K
and its AI tools use. The CLI never loads a model or reads the vector table,
and still re-checks every returned path against the file's own frontmatter.
When the app isn't open on this graph, or can't answer, the exit code is `5`,
so a script can fall back to `lexical`. While the app's semantic search is
off or its model is loading, it answers lexically and `"mode"` says so;
`"stale"` is always `false` here, since the app's index is live. A graph
whose path makes the socket longer than 103 bytes can't be searched this way.

JSON search results include `query`, the effective `mode`, `stale`, and a
`results` array of `{ path, title, snippet, score }`. A result without a body
match has an empty snippet; title-prefix recall scores `0`, and
tokenizer-normalized title matches retain their bm25 score. The app transport
failure above is exit `5`; other exit codes stay `0` (success), `1` (runtime
error), `2` (usage error), `3` (not found or private), and `4` (missing or
unusable search index).

### `reflect trust-report [--json]`

Prints where an agent harness publishes this graph's wiki trust report: the
path set in Settings → Wiki → Trust report, or `.harness/wiki-trust.json`
when none is set. The setting lives outside the graph, so a harness asks here
instead of assuming the default. With `--json` it also lists the graph's
local-only folders, whose notes a report must leave out. It exits 3 when they
cannot be read, or when a folder on the path is a link, which Reflect does not follow. See [wiki-trust-harness.md](wiki-trust-harness.md).

```jsonc
// reflect trust-report --json
{ "path": ".harness/wiki-trust.json", "absolutePath": "/graphs/Personal/.harness/wiki-trust.json", "configured": false, "exists": true, "localOnlyFolders": ["secure"] }
```

## For agents

The six commands plus `--json` are the supported automation surface. The JSON
shapes are locked by `apps/cli/tests/cli.rs`. Field names and exit codes are
stable: new fields may be added, existing ones won't change meaning. Reading a
private note is not possible through this surface by design. Don't work around
it by reading graph files directly unless the user asked for that.

Settings → Agents installs a per-graph agent skill
(`~/.agents/skills/reflect-<graph-slug>/SKILL.md`) that teaches coding agents
this contract. A `reflect-managed` sha256 marker lets the app refresh its own
installs without overwriting a hand-edited one
(`apps/desktop/src-tauri/src/skill.rs`).

## Development notes

- The CLI deliberately duplicates a thin read-side contract from
  `@reflect/core` (path conventions, fold keys, frontmatter coercions, title
  derivation, SHA-256 hashing, FTS match syntax). Each Rust module names its
  TS counterpart. The shared parity corpus in
  [`fixtures/parity/`](../fixtures/parity/README.txt) pins the contract: TS
  generates `expected.json` from the real core pipeline and the Rust tests
  assert against it. Don't grow the surface.
- tauri-build requires the sidecar binary
  (`apps/desktop/src-tauri/binaries/`, gitignored) to exist before the desktop
  crate compiles. `pnpm tauri dev`/`build` stage it automatically. Before a
  bare `cargo build/test --workspace`, run `pnpm --filter @reflect/desktop
  sidecar` once.
