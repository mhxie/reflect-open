# 30: Claim-level trust

Status: proposed on `docs/claim-trust-plan`. Baseline: `b914fd4a`.

## Product goal

While reading a wiki article, a person can tell at a glance which claims are
solid and which still need work, and why. The same verdict appears in the
editor, the Wiki screen, translations, and the `reflect` CLI, so agents and
people act on one signal.

## Ownership

The wiki format and its trust semantics belong to atelier-wiki
(`atelier/protocols/wiki-schema.md`), which defines how agents write and
maintain the wiki. Reflect reads, renders, and edits that format; it does not
define trust rules of its own. Both sides implement the tier rules below and
prove agreement with shared conformance fixtures (see "Contract").

| atelier-wiki | Reflect |
|---|---|
| Schema, marker vocabulary, tier rules | Rendering and editor affordances |
| `trust.py` scores and tiers; `/lint` | SQLite projection of claims, sources, citation edges |
| Shadow (translation) generation | Translation copies read the source claim's tier |
| Conformance fixtures (owner) | Runs the fixtures in CI |

## Baseline behavior

- Claim ranges render with no trust signal. They are hidden until the claim
  toggle shows `C1` labels; evidence is folded at the end of the article
  (`apps/desktop/src/editor/wiki-anchors/wiki-article-plugin.tsx`).
- The Wiki screen's Review column and `flagged`/`unreviewed` filters treat
  `@pass` verdicts as trust (`packages/core/src/wiki/entry-summary.ts:51`).
  The schema says passes never accumulate trust; only `@anchor` records seed
  it.
- The editor labels a ledger "review pending" from `editor` passes
  (`wiki-article-pending.ts`). That label is correct under the schema, but no
  other surface shows it.
- External reloads (`setMarkdown`) are ordinary `docChanged` transactions, so
  `appendTransaction` can stamp `@pass: editor | status: pending` on claim
  text an agent changed on disk (`wiki-article-plugin.tsx:426`). The schema
  reserves that record for substantive edits made in the editor.
- The marker whitelist (`packages/core/src/wiki/anchors.ts:97`) is stricter
  than the schema and omits its `weight` field. Locator fields agents already
  write (`title`, `section`, `chapter`) land in `unparsed`, which disables
  compact citations for those articles (`source-links.ts:19`).
- Translations carry their own copies of every ledger, though the schema says
  shadows are outside the trust graph. Copies drift from the source.
- Claim data is not projected; `listWikiEntries` reads every file on a cold
  start, and the CLI has no wiki commands.

Observed on the maintainer's wiki (161 entries, 638 claims): every claim has a
current `reviewer: verified` pass, so pass-based status shows nothing, and
`trust.py` scores all 591 scored claims at exactly the 0.1 floor. Evidence
strength does vary: 6 claims have no current source, 305 one, 169 two, and
158 three or more.

## Tier rules

These rules are the proposed schema v2 contract; atelier-wiki owns the final
text. Every tier carries the reasons that produced it, shown verbatim in the
UI.

Inputs for one claim, as of a day: its current `@anchor` records, the current
claim-level citations inside its range, and its current `@pass` records.

- **Origin.** Anchors are deduplicated into independent origins: a paper or
  book by its identifier (an arXiv or DOI link names its paper), a code host
  (GitHub, GitLab, gists) by author, and any other page by host, so two pages
  of one documentation site are one origin.
- **Kind.** An anchor's `kind: primary|secondary` comes from the writer, which
  alone knows whether a source fits the claim (official documentation and
  source code are primary for system behavior). Without `kind`, `s2`, `arxiv`,
  `doi`, and `isbn` read as primary; everything else reads as secondary.
- **Adversarial review.** A current `verified` pass from `challenger` or
  `scout` that is newer than the claim's last `editor` pending record (same-day
  ties use file order).

Tiers, strongest first:

1. **Solid**: at least two independent origins, at least one primary, and an
   adversarial review. Review is a gate, never a substitute: no number of
   passes makes a claim solid without the evidence.
2. **Supported**: at least one primary origin, or two independent secondary
   origins, or a citation to a claim that is supported or solid. Citations
   lend at most Supported; a claim is solid only by its own evidence.
3. **Needs work**: anything else, including no current source, a single
   secondary source, and only invalidated evidence.

Overlays, orthogonal to the tier:

- **Disputed**: the latest current pass of any agent is `flagged` or
  `inconclusive`. Caps the tier at Needs work.
