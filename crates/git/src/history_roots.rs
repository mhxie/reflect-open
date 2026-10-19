//! The history roots a graph accepts: the starting (parentless) commits Git
//! sync may join.
//!
//! libgit2 merges two histories that share no commit like any other pair,
//! and a fast-forward can carry a separate history in under a merge another
//! device made. Either way removed notes and history come back (a device
//! still on a replaced history merges it back in). So sync never joins a
//! history root the graph has not accepted: a pull checks the commits it
//! would bring in (`merge::pull`) and pauses before any ref, index, or
//! working-tree change; a push checks the commits it would upload
//! (`remote::push`) and refuses before uploading anything. The push checks
//! against the last-fetched remote branch, so it first makes sure that is
//! the server's branch and that this one descends from it; otherwise it
//! pulls first, and the pull's pause is the one the user sees. Roots
//! already in the history on the other side are never checked again, an
//! unborn HEAD adopts the remote's history as before, and the first push (to
//! a branch the server does not have) goes out as before.
//!
//! The shell loads the list from the user settings document under
//! [`SETTINGS_KEY`], keyed by graph root, as full 40-character commit ids:
//!
//! ```json
//! "acceptedHistoryRoots": { "/Users/me/Notes": ["<40-character commit id>"] }
//! ```

use std::path::Path;

use git2::{Oid, Repository};

use reflect_types::{AppError, AppResult};

/// The settings-document key holding every graph's accepted history roots.
pub const SETTINGS_KEY: &str = "acceptedHistoryRoots";

/// The parentless commits reachable from `tip` but not from `known` that
/// `accepted` does not list. Everything `known` reaches is skipped, so a
/// root already in that history is never checked again.
fn unaccepted_roots(
    repo: &Repository,
    tip: Oid,
    known: Oid,
    accepted: &[Oid],
) -> AppResult<Vec<Oid>> {
    let mut walk = repo.revwalk()?;
    walk.push(tip)?;
    walk.hide(known)?;
    let mut roots = Vec::new();
    for oid in walk {
        let oid = oid?;
        if !accepted.contains(&oid) && repo.find_commit(oid)?.parent_count() == 0 {
            roots.push(oid);
        }
    }
    Ok(roots)
}

/// Refuse a pull of `remote` into `local` that would bring in a history
/// root the graph at `root` has not accepted. The pause also names this
/// graph's own unaccepted roots the remote lacks: joining the two uploads
/// them next, and one edit to the list then covers both.
pub(super) fn ensure_pull_accepted(
    repo: &Repository,
    root: &Path,
    local: Oid,
    remote: Oid,
    accepted: &[Oid],
) -> AppResult<()> {
    let incoming = unaccepted_roots(repo, remote, local, accepted)?;
    if incoming.is_empty() {
        return Ok(());
    }
    let outgoing = unaccepted_roots(repo, local, remote, accepted)?;
    let mut message = format!(
        "Sync paused: the backup brings in history that starts from {} this graph has not \
         accepted ({}). Reflect never joins a separate history on its own, because it can \
         bring back notes and history that were removed from the backup.",
        commits(incoming.len()),
        listed(&incoming)
    );
    if !outgoing.is_empty() {
        message.push_str(&format!(
            " Joining them would also upload this graph's own history, which starts from {} the \
             backup does not have ({}).",
            commits(outgoing.len()),
            listed(&outgoing)
        ));
    }
    message.push_str(&format!(
        " If you expected this (for example, another device started its own graph and then \
         joined the backup), {}. If not: when the backup's history is the one to keep (it was \
         rewritten on purpose, say), re-clone this graph from the backup; otherwise restore \
         the backup repository from a good copy.",
        accept_hint(root, incoming.len() + outgoing.len())
    ));
    Err(AppError::io(message))
}

/// Why a push of `local` must not go out: it would upload a history root
/// the remote branch at `known` lacks and the graph at `root` has not
/// accepted. `None` when the push may proceed. `remote::push` asks only
/// once `local` descends from `known`, so the root is in this graph's own
/// history (a merge made outside Reflect, a join that accepted only the
/// other side's root, a backup restored to a copy without it), and the
/// backup's history is the way out when the join was not meant.
pub(super) fn push_refusal(
    repo: &Repository,
    root: &Path,
    local: Oid,
    known: Oid,
    accepted: &[Oid],
) -> AppResult<Option<String>> {
    let outgoing = unaccepted_roots(repo, local, known, accepted)?;
    if outgoing.is_empty() {
        return Ok(None);
    }
    Ok(Some(format!(
        "Sync paused: this graph's history starts from {} the backup does not have ({}), so \
         nothing was uploaded. Reflect never uploads a separate history on its own. If you \
         meant to join the two, {}. If not, re-clone this graph from the backup.",
        commits(outgoing.len()),
        listed(&outgoing),
        accept_hint(root, outgoing.len())
    )))
}

fn commits(count: usize) -> &'static str {
    if count == 1 { "a commit" } else { "commits" }
}

fn listed(ids: &[Oid]) -> String {
    ids.iter()
        .map(Oid::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

/// How to accept roots: the list loads at graph open, so an edit takes
/// effect only once the graph opens again. The graph's key is spelled as a
/// JSON string, so a path holding a quote or a backslash copies over intact.
fn accept_hint(root: &Path, count: usize) -> String {
    let pronoun = if count == 1 { "it" } else { "them" };
    let key = serde_json::Value::String(root.to_string_lossy().into_owned());
    format!(
        "add {pronoun} to \"{SETTINGS_KEY}\" under {key} in Reflect's settings.json, then \
         reopen the graph"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pause names the graph's key as JSON, so pasting it into the
    /// settings file yields a key that parses and matches the folder.
    #[test]
    fn the_accept_hint_spells_the_graph_key_as_json() {
        let root = Path::new(r#"/vaults/a "quoted" \ vault"#);
        let hint = accept_hint(root, 2);
        let key = r#""/vaults/a \"quoted\" \\ vault""#;
        assert!(hint.contains(&format!("under {key} in")), "{hint}");
        assert_eq!(
            serde_json::from_str::<String>(key).unwrap(),
            root.to_string_lossy()
        );
    }
}
