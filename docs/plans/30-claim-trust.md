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

The harness publishes one report; Reflect reads nothing else for trust. The
report's format is atelier's to define. Reflect needs these properties from
it:

- **Location.** A file inside the graph (for example under the vault's
  `_meta/`, allowed through `.gitignore`) so it syncs with the notes and mobile
  Reflect can show it without the harness.
- **Identity.** Claims keyed by graph-relative note path and claim id; sources
  keyed by the origin key the harness uses.
- **Freshness.** For each claim, a hash of the claim text the harness
  evaluated (its UTF-8 `range_utf8` bytes) and the evaluation date. Reflect
  computes the same hash from the current text; a mismatch shows the claim as
  awaiting evaluation instead of showing an outdated verdict.
- **Verdicts.** Per claim: tier, overlays, optional score, and reasons. Each
  reason carries display text, plus an optional `kind` and data Reflect can
  style or localize. Reflect renders unknown kinds by their text, so the
  harness can add reasons without a Reflect release.
- **Ranking.** Per note (and optionally per claim) a rank Reflect uses only for
  ordering.
- **Sources.** Per origin: normalized weight, the threshold in force, whether
  it is trusted, and reasons with their evidence.
- **Version.** A format version; Reflect ignores a report it cannot validate
  and says so.

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

Settled from the canvas mockup "Claim trust reading demo".

- **Citation marks.** The compact citation group at the end of each claim
  takes the tier's shape: filled (Solid), outlined (Supported), dashed (Needs
  work), with the Disputed overlay in the warning tone. Shape carries the
  meaning; color reinforces it.
- **Needs-work prose** gets a faint dotted underline by default; disputed
  prose a wavy one. The claim toggle becomes a trust lens that tints every
  claim by tier and shows its `C` label.
- **Reasons on demand.** A claim's mark opens a card: tier, overlays, the
  report's reasons, sources with their weights, and what would raise the tier
  when the report says so.
- **Awaiting evaluation.** A claim whose text no longer matches the report's
  hash shows a neutral mark and "Changed since the last evaluation".
- **Question this claim.** Appends `@pass: reader | status: flagged | at:
  <today>` to the claim's ledger, the schema's record for a reader's doubt.
  The harness decides what the record does.
- **Article summary.** One line under the title with the report's tier counts
  and a command to jump to the next claim that needs work.
- **Translations** show the source claim's verdict, matched by relative path
  and claim id.
- **Wiki screen.** The Review column becomes a per-entry tier distribution
  bar; rows order by the report's rank or by share needing work; filters:
  Needs work, Disputed, Edited since review, Awaiting evaluation.

## Interfaces Reflect provides

- **Display** of the report on every wiki surface, with freshness.
- **Records** a person makes while reading or editing, written in schema
  syntax: `editor | pending` for substantive edits made in the editor (never
  for host reloads), `reader | flagged` for a question.
- **CLI reads** for the harness and agents:
  `reflect wiki claims <note> --json` (claim ranges, ledgers, citations, and
  the report's verdict with its freshness) and `reflect wiki stale --json`
  (claims whose text changed since the last evaluation), so the harness can
  pick up work without rescanning the vault.

## Implementation

1. **Prerequisite fixes.**
   - Accept well-formed fields the schema does not name and its `weight`
     field; skip `#` comment lines in fences (#26).
   - Check every claim's formatting in one parse pair (#27): a 100-claim
     article went from about 700 ms to about 19 ms per index rebuild.
   - Skip host content transactions in `pendingEdits` (mhxie/meowdown#4, #29).
2. **Report reader.** A Zod schema for the harness's report, a loader that
   watches the file, and the claim-text hash. #30 becomes this; its
   in-Reflect tier rules and `fixtures/wiki-claim-trust.json` leave Reflect
   (atelier owns the corpus).
3. **Projection.** Index tables for claims and citation edges from the notes,
   plus the report's verdicts and source weights, rebuilt from the graph like
   every other table.
4. **Reading UI** and the reader's question action. Retire the pass-based
   `wikiReviewState` and the legacy line scanner when the Review column goes.
5. **CLI** reads above.

Translation-ledger removal in atelier waits for step 4.

## Observable completion criteria

- No module in Reflect computes a tier, score, rank, or source weight.
- Editing a claim's text shows it as awaiting evaluation until the harness
  publishes a report for the new text.
- The editor, Wiki screen, translation copy, and CLI show the same verdict for
  the same claim from the same report.
- An agent edit on disk, reloaded into an open note, writes no `editor`
  pending record.
- A report Reflect cannot validate leaves every claim unmarked and says why.

## Open questions for atelier-wiki

- The report's format, file location, and how often it is written (nightly,
  on file change, or both).
- How a reader's question is resolved (a pass that names it, an adversarial
  pass, or any later pass).
- Whether claims in `index.md` notes are evaluated.
