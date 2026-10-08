# Plan 12 — Backup & Sync (Git, GitHub-first)

**Goal:** Continuous, invisible backup and multi-device continuity over **Git**, with
**GitHub as the only remote in the product UX**. Edits are debounced into commits and
pushed; pulls merge on launch/focus; merge conflicts are **committed into the note as
standard Git conflict markers** so sync never wedges. Plain product language — no Git
jargon in the UI.

**Depends on:** Plan 02 (graph, cloud-folder detection), Plan 04 (index + watcher
suppression; adds `sync_state`/`conflicts` tables), Plan 05 (external-change
reconciliation for open notes — load-bearing for conflicts), Plan 10 (keychain).
**Unlocks:** multi-device durability; AI-assisted conflict resolution (deferred).

**Architecture:** Git is a Rust primitive (`git2`/libgit2); sync orchestration, cadence,
GitHub specifics, and conflict policy live in `@reflect/core` (`actions/sync`). See
[Architecture & Conventions](architecture-conventions.md).

**Libraries:** `git2` (libgit2), `keyring` — Rust. (`diff`/jsdiff returns for the
deferred conflict-widget/AI path.) See [Libraries](libraries.md).

## Discovery decisions (2026-06)

Re-derived with research; **supersedes this plan's earlier backup-only scoping.**

1. **Engine: libgit2 via `git2`.** Rejected: **system git** (a fresh Mac has none —
   invoking it triggers the Xcode CLT install prompt; impossible on iOS; leaks the user's
   gitconfig/hooks into our sync), **bundled git** (~50 MB of GPLv2 binaries to
   sign/notarize; no iOS), **gitoxide** (no push support as of mid-2026),
   **isomorphic-git** (wrong layer per conventions; weak merge), and **GitHub's Git Data
   API with no local repo** (operationally simplest, but structural GitHub lock-in and no
   local history — losing the free checkpoint primitive). libgit2 is maintained (1.9.x;
   v2.0/SHA-256 upcoming — expect one breaking bump, isolated behind the Rust module).
2. **GitHub-only surface, generic core.** The Rust layer speaks `remote URL + credential
   callback` — nothing GitHub-specific. GitHub specifics (device flow, repo creation,
   error taxonomy) are isolated in `actions/sync/github.ts`. "Custom Git remote
   (advanced)" stays a future UX toggle, not an engineering project.
