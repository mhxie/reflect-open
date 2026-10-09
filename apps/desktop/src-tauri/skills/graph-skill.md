---
name: {{SKILL_NAME}}
description: Read, search, and open notes in the user's "{{GRAPH_NAME}}" Reflect graph via the `reflect` CLI. Use when the user asks about their notes, daily notes, journal, or anything they may have written down in Reflect.
---

# Reflect graph: {{GRAPH_NAME}}

Reflect is a local-first, markdown-backed note-taking app. This skill targets
one graph (a folder of notes):

    {{GRAPH_ROOT}}

Read it through the `reflect` CLI rather than scanning the files — the CLI
resolves titles, aliases, and daily dates, searches the graph's ranked index,
and enforces the privacy contract.

## The CLI

Use `reflect` from PATH when available; the app also bundles the binary at:

    {{CLI_PATH}}

Always target the graph explicitly so calls stay deterministic:

    reflect --graph "{{GRAPH_ROOT}}" <command>

or export `REFLECT_GRAPH="{{GRAPH_ROOT}}"` for a sequence of calls.

## Git history

On desktop, every graph is also a Git repository at its root. Reflect
initializes or adopts that repo when the graph opens; even graphs with no
backup remote keep local history through a commit-only sync loop. There may be
no `origin`, but `.git` history is available.

Use the CLI for current note lookup, privacy filtering, and path resolution.
Use Git only when the user asks for history, diffs, recovery, or past states:

    git -C "{{GRAPH_ROOT}}" log --oneline -- <graph-relative-path>
    git -C "{{GRAPH_ROOT}}" diff <rev> -- <graph-relative-path>
    git -C "{{GRAPH_ROOT}}" show <rev>:<graph-relative-path>

Do not use Git history to bypass privacy. If a note is private, avoid reading
or exposing its current or historical content unless the user explicitly asks.

## Commands

    reflect today              # print today's daily note
    reflect today --path       # its absolute path (works before the file exists)
    reflect search <query>     # ranked full-text search over the graph
    reflect show <note>        # print a note by date, path, title, or alias
    reflect path <note>        # resolve a note to its absolute path
    reflect open <note>        # open the note in the Reflect app
    reflect trust-report       # where to publish wiki trust verdicts (below)

- Add `--json` to any command for stable machine-readable output — the field
  names and exit codes are the supported automation contract.
- `<note>` resolves in order: `YYYY-MM-DD` date, graph-relative path, title,
  then alias (case-insensitive).
- stdout carries only data; warnings and errors go to stderr.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | runtime error (no graph, IO failure) |
| 2 | usage error |
| 3 | note not found, or note is private |
| 4 | search index missing — open the graph in Reflect once to build it |

## Rules

1. **Respect privacy.** Notes with `private: true` frontmatter, and every
   note inside one of the graph's local-only folders, are invisible through
   the CLI by design — no content, no paths, no search hits. Never work
   around this by reading graph files directly unless the user explicitly
   asks for that, and never edit, move, or copy anything inside a local-only
   folder.
2. **The CLI never writes.** Notes are plain markdown under the graph root
   (`daily/YYYY-MM-DD.md`, `notes/*.md`). To change a note, edit the file the
   CLI resolves (`reflect path <note>`); the running app picks the edit up.
3. **Prefer search over enumeration.** `reflect search` uses the app's own
   ranked index; don't grep the whole graph when a search will do.

## Wiki trust (for agent harnesses)

If you evaluate the graph's wiki claims, Reflect can show your verdicts while
the user reads. Reflect computes nothing; you publish a trust report and it
displays it.

- Write one JSON file, format `reflect-wiki-trust` version 1, atomically
  (temporary file, then rename), at the path `reflect trust-report` prints.
  The user can change it in Settings → Wiki, so ask each time rather than
  assuming the default.
- Key each verdict by graph-relative note path and claim id (`c3`), with the
  SHA-256 of the claim text you evaluated: the saved file's UTF-8 bytes
  between `<!-- claim:c3 -->` and `<!-- /claim:c3 -->`, with `\r\n` and `\r`
  turned into `\n`. When the text changes, Reflect shows the claim as awaiting
  evaluation until your next report.
- Reflect writes back only `@pass: editor | status: pending` (the user edited
  a claim) and `@pass: reader | status: flagged` (the user questioned one)
  into the claim's `anchors cN` ledger. Read those on your next pass.
- Leave notes in local-only folders (`reflect trust-report --json` lists
  them as `localOnlyFolders`), and private notes, out of the report.

The format, an example, and a JSON Schema are in Reflect's repository under
`docs/wiki-trust-harness.md`.
