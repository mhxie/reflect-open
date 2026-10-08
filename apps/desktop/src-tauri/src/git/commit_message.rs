//! Derive concise backup commit subjects from staged graph note metadata.

use std::path::Path;

use git2::{Commit, Delta, DiffOptions, Repository, Tree};
use reflect_frontmatter::{backup_privacy, parse_frontmatter, split_frontmatter};
use reflect_graph_paths::to_slash_lossy;

use crate::error::AppResult;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ChangeAction {
    Add,
    Update,
    Delete,
    Rename,
}

#[derive(Debug, Eq, PartialEq)]
struct TreeChange {
    action: ChangeAction,
    path: String,
    old_path: Option<String>,
}

#[derive(Debug, Eq, PartialEq)]
struct NoteChange {
    action: ChangeAction,
    label: NoteLabel,
    old_label: Option<NoteLabel>,
}

/// How a note is named in a commit subject. A note whose frontmatter isn't
/// public (locked, or unreadable and so treated as locked) is never named.
#[derive(Debug, Eq, PartialEq)]
enum NoteLabel {
    Named(String),
    Private,
}

impl NoteLabel {
    fn text(&self) -> &str {
        match self {
            NoteLabel::Named(label) => label,
            NoteLabel::Private => "private note",
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
enum AuthoredNoteTitle {
    Public(String),
    Private,
}

/// Return a staged-tree-derived commit subject, falling back when the staged
/// tree is metadata-only or otherwise too noisy to summarize clearly.
pub(super) fn message_for_commit(
    repo: &Repository,
    parent: Option<&Commit<'_>>,
    tree: &Tree<'_>,
    fallback: &str,
) -> AppResult<String> {
    let changes = tree_changes(repo, parent, tree)?;
    Ok(describe_changes(repo, parent, tree, &changes).unwrap_or_else(|| fallback.to_string()))
}

fn tree_changes(
    repo: &Repository,
    parent: Option<&Commit<'_>>,
    tree: &Tree<'_>,
) -> AppResult<Vec<TreeChange>> {
    let parent_tree = match parent {
        Some(parent) => Some(parent.tree()?),
        None => None,
    };
    let mut options = DiffOptions::new();
    let mut diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(tree), Some(&mut options))?;
    diff.find_similar(None)?;

    let mut changes = Vec::new();
    diff.foreach(
        &mut |delta, _progress| {
            if let Some(change) = tree_change_from_delta(delta.status(), &delta) {
                changes.push(change);
            }
            true
        },
        None,
        None,
        None,
    )?;
    Ok(changes)
}

fn tree_change_from_delta(status: Delta, delta: &git2::DiffDelta<'_>) -> Option<TreeChange> {
    let action = match status {
        Delta::Added | Delta::Copied => ChangeAction::Add,
        Delta::Deleted => ChangeAction::Delete,
        Delta::Renamed => ChangeAction::Rename,
        Delta::Modified | Delta::Typechange => ChangeAction::Update,
        _ => return None,
    };
    let path = match action {
        ChangeAction::Delete => diff_path(delta.old_file().path())?,
        _ => diff_path(delta.new_file().path())?,
    };
    let old_path = (action == ChangeAction::Rename)
        .then(|| diff_path(delta.old_file().path()))
        .flatten();
    Some(TreeChange {
        action,
        path,
        old_path,
    })
}

fn diff_path(path: Option<&Path>) -> Option<String> {
    path.map(to_slash_lossy)
}

fn describe_changes(
    repo: &Repository,
    parent: Option<&Commit<'_>>,
    tree: &Tree<'_>,
    changes: &[TreeChange],
) -> Option<String> {
    let content_changes: Vec<&TreeChange> = changes
        .iter()
        .filter(|change| !is_backup_metadata_path(&change.path))
        .collect();
    if content_changes.is_empty() {
        return None;
    }

    let note_changes: Vec<NoteChange> = content_changes
        .iter()
        .filter_map(|change| note_change(repo, parent, tree, change))
        .collect();
    let attachment_changes: Vec<&TreeChange> = content_changes
        .iter()
        .copied()
        .filter(|change| is_attachment_path(&change.path))
        .collect();
    let other_count = content_changes.len() - note_changes.len() - attachment_changes.len();

    if note_changes.len() == content_changes.len() {
        return describe_note_changes(&note_changes);
    }
    if attachment_changes.len() == content_changes.len() {
        return describe_group(&attachment_changes, "attachment", "attachments");
    }
    if !note_changes.is_empty() && other_count == 0 {
        let action = group_action(content_changes.iter().map(|change| change.action));
        return Some(limit_subject(format!(
            "{} {} and {}",
            action.verb(),
            count_phrase(note_changes.len(), "note", "notes"),
            count_phrase(attachment_changes.len(), "attachment", "attachments")
        )));
    }
    if !note_changes.is_empty() {
        let action = group_action(content_changes.iter().map(|change| change.action));
        return Some(limit_subject(format!(
            "{} {} and {}",
            action.verb(),
            count_phrase(note_changes.len(), "note", "notes"),
            count_phrase(content_changes.len() - note_changes.len(), "file", "files")
        )));
    }
    None
}

fn describe_note_changes(changes: &[NoteChange]) -> Option<String> {
    match changes {
        [] => None,
        [change] => Some(limit_subject(match change.action {
            ChangeAction::Add => format!("Add {}", change.label.text()),
            ChangeAction::Update => format!("Update {}", change.label.text()),
            ChangeAction::Delete => format!("Delete {}", change.label.text()),
            ChangeAction::Rename => match &change.old_label {
                Some(NoteLabel::Private) if change.label == NoteLabel::Private => {
                    "Rename private note".to_string()
                }
                Some(old_label) => {
                    format!("Rename {} to {}", old_label.text(), change.label.text())
                }
                None => format!("Rename {}", change.label.text()),
            },
        })),
        changes => {
            let action = group_action(changes.iter().map(|change| change.action));
            Some(limit_subject(format!(
                "{} {}",
                action.verb(),
                count_phrase(changes.len(), "note", "notes")
            )))
        }
    }
}

fn describe_group(changes: &[&TreeChange], singular: &str, plural: &str) -> Option<String> {
    let action = group_action(changes.iter().map(|change| change.action));
    Some(limit_subject(format!(
        "{} {}",
        action.verb(),
        count_phrase(changes.len(), singular, plural)
    )))
}

fn group_action(actions: impl Iterator<Item = ChangeAction>) -> ChangeAction {
    let mut actions = actions.peekable();
    let Some(first) = actions.peek().copied() else {
        return ChangeAction::Update;
    };
    if actions.all(|action| action == first) {
        first
    } else {
        ChangeAction::Update
    }
}

impl ChangeAction {
    fn verb(self) -> &'static str {
        match self {
            ChangeAction::Add => "Add",
            ChangeAction::Update => "Update",
            ChangeAction::Delete => "Delete",
            ChangeAction::Rename => "Rename",
        }
    }
}

fn note_change(
    repo: &Repository,
    parent: Option<&Commit<'_>>,
    tree: &Tree<'_>,
    change: &TreeChange,
) -> Option<NoteChange> {
    let label = staged_note_label(repo, parent, tree, change)?;
    let old_label = change
        .old_path
        .as_deref()
        .and_then(|old_path| old_note_label(repo, parent, old_path));
    Some(NoteChange {
        action: change.action,
        label,
        old_label,
    })
}

fn staged_note_label(
    repo: &Repository,
    parent: Option<&Commit<'_>>,
    tree: &Tree<'_>,
    change: &TreeChange,
) -> Option<NoteLabel> {
    match change.action {
        ChangeAction::Delete => old_note_label(repo, parent, &change.path),
        _ => current_note_label(repo, tree, &change.path),
    }
}

fn current_note_label(repo: &Repository, tree: &Tree<'_>, path: &str) -> Option<NoteLabel> {
    let fallback = note_label(path)?;
    Some(match note_title_from_tree(repo, tree, path) {
        Some(AuthoredNoteTitle::Public(title)) => NoteLabel::Named(title),
        Some(AuthoredNoteTitle::Private) => NoteLabel::Private,
        None => NoteLabel::Named(fallback),
    })
}

fn old_note_label(repo: &Repository, parent: Option<&Commit<'_>>, path: &str) -> Option<NoteLabel> {
    let fallback = note_label(path)?;
    let parent_tree = parent.and_then(|parent| parent.tree().ok());
    Some(
        match parent_tree
            .as_ref()
            .and_then(|tree| note_title_from_tree(repo, tree, path))
        {
            Some(AuthoredNoteTitle::Public(title)) => NoteLabel::Named(title),
            Some(AuthoredNoteTitle::Private) => NoteLabel::Private,
            None => NoteLabel::Named(fallback),
        },
    )
}

/// The note's authored title, or `Private` when the shared classifier
/// withholds it. Privacy is decided on the raw blob bytes, so a note that
/// isn't UTF-8 can't fall back to its path label.
fn note_title_from_tree(
    repo: &Repository,
    tree: &Tree<'_>,
    path: &str,
) -> Option<AuthoredNoteTitle> {
    let entry = tree.get_path(Path::new(path)).ok()?;
    let object = entry.to_object(repo).ok()?;
    let content = object.as_blob()?.content();
    if !backup_privacy(content).is_public() {
        return Some(AuthoredNoteTitle::Private);
    }
    if daily_date(path).is_some() {
        return None;
    }
    authored_note_title(std::str::from_utf8(content).ok()?)
}

fn note_label(path: &str) -> Option<String> {
    if let Some(date) = daily_date(path) {
        return Some(format!("daily note for {date}"));
    }

    let stem = path
        .strip_prefix("notes/")?
        .strip_suffix(".md")?
        .rsplit('/')
        .next()?;
    let label = humanize_stem(stem);
    (!label.is_empty()).then_some(label)
}

fn authored_note_title(source: &str) -> Option<AuthoredNoteTitle> {
    let split = split_frontmatter(source);
    frontmatter_title(split.raw)
        .or_else(|| first_h1(split.body))
        .map(|title| collapse_spaces(&title))
        .filter(|title| !title.is_empty())
        .map(AuthoredNoteTitle::Public)
}

/// The frontmatter `title` as the app reads it: a string from a block that
/// loads, never a guess from a line of YAML that doesn't.
fn frontmatter_title(raw: Option<&str>) -> Option<String> {
    parse_frontmatter(raw)
        .title
        .filter(|title| !title.trim().is_empty())
}

fn first_h1(body: &str) -> Option<String> {
    let lines: Vec<&str> = body.lines().collect();
    let mut in_fence = false;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some(heading) = atx_h1(trimmed) {
            return Some(heading);
        }
        if index + 1 < lines.len() && is_setext_h1(lines[index + 1]) {
            let heading = clean_heading_text(line);
            if !heading.is_empty() {
                return Some(heading);
            }
        }
    }
    None
}