3. **Auth: GitHub App device flow.** Fine-grained, per-repo permission ("Reflect can
   touch one repo, nothing else"); 8-hour user tokens + 6-month refresh tokens; device
   flow needs **no client secret**, even for refresh — consistent with no Reflect-hosted
   APIs. Fallback: a manually created fine-grained PAT (also the GitHub Enterprise
   story). Tokens live in the OS keychain (Plan 10), supplied via libgit2's credential
   callback — **never embedded in the remote URL**, so never on disk.
4. **Conflicts are committed, not blocking** (the Jujutsu model: conflicts are data). A
   conflicted merge writes standard `<<<<<<<`/`=======`/`>>>>>>>` markers into the
   affected notes, then **commits the merge and pushes** — the repo is never wedged,
   other notes keep syncing, both devices converge on the same marked-up note.
   **Spike verdict (settled):** markers do **not** survive the editor's round-trip
   (`=======` re-parses as a setext underline; content is lost), so the round-trip
   guard (Plan 05b) opens conflicted notes **protected** — and resolution happens in
   the conflict notice as a raw-text splice (`resolveConflictMarkers`): keep this
   device's side, the other's, or both. Hand-merging stays possible in any external
   editor. Future: a meowdown conflict node unlocks in-editor resolution.
5. **Full loop in the first wave** — debounced commit→push *and* pull/merge, plus
   restore-from-GitHub in the graph chooser. Backup-only was rejected: a second device
   needs pull-before-push anyway, so deferral bought little.
6. **Disconnect is two different verbs.** "Stop backing up" is per-graph (drops the
   graph's `origin`; history and credential stay); "Sign out of GitHub" is machine-level
   (clears the keychain credential; every connected graph stops). Conflating them would
   make disconnecting one graph silently kill every other graph's backup.

## Product states

`Backed up` · `Backing up` · `Offline` (changes queued locally; retried on the browser
`online` event, window focus, and the next edit) · `Needs review` (conflict markers
present) · `Backup failed` (action needed). Git mechanics never surface.

## Sync loop

- **Commit cadence:** a watcher-settled edit marks the note dirty → commit all dirty
  files after ~30 s idle (cap: 5 min of continuous editing) → push. One commit per
  batch. Quit commits locally (never pushes — a network stall must not block exit);
  the next launch pushes. A debounced pass that finds nothing committed and nothing
  ahead ends **without touching the network** (a pull's own writes re-enter via the
  watcher and must not buy a push negotiation each time).
- **Pull cadence:** on launch, on window focus, on a periodic timer, and on a
  **non-fast-forward** push rejection: fetch → merge → push again (bounded retries).
  Auth, push-protection, and size failures surface immediately — only divergence retries.
- **Merge, not rebase.** Single branch; merge commits are fine — history is invisible
  product-wise, and rewriting published history breaks multi-device.
- **Checkpoints = commits.** Plan 10's "checkpoint before AI patch apply" becomes
  "commit dirty files first" — one recovery mechanism; any version recoverable from
  local or remote history.
- **Mobile (iOS target): foreground-only sync** first wave.

## Steps

1. **Rust git primitives** (`src-tauri/src/git/`): `git_status`, `git_setup` (init or
   adopt-existing + `origin` + align the local branch with the remote's default),
   `git_commit_all(message)` (stage everything, no-op when clean, large-file
   guardrail), `git_fetch`, `git_merge_remote` (fast-forward or merge; writes marker
   files with labeled sides, commits conflicts, reports changed files for reindexing),
   `git_push` (rejections returned as data). Health checks: refuse foreign states —
   detached HEAD, in-progress rebase — with a typed error, never guess. Remote-agnostic;
   credentials via callback from the keychain. `.reflect/` stays gitignored (Plan 02);
   the watcher only tracks `daily/` + `notes/`, so `.git/` is never watched.

2. **GitHub module** (`sync/github.ts` in core): device flow + silent token refresh,
   repo creation + metadata (visibility, default branch), `GET /user` identity, and an
   error taxonomy (auth, network, secret-scanning push protection, size) mapped to
   product states. zod at the boundary. **Repo-creation reality:** `POST /user/repos`
   works with classic PATs and OAuth tokens but **not fine-grained PATs** (and a
   fine-grained token can't be scoped to a repo that doesn't exist) — so the universal
   create path is the prefilled `github.com/new` handoff (`newRepoUrl`: name +
   `visibility=private` + description, one click on GitHub), with API creation as a
   silent accelerator where the token allows it.

3. **Sync engine + lifecycle** (`sync/engine.ts` in core; `lib/backup-controller.ts`
   in the app): the engine is the debounced state machine over the Rust primitives —
   abortable at every step boundary (`AbortSignal`), single-flight with a strongest-mode
   follow-up, every failure mapped to a product state (fail loud, never silent). The
   **backup controller** owns the per-graph lifecycle *outside React* — probe, engine,
   watcher subscription, focus/online listeners, quit-commit hook, connect/disconnect —
   with a single teardown path; the React provider is a `useSyncExternalStore` shim.
   (Every early review finding hit the React-effect/engine seam; this is the structural
   fix.) Conflict state is a projection: the indexer detects markers and flags
   `notes.has_conflict`, so `Needs review` survives rebuilds and clears itself.

4. **Conflict policy** (the load-bearing step):
   - **Content conflicts** → marker blocks with readable labels (`<<<<<<< this device` /
     `>>>>>>> other device`); merge committed + pushed; note flagged `Needs review`;
     the flag clears when a reindex no longer sees markers.
   - **Resolution UX (spike-settled):** markers are lossy in the editor, so conflicted
     notes open **protected** (raw source visible, never editable — the editor can't
     destroy the markers). The conflict notice resolves on the raw text:
     keep this device's side / the other's / both (`resolveConflictMarkers`, pure and
     unit-tested; "both" is the daily-note append case). Every version stays
     recoverable in history.
   - **Edit vs delete** → keep the edited version (never silently delete); record it.
   - **Binary/asset conflicts** → keep both (suffix the incoming copy); newest wins links.
   - Merges return their **changed files** (with real mtimes); the controller reindexes
     them directly and fans them to open editors via the local file-changes channel —
     pull-applied writes never depend on the watcher being up (the launch pull races
     watch start). A pull rewriting an **open** note goes through Plan 05's
     external-change reconciliation (clean buffer reloads; dirty buffer prompts).
   - **Daily notes are the common collision** (two devices, same day). Markers +
     keep-both cover it first wave; future: a custom merge driver (libgit2 registers
     them in code) for append-friendly merging of `daily/*.md`. *(That future work
     shipped via [Plan 21](./21-icloud-drive-sync.md) as the resolution ladder's
     append-union rung — on the iCloud path, not as a libgit2 merge driver.)*

5. **Guardrails:**
   - Default to **creating a private repo**; choosing a public repo blocks on an explicit
     confirmation (all notes — including `private: true` ones — would be public;
     `private:` blocks AI/cloud-processing, **not** backup).
   - Pre-flight file sizes at commit: warn ≥ 50 MB, exclude ≥ 95 MB with a warning —
     GitHub rejects files > 100 MB and the **whole push** fails. Git LFS deferred.
   - GitHub push protection can reject a push because a note contains a credential —
     surface as "a note contains something GitHub blocks", with the path when derivable.
   - Graph is already a Git repo → offer to adopt it (and its remote); never nest.
   - Onboarding states plainly: backup history is permanent (deleted notes remain in
     history); cloud-sync-folder graphs still warn (Plan 02).
   - **Separate histories pause (this fork's divergence).** libgit2 merges two histories
     that share no commit against an empty base, and a fast-forward can carry one in
     under another device's merge; either brings back history removed on purpose (a
     device still on a replaced history merges it back in). Before any ref, index, or
     working-tree change, `git_merge_remote` walks the incoming commits (remote, hiding
     HEAD) and pauses with a `Sync paused:` IO error naming every root (parentless)
     commit the graph has not accepted, plus the graph's own unaccepted roots the remote
     lacks, since joining uploads them next. The fetch before it has already downloaded
     those commits into `.git`; the pause only keeps them out of the branch, the index,
     and the notes. `git_push` checks against the last-fetched remote branch. A local
     branch that does not descend from it (diverged, or a separate history) is
     non-fast-forward before any network, so the engine fetches and merges, and a
     separate history on the remote surfaces as the merge's pause, never as a push
     refusal. Otherwise it walks the outgoing commits (HEAD, hiding that branch) and
     refuses an unaccepted root as data (`pushed: false`, not non-fast-forward: the
     engine shows `rejected`, no retry loop); that root is in this graph's own history.
     A push that passes stops at libgit2's push negotiation, as non-fast-forward and
     before anything is uploaded, when the server's branch is not the last-fetched one
     (another device pushed, or the backup was restored to an older commit): libgit2
     packs against the live branch, so a stale ref could hide a root the server no
     longer has. Accepted roots are the Rust-owned per-graph settings key
     `acceptedHistoryRoots: { "<graph root>": ["<40-hex id>", …] }`, loaded at graph
     open into `GraphState` like `backupMaxFileMiB`: malformed ids are dropped with a
     warning shown at open, and an edit applies when the graph next opens.
     Roots the other side already reaches are never rechecked; an unborn HEAD and a first
     push (to a branch the server does not have) keep the old path. Connecting a graph
     that already has history (local history included) to an existing backup is such a
     join and pauses until both roots are listed, and every other device on this fork
     pauses on a joining device's root until its own list has it. Recovery: accept the
     roots and reopen the graph, or re-clone the stale device when the backup's history
     is the one to keep / restore the remote from a good copy when it is not
     ([generic remotes](../generic-git-remotes.md#when-it-fails)). The guard compares
     roots only: a rewrite that keeps the original root commit is not a separate
     history to it, so devices still on the old history must stop before such a rewrite.
   - **New local-only folders pause too.** Commits never add, update, or delete a
     local-only entry, so a unit a pull follows into the index stays in every later
     commit. With local-only folders configured, a pull that would follow a frozen unit
     HEAD does not track (a fast-forward: any changed unit; a diverged merge: the units
     the remote changed since the base) pauses before anything is written; units HEAD
     already tracks keep following the remote. Nothing is deleted automatically: the way
     out is `git rm -r --cached <folder>` in a separate clone, then commit and push. That
     deletes the folder's copies on every other device that tracks it (the phone
     included) at its next sync, history keeping them, so those devices copy what they
     need first and stop editing the folder, or their next edit brings it back and the
     pause returns ([privacy](../privacy.md#local-only-folders-macos-off-by-default)).

6. **Index coordination** (Plan 04): merges/pulls register written paths in the
   suppression set and reindex after writes settle; our own commits must not re-mark
   notes dirty (no commit loops).

7. **Auth + connect UX:** a wizard ordered around how GitHub tokens actually work —
   **repository first** (creating it needs no credential: the prefilled `github.com/new`
   handoff), then the token (instructions name that exact repository; fine-grained PATs
   can now be scoped to it because it exists), then the connection. Every sign-in path
   ends in a `GET /user` round-trip, so a mistyped token fails at entry ("GitHub
   rejected the token") and the wizard knows the owner — `owner/name` is never typed.
   Device flow when the app is registered ("enter this code on github.com"), silent
   8-hour refresh; a lapsed refresh token → `Backup failed — reconnect`.

8. **Restore / second device:** "Connect existing backup" = clone → open as graph →
   full index rebuild (Plan 04). Repair of last resort for a corrupt local repo:
   re-clone from the remote (the remote *is* the backup).

9. **Tests:** round-trip backup to a local bare repo; two-clone divergence produces a
   committed marker merge both sides converge on; non-fast-forward push retries;
   edit/delete + binary policies; marker removal clears `Needs review`; size guardrail;
   public-repo confirmation; echo suppression (a pull doesn't storm the indexer; commits
   don't re-dirty); `.reflect/` excluded; token never appears in the remote URL or
   `.git/config` (asserted). (Stale-`index.lock` recovery is deferred, below.)

## Key decisions / contracts

- **Safety invariants** (2026-10): [`docs/git-backup-safety.md`](../git-backup-safety.md)
  lists the rules S1 to S8 that every sync change must keep, each with the
  test that enforces it.
- **libgit2 (`git2`) is the engine**; the Rust surface is remote-agnostic, GitHub
  specifics live only in `actions/sync/github.ts`.
- **GitHub is the only supported remote in the UX**; file-sync providers (iCloud/
  Dropbox/Drive) remain unsupported by design (no safe conflict semantics).
- **GitHub App device flow + keychain; PAT fallback; token never on disk.**
- **Conflicts are committed as raw Git markers and sync continues** — no wedged states.
  Markers are lossy in the editor (spike-verified), so conflicted notes open protected
  and resolve through the conflict notice's raw-text splice (mine/theirs/both).
- **A separate history never joins on its own** (this fork): an unaccepted root commit,
  incoming or outgoing, pauses sync until the user accepts it in `acceptedHistoryRoots`
  or repairs the remote, and so does a pull that would start tracking a local-only
  folder. Each pause happens before the notes, the branch, the index, or the merge state
  change, so it never leaves the repository mid-operation.
- **Disconnect is per-graph; sign-out is per-machine** — never conflated.
- **Checkpoint = commit** (shared recovery primitive with Plan 10); quit commits
  locally, never pushes.
- **Sync lifecycle lives outside React** (the backup controller, one teardown path);
  the engine is abortable at every step boundary.
- **Git mechanics never surface** — only the product states.

## Acceptance criteria

- Editing a note passes through `Backing up` → `Backed up` within the debounce window;
  the commit is visible on GitHub.
- Two devices editing the same note converge on one note containing labeled conflict
  markers; both show `Needs review` and open protected with mine/theirs/both resolution;
  resolving on either device clears it everywhere.
- A conflict never blocks other notes from backing up.
- Going offline shows `Offline`; reconnecting (the `online` event, focus, or the next
  edit) pushes without user action.
- "Restore from GitHub" in the graph chooser reproduces the graph on a fresh machine;
  the index rebuilds; a non-empty destination is refused.
- Public-repo selection requires explicit confirmation; an oversized file warns/excludes
  without failing the rest of the backup.
- `pnpm typecheck` + targeted tests pass.

## Deferred

- meowdown conflict widget (parse marker blocks → keep-mine/keep-theirs UI).
- AI-assisted resolution via the Plan 10 copilot (markers parse to base/ours/theirs;
  `private: true` notes never go to cloud AI).
- Custom merge driver for daily notes; Git LFS / asset offload; background sync on
  mobile; "purge history" escape hatch; stale-`index.lock` recovery on startup.
- ~~Generic-remote UX toggle~~ → became [Plan 16](16-generic-git-remotes.md): any git
  host via a hand-wired `origin`, no UI (V1 ships SSH-agent auth + path remotes).

## Risks

- ~~meowdown mangling markers~~ **Settled by the spike:** markers are lossy, the
  round-trip guard (Plan 05b) protects them, and a regression test pins the
  classification — if meowdown ever learns to round-trip markers, that test failing is
  the signal to build the in-editor widget.
- **Markers confuse non-developers.** Mitigate with the `Needs review` state, the
  protected view's plain-language notice, and one-click mine/theirs/both resolution.
- **libgit2 v2.0 breaking bump** — absorbed behind the Rust module.
- **Auth feeling developer-oriented.** Device flow mitigates; PAT is the escape hatch.
- **History privacy** (deleted notes persist on GitHub) — onboarding honesty now;
  "purge history" later.
- **Watcher/sync write loops.** Suppression set + the no-re-dirty contract, both tested.
