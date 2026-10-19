# Git backup safety invariants

The rules every change to the sync path must keep. "The sync path" is
`crates/git/src/`, the conflict ladder in `crates/graph-io/src/conflict/`,
the desktop commands in `apps/desktop/src-tauri/src/git.rs` and
`apps/desktop/src-tauri/src/git/`, `packages/core/src/sync/`, the backup
flusher in `packages/core/src/graph/persistence-flush-service.ts`, and the
external-change handling in
`packages/core/src/documents/note-session-service.ts`.

Each rule names the tests that enforce it.

## S1. A pull never overwrites uncommitted local changes

`git_pull` commits local changes and merges the remote under one graph lock,
and its checkout is safe, not forced, so a write from outside the lock fails
the pull and the next cycle commits it.

- Test: `git::tests::pull_all_holds_one_lock_for_commit_and_merge`,
  `git::tests::pull_all_commits_before_it_merges`,
  `git::tests::an_oversized_edit_survives_the_pull`,
  `git::tests::a_write_during_the_merge_survives_the_checkout`.

## S2. The branch ref moves only after the working tree matches it

A failure between the checkout and the ref move makes the next cycle retry
the pull instead of committing a stale tree.

- Test: `git::tests::fast_forward_checkout_failure_never_reverts_pulled_notes`,
  `git::tests::fast_forward_with_a_stale_head_lock_succeeds`,
  `git::tests::merge_crash_before_checkout_converges_next_cycle`,
  `git::tests::merge_crash_after_checkout_before_ref_move_converges_next_cycle`.

## S3. After any failed git command, the next cycle loses nothing

The next normal cycle converges on a tree with every local and remote
change, and never pushes a commit that reverts a pull.

- Test: `git::tests::fast_forward_failure_before_the_ref_moves_converges_next_cycle`,
  plus every S2 and S5 test.

## S4. One git command at a time per graph

Git commands, note writes, and iCloud sweep writes on one graph are
serialized. The quit-time and background flush go through the sync engine's
queue, never straight to `git_commit_all`.

- Test: `git::tests::commit_during_fast_forward_never_reverts_pulled_notes`,
  `backup-service.test.ts` "quit flush waits for an in-flight pull before
  committing", `engine.test.ts` "commitNow joins the single-flight queue
  and never touches the network".

## S5. The repository is never left in app-made merge state

A pull merges in memory and never calls `repo.merge()`. The app clears a
merge, rebase, or detached HEAD left by the git CLI, so sync never asks the
user to run git.

- Test: `git::tests::merge_interrupted_before_commit_converges_next_cycle`,
  `git::tests::merge_never_leaves_merge_head`,
  `git::tests::a_leftover_cli_merge_state_is_cleared_not_refused`,
  `git::tests::a_detached_head_is_reattached_to_the_backup_branch`.

## S6. `.reflect/` never enters a commit

`.gitignore`, an in-memory ignore rule, and dropping entries an adopted
repository already tracks keep the runtime directory out.

- Test: `git::tests::commit_excludes_reflect_and_skips_when_clean`,
  `git::tests::tracked_reflect_entries_are_dropped_from_the_next_commit`.

## S7. Merged content is committed and pushed, never left pending

An edit beats a delete. A `.md` note runs the conflict ladder
(`conflict::ladder`). Another file takes a clean three-way merge, or keeps
the local file and writes the remote version beside it as
`<stem> (conflict <UTC time> <hash8>).<ext>`. Both devices produce the same
bytes and names, so they converge. An older build still word-merges a
header-only conflict whose header holds a nested entry, such as the AI
summary block, and re-formats flat lines as `key: value`, so a hand-spaced
line such as `pinned:   true` can differ between builds for a round before
they converge.

Two devices' AI summaries of the same body (equal `aiSummary.hash`) settle
first: both sides keep the summary generated first, and the ladder merges
the settled pair. An entry without `generatedAt` predates the field and
comes first, then valid instants by time, then a stamp that isn't one; ties
fall to the entry lines. The choice reads only the two entries, so devices
converge on the same bytes once they all run a build with this rule; an
older build can still interleave two summaries.

