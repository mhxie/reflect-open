# Connecting an agent harness to wiki trust

Reflect shows how well each wiki claim stands, but it does not decide. An
agent harness (atelier, or any other) owns the trust algorithm, ranking, and
source reputation. The two meet at one file: the harness writes a **trust
report** into the graph, and Reflect reads and displays it. This page is the
whole contract.

## The loop

1. The harness reads the wiki's Markdown: claims, evidence ledgers, and
   citations, in the format of the atelier wiki schema
   (`protocols/wiki-schema.md` in atelier).
2. It evaluates claims and sources however it likes.
3. It writes the trust report, atomically (write a temporary file in the same
   folder, then rename it over the report), so Reflect never reads half a file.
4. Reflect picks up the new report within seconds and on window focus, and
   shows each verdict whose claim text is unchanged.
5. While reading, a person may edit a claim or question it. Reflect records
   that in the Markdown (below); the harness sees it on its next pass.

## Where the report lives

Settings → Wiki → **Trust report** holds the graph-relative path. Ask for it
rather than assuming the default:

    reflect --graph <graph> trust-report        # prints the absolute path
    reflect --graph <graph> trust-report --json # also the local-only folders

The default is `.harness/wiki-trust.json`. A path is valid when every segment
is plain (not empty, `.`, or `..`, and without `\` or `:`), it ends in `.json`, and it is not
under `.reflect/` (Reflect's rebuildable state) or `.git/`; the cases are in
[`fixtures/wiki-trust-report-paths.json`](../fixtures/wiki-trust-report-paths.json).
Prefer a hidden folder: a report under a visible folder is listed among the
graph's attachments.

The report syncs wherever the graph syncs, so Reflect on other devices,
including iOS, shows trust without the harness running there. With Git backup,
Reflect commits each new version it sees while the graph is open (it checks
every few seconds); write the report when verdicts change rather than on a
timer.

## The format

A JSON object, validated against
[`wiki-trust-report.schema.json`](wiki-trust-report.schema.json) (generated
from the reader, so it cannot drift). A complete example:
[`fixtures/wiki-trust-report.example.json`](../fixtures/wiki-trust-report.example.json).

Fields not marked optional are required.

| Field | Meaning |
|---|---|
| `format` | Always `"reflect-wiki-trust"`. |
| `version` | `1`. Adding optional fields keeps version 1; a new version is for changes Reflect would misread. Reflect refuses a version it does not read and says so in Settings. |
| `generated_at` | When the report was written (RFC 3339). |
| `harness` | `{ "name", "version"? }`, shown in Settings. |
| `notes` | Entries by graph-relative note path (`wiki/memory/Spacing effect.md`); Reflect compares paths in Unicode NFC. |
| `notes.<path>.claims` | Verdicts by claim id: `c` and a positive number without leading zeros (`c1`, `c12`). |
| `sources` | Optional standings by origin key: any string you choose that names one source and stays the same across reports (a DOI, a normalized domain). Reflect only matches it to verdicts. |
| `source_threshold` | Optional weight a source needs to count as trusted, 0–1; drawn as a tick on each source's weight bar. |

A claim verdict:

| Field | Meaning |
|---|---|
| `tier` | `"solid"` (filled mark), `"supported"` (ring), or `"needs-work"` (dashed ring; inline, the prose is underlined). Closed in version 1: any other value drops the verdict. |
| `overlays` | Optional. `"disputed"` draws the mark and underline in red and names the claim Disputed; `"edited"` adds "edited since review" to the card. Unknown values are ignored. |
| `text_sha256` | SHA-256 of the claim text you evaluated, lowercase hex (below). |
| `evaluated_at` | The day you evaluated it, `YYYY-MM-DD`; the card cites it once the text has changed. |
| `reasons` | Optional `[{ "text" }]`, listed on the card in order. Write `text` for a reader. |
| `next` | Optional sentence on the card: what would raise the tier. |
| `sources` | Optional origin keys the verdict rests on, linking to `sources`; the card lists each with its weight. |

A source standing: `label`, `weight` (normalized across the wiki, 0–1),
`trusted` (whether it clears your threshold), optional `url` (an `http` or
`https` address Reflect links to) and `reasons` (`[{ "text" }]`).
How you normalize and where the threshold sits are yours to decide; keep the
scale independent of corpus size, or a fixed threshold drifts as the wiki
grows.

Reflect drops a note, claim, or source entry that does not validate, or a
claim whose id is malformed, and counts it in Settings, so one bad entry never
blanks the whole wiki. An optional field may be omitted or `null`. Keys it
does not know are ignored, so later versions can add optional fields.

While a new report fails to read or validate, Reflect keeps showing the last
one that did and says why in Settings.

## The claim text hash

A verdict only shows while the claim reads as it did when you evaluated it.
For each claim:

1. Take the note's saved text and turn CRLF and lone CR into LF. No other
   normalization.
2. Slice the bytes after the opening marker's `-->` and before the closing
   marker's `<!--`. Markers are HTML comments, `<!-- claim:cN -->` and
   `<!-- /claim:cN -->`, with any spaces or tabs after `<!--` and before
   `-->`, and none inside `/claim:cN`.
3. Hash the UTF-8 bytes with SHA-256 and write lowercase hex.

Test vectors:
[`fixtures/wiki-claim-text-hashes.json`](../fixtures/wiki-claim-text-hashes.json).

Reflect hashes the note as saved, as you read it, and an edit not yet saved
shows at once. Either way the claim reads **changed since its last
evaluation** until a report carries the new hash.

### What is not a claim

Reflect shows no verdict for a claim its editor flags; the parser
(`readWikiClaimIndex` in `packages/core/src/wiki/article.ts`) is the full
rule. The cases:

- Legacy `### [Cn]` claims, which carry their ledger inside their own range.
- An id without exactly one opening marker and one later closing marker, or
  whose text is empty.
- Markers inside a link, wikilink, inline code, or heading, or ones that
  change how the Markdown around them parses (as in
  `a*<!-- claim:c1 -->x<!-- /claim:c1 -->*b`), split a citation from its
  date, or cross a table cell.
- Ranges that nest or overlap, or that sit in a code fence or the article's
  Evidence, References, or revision section.
- An id also used by a `### [Cn]` heading claim.

## Records Reflect writes back

Reflect writes only what the schema defines, into the claim's `anchors cN`
ledger, a fenced block under the article's `## Evidence` (or `## References`)
heading, which Reflect creates when the claim has none:

    ```anchors c2
    @anchor: url:https://example.org/study | valid_at: 2024-05-01
    @pass: reader | status: flagged | at: 2026-10-08
    ```

The records:

- `@pass: editor | status: pending | at: YYYY-MM-DD` after a person changes a
  claim's text in Reflect. Never for a file reloaded from disk.
- `@pass: reader | status: flagged | at: YYYY-MM-DD` when a person questions a
  claim while reading, at most once a day per claim. What resolves it is your
  rule; Reflect shows only your verdict.

## Privacy

The report is read on this device and drawn on screen; Reflect sends it
nowhere. It does sync, and Git backup commits it, wherever your graph goes,
so leave out notes marked `private: true` and notes under local-only folders:
no verdicts for them, and no reasons quoting their text. Only Reflect knows
which folders are local-only: `trust-report --json` lists their names as
`localOnlyFolders`, and a note is under one when any folder in its path has
one of those names (compared ignoring ASCII case). When Reflect cannot tell,
the command exits 3; write no report then.

## Checking your report

Open Settings → Wiki. The Trust report row shows the harness name, when the
report was written, how many claims it covers, and any entries it ignored, or
why the file could not be read.
