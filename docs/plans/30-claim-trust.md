# 30: Claim-level trust

Status: steps 1–2 implemented (PRs #26, #27, #29, #31); step 3 proposed.
Baseline: `b914fd4a`.

## Product goal

While reading a wiki article, a person can tell at a glance which claims are
solid and which still need work, and why. The editor, translations, and
later the Wiki screen show the verdicts of the report the harness writes, so
agents and people act on one signal.

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
| Writes the trust report | Validates and projects the report; tells the harness where to write it |
| Conformance fixtures for its rules | Fixtures for parsing and report reading only |

## Baseline behavior

- Claim ranges render with no trust signal. They are hidden until the claim
  toggle shows `C1` labels; evidence is folded at the end of the article
  (`apps/desktop/src/editor/wiki-anchors/wiki-article-plugin.tsx`).
- The Wiki screen's Review column and `flagged`/`unreviewed` filters derive a
  trust verdict from `@pass` records inside Reflect
  (`packages/core/src/wiki/entry-summary.ts:51`). That is a trust rule living
  on the wrong side, and the schema says passes never accumulate trust.
- External reloads (`setMarkdown`) are ordinary `docChanged` transactions, so
  `appendTransaction` can stamp `@pass: editor | status: pending` on claim
  text an agent changed on disk (`wiki-article-plugin.tsx:426`).
- The marker whitelist (`packages/core/src/wiki/anchors.ts:97`) is stricter
  than the schema; locator fields agents write land in `unparsed`.
- Translations carry their own copies of every ledger, though the schema says
  shadows are outside the trust graph.
- Claim data is not projected; the CLI has no wiki commands.

Observed on the maintainer's wiki (161 entries, 638 claims): `trust.py` scores
all 591 scored claims at exactly the 0.1 floor, because its PageRank output
sums to 1 across about 600 nodes. Any normalization the harness adopts has to
stay meaningful as the wiki grows (see "Source reputation").

## Trust report

The harness publishes one report; Reflect reads nothing else for trust.
Reflect defines the format so any harness can plug in, atelier or another.
[`docs/wiki-trust-harness.md`](../wiki-trust-harness.md) is the contract, with
a generated JSON Schema and shared fixtures; this plan keeps only the
decisions behind it:

- **The report lives in the graph** (default `.harness/wiki-trust.json`), so
  it syncs with the notes and mobile Reflect shows it without the harness.
  The path setting is per device: a custom path must be set on each device.
  `reflect trust-report` prints this device's path for the harness.
- **Freshness comes from the saved file.** Each verdict carries a hash of the
  claim text it judged; Reflect hashes the file as the harness reads it,
  never its own re-serialization, and shows a mismatch as changed since
  evaluation rather than an outdated verdict.
- **A bad report never blanks the screen.** Reflect keeps the last valid
  report and Settings says why; within version 1, one malformed entry drops
  alone and unknown keys are ignored, so the harness can add fields.

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

- **Inline** (default). A small mark after each claim that needs a look,
  after its citations: dashed (Needs work), dashed red (Disputed), dotted
  (changed since evaluation, or not yet evaluated). Prose that needs work or
  is disputed is underlined.
  Supported (ring) and Solid (filled) claims stay unmarked.
- **Margin.** Marks in the right margin beside the line each claim ends on,
  so the prose is untouched; Solid claims stay unmarked.
- **On demand.** No marks while reading.

In every style:

- **Reveal.** Holding Option, or the claim lens, tints every claim by tier and
  shows every mark, so unmarked claims can be opened too.

- **Trust card.** A mark opens the claim's card: the claim it judges, tier,
  reasons, what would raise it, and the sources it rests on with their
  weights against the harness's threshold.
- **Question this claim.** Appends `@pass: reader | status: flagged | at:
  <today>` to the claim's ledger, creating the ledger when there is none, at
  most once a day per claim and only where the note is editable. The harness
  decides what resolves it.
- **Footer.** The note footer says how many claims need work and steps through
  them; when none do, it says how many are not yet evaluated, and otherwise
  stays silent.
- **Translations** show the source entry's verdicts, checked against the
  source's text.
- **Wiki screen** (next). A per-entry tier distribution in place of the
  pass-based Review column.

The first mockup put the tier on the citation group as a pill. In the editor a
click on a citation opens its source for editing, so the card needs its own
mark; the pill became the mark after the claim.

## Interfaces Reflect provides

- **Display** of the report in articles and translations, with freshness;
  the Wiki screen follows in step 3.
- **Records** a person makes while reading or editing, in schema syntax:
  `editor | pending` for substantive edits made in the editor (never for host
  reloads), `reader | flagged` for a question.
- **`reflect trust-report`** prints where to publish the report and, with
  `--json`, which local-only folders' notes to leave out of it.
- **The graph's agent skill** (Settings → Agents) teaches any coding agent the
  contract.

## Implementation

1. **Prerequisite fixes.**
   - Judge ledger fields by the trust engine's rules; skip `#` comment lines
     in fences (PR #26).
   - Make the claim formatting check cheap enough for every keystroke (PR #27).
   - Skip host content transactions in `pendingEdits` (mhxie/meowdown#4,
     PR #29).
2. **Contract and reading UI** (one PR): the report reader, shared path
   rules and hash vectors, `reflect trust-report`, the agent skill section,
   Settings, the three reading styles, the trust card, the question action,
   and the footer (PR #31). PR #30, which computed tiers inside Reflect, was
   closed unmerged; atelier owns its corpus.
3. **Wiki screen.** Per-entry tier distribution and filters from the report;
   retire the pass-based `wikiReviewState` and the legacy line scanner.

Removing translation ledgers is atelier's work; see the open questions.

## Observable completion criteria

- No module in Reflect computes a tier or a source weight.
- Editing a claim's text shows it as awaiting evaluation until the harness
  publishes a report for the new text.
- The editor and the translation copy, and after step 3 the Wiki screen, show
  the same verdict for the same claim from the same report.
- An agent edit on disk, reloaded into an open note, writes no `editor`
  pending record.
- A report Reflect cannot validate never replaces the last valid one, and
  Settings says why; with no valid report, claims are unmarked.

## Open questions for atelier-wiki

- How often the report is written (nightly, on file change, or both).
- How a reader's question is resolved (a pass that names it, an adversarial
  pass, or any later pass).
- Whether claims in `index.md` notes are evaluated.
- When translation copies drop their own ledgers, now that translations read
  the source entry's verdicts.
