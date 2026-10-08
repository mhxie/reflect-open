# Connecting an agent harness to wiki trust

Reflect shows how well each wiki claim stands, but it does not decide. An
agent harness (atelier, or any other) owns the trust algorithm, ranking, and
source reputation. The two meet at one file: the harness writes a **trust
report** into the graph, and Reflect reads and displays it. This page is the
whole contract; [Plan 30](plans/30-claim-trust.md) records the design.

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

The default is `.harness/wiki-trust.json`. A path is valid when every segment
is plain (no empty, `.`, or `..` segment), it ends in `.json`, and it is not
under `.reflect/` (Reflect's rebuildable state) or `.git/`; the cases are in
[`fixtures/wiki-trust-report-paths.json`](../fixtures/wiki-trust-report-paths.json).
Prefer a hidden folder: a report under a visible folder is listed among the
graph's attachments.

The report syncs wherever the graph syncs, so Reflect on other devices,
including iOS, shows trust without the harness running there. With Git backup
each new report is committed; write it when verdicts change rather than on a
timer.

## The format

A JSON object, validated against
[`wiki-trust-report.schema.json`](wiki-trust-report.schema.json) (generated
from the reader, so it cannot drift). A complete example:
[`fixtures/wiki-trust-report.example.json`](../fixtures/wiki-trust-report.example.json).

| Field | Meaning |
|---|---|
| `format` | Always `"reflect-wiki-trust"`. |
| `version` | `1`. Reflect refuses a version it does not read and says so in Settings. |
| `generated_at` | When the report was written (RFC 3339). |
| `harness` | `{ "name", "version"? }`, shown in Settings. |
| `notes` | Entries by graph-relative note path (`wiki/memory/Spacing effect.md`); Reflect compares paths in Unicode NFC. |
| `notes.<path>.claims` | Verdicts by claim id (`c1`, `c2`, …). |
| `sources` | Optional standings by origin key (below). |
| `source_threshold` | Optional weight a source needs to count as trusted, 0–1. |

A claim verdict:

| Field | Meaning |
|---|---|
| `tier` | `"solid"`, `"supported"`, or `"needs-work"`. |
| `overlays` | Optional: `"disputed"`, `"edited"`. Unknown values are ignored. |
| `text_sha256` | SHA-256 of the claim text you evaluated, lowercase hex (below). |
| `evaluated_at` | The day you evaluated it, `YYYY-MM-DD`. |
| `reasons` | Optional `[{ "text", "kind"? }]`, shown in order. Write `text` for a reader. |
| `next` | Optional sentence: what would raise the tier. |
| `sources` | Optional origin keys the verdict rests on, linking to `sources`. |

A source standing: `label`, `weight` (normalized across the wiki, 0–1),
`trusted` (whether it clears your threshold), optional `url` and `reasons`.
How you normalize and where the threshold sits are yours to decide; keep the
scale independent of corpus size, or a fixed threshold drifts as the wiki
grows.

Reflect drops a note, claim, or source entry that does not validate, or a
claim whose id is not `c` and a positive number, and counts it in Settings, so
one bad entry never blanks the whole wiki. Keys it does not know are ignored,
so later versions can add optional fields.

## The claim text hash

A verdict only shows while the claim reads as it did when you evaluated it.
Take the note's text with CRLF and lone CR turned into LF (Reflect holds every
note that way), then hash the UTF-8 bytes between the end of
`<!-- claim:cN -->` and the start of `<!-- /claim:cN -->`: SHA-256, lowercase
hex. No other normalization. Legacy `### [Cn]` claims carry their ledger
inside their own range, so Reflect shows no trust for them. Test vectors:
[`fixtures/wiki-claim-text-hashes.json`](../fixtures/wiki-claim-text-hashes.json).

When the text changes, Reflect shows the claim as **changed since its last
evaluation** until a report carries the new hash.

## Records Reflect writes back

Reflect writes only what the schema defines, into the claim's `anchors cN`
ledger:

- `@pass: editor | status: pending | at: YYYY-MM-DD` after a person changes a
  claim's text in Reflect. Never for a file reloaded from disk.
- `@pass: reader | status: flagged | at: YYYY-MM-DD` when a person questions a
  claim while reading. What resolves it is your rule.

## Privacy

The report is read on this device and drawn on screen; Reflect sends it
nowhere. It does sync wherever your graph syncs, so leave out notes under
local-only folders and notes marked `private: true`: no verdicts for them,
and no reasons quoting their text.

## Checking your report

Open Settings → Wiki. The Trust report row shows the harness name, when the
report was written, how many claims it covers, and any entries it ignored, or
why the file could not be read.
