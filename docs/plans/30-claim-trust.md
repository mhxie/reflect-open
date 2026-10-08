# 30: Claim-level trust

Status: proposed on `docs/claim-trust-plan`. Baseline: `b914fd4a`.

## Product goal

While reading a wiki article, a person can tell at a glance which claims are
solid and which still need work, and why. The same verdict appears in the
editor, the Wiki screen, translations, and the `reflect` CLI, so agents and
people act on one signal.

## Ownership

The harness decides; Reflect shows and offers interfaces. atelier-wiki
(`atelier/protocols/wiki-schema.md`) owns the wiki format, the trust
algorithm, ranking, and source reputation. Reflect renders the harness's
results, keeps them honest about freshness, and records what a person does
while reading in the schema's own syntax. Reflect never computes a tier, a
score, a rank, or a source weight.

| atelier-wiki (harness) | Reflect |
|---|---|
| Schema and marker vocabulary | Parses the schema for display and editing |
| Claim tiers, overlays, reasons, scores | Renders them; marks results stale when text changed |
| Ranking (note and claim) | Orders lists and search by the published rank |
| Source reputation: continuous weights, global normalization, trust threshold | Shows each source's weight and whether it clears the threshold |
| Writes the trust report | Validates and projects the report; exposes it to the CLI |
| Conformance fixtures for its rules | Fixtures for parsing and report reading only |

## Baseline behavior

- Claim ranges render with no trust signal. They are hidden until the claim
  toggle shows `C1` labels; evidence is folded at the end of the article
  (`apps/desktop/src/editor/wiki-anchors/wiki-article-plugin.tsx`).
- The Wiki screen's Review column and `flagged`/`unreviewed` filters derive a
  trust verdict from `@pass` records inside Reflect
  (`packages/core/src/wiki/entry-summary.ts:51`). That is a trust rule living
  on the wrong side, and the schema says passes never accumulate trust.
- External reloads (`setMarkdown`) were ordinary `docChanged` transactions, so
  `appendTransaction` could stamp `@pass: editor | status: pending` on claim
  text an agent changed on disk (`wiki-article-plugin.tsx:426`).
- The marker whitelist (`packages/core/src/wiki/anchors.ts:97`) was stricter
  than the schema; locator fields agents write landed in `unparsed`.
- Translations carry their own copies of every ledger, though the schema says
  shadows are outside the trust graph.
- Claim data is not projected; the CLI has no wiki commands.

Observed on the maintainer's wiki (161 entries, 638 claims): `trust.py` scores
all 591 scored claims at exactly the 0.1 floor, because its PageRank output
sums to 1 across about 600 nodes. Any normalization the harness adopts has to
stay meaningful as the wiki grows (see "Source reputation").

## Trust report

The harness publishes one report; Reflect reads nothing else for trust.
Reflect defines the format so any harness can plug in, atelier or another:
[`docs/wiki-trust-harness.md`](../wiki-trust-harness.md) is the whole
contract, with a generated JSON Schema and shared fixtures.

- **Location.** A file inside the graph at the path set in Settings → Wiki
  (default `.harness/wiki-trust.json`), so it syncs with the notes and mobile
  Reflect shows it without the harness. `reflect trust-report` prints the
  configured path for the harness.
- **Identity.** Claims keyed by graph-relative note path (compared in NFC) and
  claim id; sources keyed by the harness's origin key.
- **Freshness.** Each verdict carries the SHA-256 of the claim text it was
  computed for, with CRLF and CR read as LF. A mismatch shows the claim as
  changed since evaluation instead of an outdated verdict. Legacy heading
  claims carry no trust: their ledger sits inside their own range.
- **Verdicts.** Per claim: tier, overlays, reasons as display text with an
  optional `kind`, and what would raise the tier.
- **Sources.** Per origin: normalized weight, whether it clears the harness's
  threshold, and reasons.
- **Version.** `reflect-wiki-trust` version 1. Reflect refuses another version
  and says so; within version 1, one malformed entry drops alone and unknown
  keys are ignored, so optional fields (a rank, say) can be added later.