- Test: `git::tests::conflicting_edits_merge_without_markers`,
  `git::tests::daily_append_on_two_devices_merges_by_union`,
  `git::tests::frontmatter_only_conflict_merges_keywise`,
  `git::tests::a_summarized_notes_header_conflict_merges_keywise`,
  `conflict::ladder::tests::summaries_and_header_edits_on_two_devices_merge_key_wise`,
  `conflict::ladder::tests::a_header_conflict_around_an_unchanged_summary_merges_key_wise`,
  `git::tests::both_devices_resolve_the_same_pair_to_the_same_bytes`,
  `git::tests::a_deletion_beside_an_append_is_reconciled_not_resurrected`,
  `git::tests::summaries_of_the_same_body_merge_to_the_first_generated`,
  `git::tests::this_devices_first_generated_summary_stays_put`,
  `git::tests::both_devices_settle_summaries_on_the_same_bytes`,
  `git::tests::a_summary_conflict_beside_a_body_conflict_settles_the_summary`,
  `conflict::ladder::tests::two_summaries_of_one_body_merge_to_the_first_generated`,
  `conflict::ladder::tests::other_changes_merge_around_the_first_generated_summary`,
  `conflict::ladder::tests::the_word_level_merge_keeps_the_first_generated_summary_whole`,
  `conflict::ai_summary::tests::a_stamp_that_is_not_an_instant_loses`,
  `conflict::ai_summary::tests::an_interleaved_stamp_loses_to_a_valid_one`,
  `conflict::ai_summary::tests::a_settle_that_would_break_the_frontmatter_is_skipped`,
  `git::tests::a_text_conflict_that_diff3_merges_takes_the_merge`,
  `git::tests::edit_vs_delete_keeps_the_edit`,
  `git::tests::a_json_conflict_keeps_both_copies`,
  `git::tests::binary_conflict_keeps_both_copies`,
  `git::tests::two_devices_name_the_same_copy`,
  `git::tests::a_conflict_copy_never_overwrites_an_existing_file`,
  `git::tests::a_directory_file_conflict_keeps_the_file_as_a_conflict_copy`,
  `git::tests::a_symlink_conflict_keeps_both_sides`,
  `backup-service.test.ts` "a hint lists every copy by its graph path".

## S8. Edits in an open note are never silently discarded

An external change to a dirty buffer saves it at once as a checked write,
which `note_write` merges with the disk text under the graph lock. A result
the editor cannot round-trip opens the note protected.

- Test: `graph::note_revision_tests::a_checked_write_against_a_moved_file_merges_under_the_lock`,
  `graph::note_revision_tests::stale_revision_does_not_replace_newer_text`;
  `note-session-service.test.ts` "a dirty buffer saves at once when an
  external change arrives", "an exact merge adopts the merged text and the
  session is clean", "a lossy merged result opens protected", "a merged title
  change is reported as external before saved", "keystrokes during a merging
  write stay dirty and merge on the next write", "dispose after flush still
  completes a merging write".

## S9. Merges never write conflict markers

No merge path (git pull, iCloud sweep, editor save) writes `<<<<<<<` lines.
Markers already in a file are plain text.

- Test: `git::tests::conflicting_edits_merge_without_markers`,
  `conflict::ladder::tests::overlapping_edits_reconcile_without_markers`,
  `note-session-service.test.ts` "a dirty buffer saves at once when an
  external change arrives".

## S10. A link into the external folder never enters a commit

A graph's external folder holds files at their graph paths, and a link at
such a path stands for the copy there. Its target is an absolute path that
means nothing on another device, so the size-guard callback refuses to add
or update a link whose target lies under any spelling the folder has had
(`ExternalLinks`: as configured, canonical, and earlier roots recorded in
`.reflect/external-storage.json`), matched lexically so it holds while the
folder is unmounted. A link an earlier commit took leaves the index, so the
next commit records its removal. A pull that brings a file to a linked path
parks the link instead of keeping it as `(this device)`: the folder keeps
its copy, and the incoming file takes the path.

- Test: `git::tests::external::links_into_external_storage_are_never_committed`,
  `git::tests::external::a_link_an_earlier_commit_took_leaves_the_next_one`,
  `git::tests::external::a_pull_writing_a_linked_path_parks_the_link`.