fn atx_h1(line: &str) -> Option<String> {
    let rest = line.strip_prefix('#')?;
    if rest.starts_with('#') {
        return None;
    }
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None;
    }
    let heading = clean_heading_text(rest);
    (!heading.is_empty()).then_some(heading)
}

fn is_setext_h1(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty() && trimmed.chars().all(|character| character == '=')
}

fn clean_heading_text(raw: &str) -> String {
    let text = raw
        .trim()
        .trim_end_matches('#')
        .trim_end()
        .trim_end_matches('#')
        .trim();
    text.to_string()
}

fn daily_date(path: &str) -> Option<&str> {
    let date = path.strip_prefix("daily/")?.strip_suffix(".md")?;
    is_date_shaped(date).then_some(date)
}

fn is_date_shaped(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        })
}

fn humanize_stem(stem: &str) -> String {
    let normalized = collapse_spaces(
        &stem
            .chars()
            .map(|character| match character {
                '-' | '_' => ' ',
                character if character.is_control() => ' ',
                character => character,
            })
            .collect::<String>(),
    );
    if normalized.chars().any(char::is_uppercase) {
        return normalized;
    }
    title_case(&normalized)
}

fn title_case(value: &str) -> String {
    value
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            let Some(first) = chars.next() else {
                return String::new();
            };
            first.to_uppercase().chain(chars).collect::<String>()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn collapse_spaces(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn count_phrase(count: usize, singular: &str, plural: &str) -> String {
    if count == 1 {
        format!("1 {singular}")
    } else {
        format!("{count} {plural}")
    }
}

fn is_backup_metadata_path(path: &str) -> bool {
    matches!(path, ".gitignore" | ".gitattributes")
}

fn is_attachment_path(path: &str) -> bool {
    path.starts_with("assets/") || path.starts_with("audio-memos/")
}

fn limit_subject(subject: String) -> String {
    const MAX_SUBJECT_CHARS: usize = 72;
    if subject.chars().count() <= MAX_SUBJECT_CHARS {
        return subject;
    }
    subject
        .chars()
        .take(MAX_SUBJECT_CHARS.saturating_sub(3))
        .chain("...".chars())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn title(source: &str) -> Option<String> {
        match authored_note_title(source)? {
            AuthoredNoteTitle::Public(title) => Some(title),
            AuthoredNoteTitle::Private => None,
        }
    }

    /// The subject names a note by the title the app reads, from YAML that
    /// loads: never a nested or block-scalar `title:` line, and a block that
    /// doesn't load falls back to the H1.
    #[test]
    fn titles_come_from_the_shared_frontmatter_parser() {
        assert_eq!(
            title("---\ntitle: \"Project #1\" # c\n---\n# H1\n").as_deref(),
            Some("Project #1")
        );
        assert_eq!(
            title("---\nmeta:\n  title: Nested\n---\n# Heading\n").as_deref(),
            Some("Heading")
        );
        assert_eq!(
            title("---\nnotes: |\n  title: Inside a block\n---\n# Heading\n").as_deref(),
            Some("Heading")
        );
        assert_eq!(
            title("---\ntitle: First\ntags: [unclosed\n---\n# Heading\n").as_deref(),
            Some("Heading")
        );
        assert_eq!(
            title("---\ntitle: 2024\n---\n# Heading\n").as_deref(),
            Some("Heading")
        );
    }
}
