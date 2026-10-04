# Back up to any git host (SSH)

GitHub gets the guided in-app flow (Settings → Backup → Connect GitHub…).
Every other git host — GitLab, Gitea, Codeberg, GitHub Enterprise, your own
server, a bare repo on a NAS — works with zero UI: wire the remote yourself
and Reflect's sync loop adopts it (Plan 16).

The contract: **if `ssh -T git@host` works in your terminal, sync works.**
Reflect authenticates SSH remotes through your ssh-agent — it never asks for,
stores, or manages credentials for non-GitHub hosts, and the managed GitHub
sign-in is never sent anywhere but github.com. HTTPS URLs for non-GitHub
hosts aren't supported yet (that's Plan 16 V2, via git credential helpers) —
use the SSH form.

## Recipe

```bash
cd /path/to/your/graph
git init -b main                                     # skip if it's already a repo
git remote add origin git@gitlab.com:you/notes.git   # any SSH remote
ssh -T git@gitlab.com   # confirms key auth works and records the host key
```

Then open (or refocus) the graph in Reflect. Settings → Backup shows the
remote, edits back up automatically a few moments after you stop typing, and
pulls/merges run on launch and focus — conflict handling included, same as
GitHub.

A bare repo on another disk needs no credentials at all:

```bash
git init --bare /Volumes/NAS/notes.git
cd /path/to/your/graph && git remote add origin /Volumes/NAS/notes.git
```

## Restore on another machine

```bash
git clone git@gitlab.com:you/notes.git ~/notes
```

…then open `~/notes` as a graph. The index rebuilds from the files, and the
remote is adopted automatically.

## Separate histories

Reflect never joins two histories on its own (this fork). Every history
starts from a root commit. A pull that would bring in commits starting from
a root the graph has not accepted pauses sync, whether it is a merge of two
unrelated histories or a fast-forward into another device's merge of one,
and a push that would upload a root the remote lacks is refused. A push
checks against the remote's branch as it stands when the push starts: if
that is not the branch Reflect last fetched, or this graph's branch does not
contain it, Reflect pulls first, so a separate history on the remote always
shows up as the pull's pause. Both stop before your notes, the branch, the
index, or the remote change (the fetch has already downloaded the other
history into `.git`). An expected root (say, from a device that started its
own graph and then joined this backup) is accepted by listing its full id
under the graph's root path in Reflect's settings file
(`~/Library/Application Support/reflect-open/settings.json`) and reopening
the graph:

```json
"acceptedHistoryRoots": { "/path/to/your/graph": ["<40-character commit id>"] }
```

Wiring a remote that already has history onto a graph that has some too
(Reflect keeps local history for every graph) is such a join: the first sync
pauses, naming the remote's root and the graph's own, until both are
listed. Once a device joins, every other device running this fork pauses on
that device's root at its next pull and needs the same entry in its own
settings file. A remote with no branch yet, a graph with no commits yet, and
a graph cloned from the remote all sync as before. The guard compares root
commits only: a rewrite that kept the original root commit is not a separate
history to it, so stop every device still on the old history before such a
rewrite.

## When it fails

Failures surface in Settings → Backup (and the sidebar dot) and retry on
focus — sync never wedges. The pauses below wait for you to act, but leave
your notes, the branch, and the index as they were.

- **"the SSH agent offered no key this host accepts"** — `ssh-add` your key,
  confirm `ssh -T git@<host>` works, refocus Reflect.
- **Unknown host key** — connect once with `ssh <host>` so it lands in
  `~/.ssh/known_hosts`. Reflect never bypasses host-key verification.
- **HTTPS remote** — refused at adoption with this same advice: switch it to
  the SSH URL, `git remote set-url origin git@host:owner/repo.git`.
- **"Sync paused: the backup brings in history that starts from a commit
  this graph has not accepted"** — another history reached the remote: a
  device that started its own graph, one still on a history you replaced, or
  a rewrite of the remote's history. If you expected it, accept the ids the
  message names (above). If the remote's history is the one to keep (you
  rewrote it on purpose), this graph is the stale one: re-clone it from the
  remote (move the old folder aside first and copy over any notes it has
  that the remote lacks). Otherwise restore the remote from a good copy.
  When this graph is that copy, run `git fetch` in it from a terminal, check
  the remote holds nothing you still need (`git log origin/<branch>`), then
  put this graph's history back with
  `git push --force-with-lease origin <branch>`, and make the device that
  pushed the other history start over from the restored remote, or it will
  push it again. A force push only moves the branch: the host can keep the
  other history's commits reachable by id (GitHub does until its support
  removes them).
- **"Sync paused: this graph's history starts from a commit the backup does
  not have"** — the same guard on the way out. Reflect gets here only once
  this graph's branch contains the remote's (otherwise it pulls first, and
  the pause above is what shows), so the extra root is in this graph's own
  history: a merge made with plain Git, a join for which only the other
  side's root was accepted, or a remote restored to a copy without a root
  this graph still holds. If you meant to join, accept it the same way; if
  not, re-clone this graph from the remote (move the old folder aside first
  and copy over any notes it has that the remote lacks).
- **"Sync paused: the backup has files inside the local-only folder …"** —
  the remote gained files inside a local-only folder this graph's history
  does not track. Removing them from the remote deletes that folder's copies
  on every other device that tracks it, the phone included, at its next
  sync; see
  [local-only folders](./privacy.md#local-only-folders-macos-off-by-default).

One more terminal-side fact: **"Stop backing up"** in Settings drops the
graph's `origin` (history stays). For a hand-wired remote the way back is the
same `git remote add origin …` you started with.

One caution that the GitHub flow handles for you but a hand-wired remote
can't: there is no host API to check repository visibility, so keeping the
backup private is your responsibility — **notes marked `private: true` are
included in the backup**.