- **Edited since review**: the latest editor/reviewer record is
  `editor | pending`. Shown as a marker; it does not change the tier, except
  that it voids the adversarial gate for Solid.

Citation support resolves over strongly connected components: within a
citation cycle, members lend each other nothing. Note-level views show the
tier distribution, never a mean.

PageRank stays in atelier for ranking and search, with scale-invariant
normalization; no reading surface displays it.

## Reading experience

- **Citation marks.** The compact citation group at the end of each claim
  takes the tier's shape: filled (Solid), outlined (Supported), dashed (Needs
  work), with the Disputed overlay in the warning tone. Shape carries the
  meaning; color reinforces it. No new surface competes with the editor.
- **Needs-work prose** gets a faint dotted underline by default. The existing
  claim toggle becomes a trust lens that tints every claim by tier and shows
  its `C` label.
- **Reasons on demand.** Hovering or focusing a claim's mark opens a popover:
  tier, reasons ("2 independent sources, 1 primary; challenger verified
  2026-10-06; edited since review"), sources, and pass history.
- **Article summary.** One line under the title, "10 claims: 3 solid ·
  5 supported · 2 need work", with commands to jump to the next and previous
  claim that needs work (registered in the command palette, bound to keys).
- **Translations** show the source claim's tier and reasons, matched by
  relative path and claim id. Their own ledgers, if any, are ignored.
- **Wiki screen.** The Review column becomes a per-entry tier distribution
  bar, sortable by share needing work. Filters: Needs work, Disputed, Edited
  since review, replacing Flagged and Unreviewed.

The visual treatment is settled with a mockup before implementation.

## Contract

- `wiki-schema.md` is the specification; this repo links to it rather than
  restating it.
- Conformance fixtures are language-neutral JSON: Markdown or ledger inputs
  with expected claims, diagnostics, and tiers. The tier corpus starts as
  `fixtures/wiki-claim-trust.json` (#30); ownership moves to atelier-wiki once
  its trust engine runs it, after which Reflect syncs it with the source
  commit recorded.
- Unknown fields on a known marker are retained and shown, never treated as
  malformed. Unknown records still fail visibly, per the schema.

## Implementation

1. **Prerequisite fixes** (independent PRs):
   - Accept well-formed fields the schema does not name and its `weight`
     field, and skip `#` comment lines in fences, as the trust engine does
     (#26).
   - Check every claim's formatting in one parse pair, falling back to
     per-claim checks only on failure (#27): a 100-claim article went from
     about 700 ms to about 19 ms per index rebuild. The wiki bridges stay
     mounted for every note, because ordinary notes may also hold claim
     ranges.
   - Mark external content transactions and skip them in `pendingEdits`
     (mhxie/meowdown#4 tags host replacements; #29 vendors it and skips them).
2. **Core.** `packages/core/src/wiki/trust.ts`: a pure `wikiClaimTrust` over
   one claim's evidence plus resolved citation tiers, returning tier, overlays,
   and reasons, specified by `fixtures/wiki-claim-trust.json` (#30). Retire
   the legacy line scanner in `entry-summary.ts` and the pass-based
   `wikiReviewState` when step 4 replaces the Review column.
3. **Projection.** Index migration in `crates/index-schema`: `wiki_claims`
   (note, claim id, tier, overlays, origin counts, reasons) and
   `wiki_claim_citations` (source note and claim, target note and claim, date
   window). The indexer resolves citation tiers after each batch. The Wiki
   screen reads the projection instead of reading every file.
4. **Reading UI** as described above, behind the existing wiki article
   extension.
5. **CLI.** `reflect wiki claims [--tier …] [--overlay …] --json` and
   `reflect wiki check <note>`, reading the projection. Like other CLI reads,
   results can trail unsaved edits.

Translation-ledger removal in atelier waits for step 4, so translations never
lose their evidence display.

## Observable completion criteria

- Every vendored conformance fixture passes in Reflect and in atelier.
- On the maintainer's wiki, tiers are not uniform, and each tier's reasons
  match its ledger when inspected by hand for a sample of claims.
- An agent edit on disk, reloaded into an open note, writes no `editor`
  pending record.
- A 100-claim article keeps wiki work per keystroke under 25 ms, growing
  linearly with note size.
- The editor, Wiki screen, translation copy, and CLI report the same tier for
  the same claim.

## Open questions for atelier-wiki

- Are claims in `index.md` notes scored? `trust.py` skips them today; the Wiki
  screen counts them.
- Do `section` and `chapter` migrate into one `locator` field?
- Which agents count as adversarial beyond `challenger` and `scout`?