### Source reputation

Decided 2026-10-08: reputation is a continuous weight per source, normalized
across the whole wiki, and a source counts as trusted only above a threshold.
The harness computes all three. For Reflect the consequence is display only:
the trust card lists each source with its weight and threshold state, and a
source falling below the threshold changes the claims that cite it on the
harness's next report.

The floor collapse above is the cautionary case: a weight normalized to sum to
1 shrinks with the number of sources, so a fixed threshold would eventually
reject everything. The threshold has to live on a scale that does not drift
with corpus size (for example, rescaled to the maximum or by percentile).

## Reading experience

Settled from the canvas mockup "Claim trust reading demo", then iterated on
the real editor. Settings → Wiki → Claim trust picks one of three styles, or
Off:

- **Inline** (default). A small mark after each claim, after its citations:
  filled (Solid), ring (Supported), dashed (Needs work), dashed red
  (Disputed), dotted (changed since evaluation). Only prose that needs work
  is underlined, dotted; sound prose stays clean.
- **Margin.** The same marks in the right margin beside each paragraph, so the
  prose is untouched; hovering or focusing a mark lights up its claim.
- **On demand.** No marks while reading; holding Option, or the claim lens,
  tints every claim by tier.

In every style:

- **Trust card.** A mark opens the claim's card: tier, reasons, what would
  raise it, and the sources it rests on with their weights.
- **Question this claim.** Appends `@pass: reader | status: flagged | at:
  <today>` to the claim's ledger, creating the ledger when there is none. The
  harness decides what resolves it.
- **Footer.** The note footer says how many claims need work and steps through
  them; it stays silent when nothing needs attention.
- **Translations** show the source entry's verdicts, checked against the
  source's text.
- **Wiki screen** (next). A per-entry tier distribution in place of the
  pass-based Review column.

The first mockup put the tier on the citation group as a pill. In the editor a
click on a citation opens its source for editing, so the card needs its own
mark; the pill became the mark after the claim.

## Interfaces Reflect provides

- **Display** of the report on every wiki surface, with freshness.
- **Records** a person makes while reading or editing, in schema syntax:
  `editor | pending` for substantive edits made in the editor (never for host
  reloads), `reader | flagged` for a question.
- **`reflect trust-report`** prints where to publish the report.
- **The graph's agent skill** (Settings → Agents) teaches any coding agent the
  contract.

## Implementation

1. **Prerequisite fixes.**
   - Accept well-formed fields the schema does not name and its `weight`
     field; skip `#` comment lines in fences (#26).
   - Check every claim's formatting in one parse pair (#27): a 100-claim
     article went from about 700 ms to about 19 ms per index rebuild.
   - Skip host content transactions in `pendingEdits` (mhxie/meowdown#4, #29).
2. **Contract and reading UI** (one PR): the report reader, shared path
   rules and hash vectors, `reflect trust-report`, the agent skill section,
   Settings, the three reading styles, the trust card, the question action,
   and the footer. #30 (tier rules inside Reflect) closes; atelier owns its
   corpus.
3. **Wiki screen.** Per-entry tier distribution and filters from the report;
   retire the pass-based `wikiReviewState` and the legacy line scanner.

Translation-ledger removal in atelier waits for step 4.

## Observable completion criteria

- No module in Reflect computes a tier or a source weight.
- Editing a claim's text shows it as awaiting evaluation until the harness
  publishes a report for the new text.
- The editor, Wiki screen, translation copy, and CLI show the same verdict for
  the same claim from the same report.
- An agent edit on disk, reloaded into an open note, writes no `editor`
  pending record.
- A report Reflect cannot validate leaves every claim unmarked and says why.

## Open questions for atelier-wiki

- How often the report is written (nightly, on file change, or both).
- How a reader's question is resolved (a pass that names it, an adversarial
  pass, or any later pass).
- Whether claims in `index.md` notes are evaluated.
