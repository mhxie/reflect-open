//! The pre-scan: everything that decides whether a frontmatter block may be
//! loaded, decided on saphyr-parser's event stream before
//! `Yaml::load_from_str` materializes anything, plus the line scan that reads
//! a `private:` line without parsing at all.
//!
//! The load decision mirrors `loadFrontmatterBlock` in
//! `packages/core/src/markdown/frontmatter-load.ts`, which applies the same
//! rules to yaml's document: a block either side refuses is "not loaded" on
//! both, and its privacy then comes from the line scan alone.

use std::collections::{HashMap, HashSet};

use saphyr_parser::{Event, Parser, Tag};

use crate::classify::UnreadableReason;
use crate::scalar::{classify_untagged, key_identity, Scalar, ValueClass, CORE_TAG_PREFIX};

/// Blocks larger than this are never parsed (256 KiB).
pub(crate) const MAX_BLOCK_BYTES: usize = 256 * 1024;

/// The most nodes alias expansion may add. saphyr clones an anchored subtree
/// for every alias, so this bounds what loading a block can allocate.
pub(crate) const ALIAS_EXPANSION_BUDGET: u64 = 10_000;

/// yaml's `maxAliasCount` default: an anchor used more often than this,
/// weighted by the aliases inside it, makes TS refuse the block.
const MAX_ALIAS_COUNT: u64 = 100;

pub(crate) type NodeId = usize;

/// One node of the parsed document, aliases left unexpanded.
#[derive(Debug)]
pub(crate) enum NodeKind {
    Scalar(Scalar),
    Sequence(Collection),
    Mapping(Collection),
    /// Stands for an earlier anchored node.
    Alias(NodeId),
}

#[derive(Debug)]
pub(crate) struct Collection {
    pub(crate) tag: Option<String>,
    /// Sequence items, or a mapping's keys and values interleaved.
    pub(crate) children: Vec<NodeId>,
}

#[derive(Debug)]
struct Node {
    kind: NodeKind,
    anchored: bool,
    /// One past the last node of this node's subtree: nodes are numbered in
    /// document order, so a subtree is a contiguous id range.
    end: NodeId,
}

/// A single-document frontmatter block, parsed but not loaded.
#[derive(Debug)]
pub(crate) struct Tree {
    nodes: Vec<Node>,
    root: Option<NodeId>,
}

impl Tree {
    /// The node `id` stands for: an alias's anchor, or the node itself.
    pub(crate) fn resolve(&self, id: NodeId) -> &NodeKind {
        match self.nodes[id].kind {
            NodeKind::Alias(target) => &self.nodes[target].kind,
            ref kind => kind,
        }
    }

    /// The root mapping's `(key, value)` pairs (empty unless the root is a
    /// mapping).
    pub(crate) fn root_pairs(&self) -> impl Iterator<Item = (NodeId, NodeId)> + '_ {
        let children = match self.root.map(|root| &self.nodes[root].kind) {
            Some(NodeKind::Mapping(mapping)) => mapping.children.as_slice(),
            _ => &[],
        };
        children
            .as_chunks::<2>()
            .0
            .iter()
            .map(|[key, value]| (*key, *value))
    }
}

/// Whether a block may be loaded.
#[derive(Debug)]
pub(crate) enum Load {
    Loaded(Tree),
    NotLoaded(UnreadableReason),
}

/// Decide whether `raw` loads: one document whose root is a plain mapping,
/// no duplicate keys, aliases within both budgets, and at most
/// [`MAX_BLOCK_BYTES`].
pub(crate) fn load(raw: &str) -> Load {
    if raw.len() > MAX_BLOCK_BYTES {
        return Load::NotLoaded(UnreadableReason::TooLarge);
    }
    let Ok((tree, more_documents)) = parse_tree(raw) else {
        return Load::NotLoaded(UnreadableReason::ParseFailed);
    };
    // yaml reports a duplicate key (in the first document) as an error, ahead
    // of a second document.
    if has_duplicate_keys(&tree) {
        return Load::NotLoaded(UnreadableReason::ParseFailed);
    }
    if more_documents {
        return Load::NotLoaded(UnreadableReason::MultipleDocuments);
    }
    if !within_expansion_budget(&tree) || !passes_alias_count_rule(&tree) {
        return Load::NotLoaded(UnreadableReason::AliasBudget);
    }
    if !has_plain_mapping_root(&tree) {
        return Load::NotLoaded(UnreadableReason::NotAMapping);
    }
    Load::Loaded(tree)
}

/// Build the first document's tree from the event stream. `Err` on any
/// parse error, including an alias to an unknown anchor; the flag reports a
/// second document, where parsing stops.
fn parse_tree(raw: &str) -> Result<(Tree, bool), ()> {
    let mut parser = Parser::new_from_str(raw);
    let mut nodes: Vec<Node> = Vec::new();
    let mut open: Vec<NodeId> = Vec::new();
    let mut anchors: HashMap<usize, NodeId> = HashMap::new();
    let mut root = None;
    let mut documents = 0;
    while let Some(next) = parser.next_event() {
        let (event, _span) = next.map_err(|_| ())?;
        let (kind, anchor, opens) = match event {
            Event::DocumentStart(_) => {
                documents += 1;
                if documents > 1 {
                    return Ok((Tree { nodes, root }, true));
                }
                continue;
            }
            Event::SequenceEnd | Event::MappingEnd => {
                if let Some(closed) = open.pop() {
                    nodes[closed].end = nodes.len();
                }
                continue;
            }
            Event::StreamEnd => break,
            Event::Nothing | Event::StreamStart | Event::DocumentEnd => continue,
            Event::Scalar(text, style, anchor, tag) => {
                let scalar = Scalar {
                    text: text.into_owned(),
                    style,
                    tag: tag.map(|tag| tag_name(&tag)),
                };
                (NodeKind::Scalar(scalar), anchor, false)
            }
            Event::SequenceStart(anchor, tag) => (
                NodeKind::Sequence(collection(tag.map(|tag| tag_name(&tag)))),
                anchor,
                true,
            ),
            Event::MappingStart(anchor, tag) => (
                NodeKind::Mapping(collection(tag.map(|tag| tag_name(&tag)))),
                anchor,
                true,
            ),
            Event::Alias(anchor) => (NodeKind::Alias(*anchors.get(&anchor).ok_or(())?), 0, false),
        };
        let id = nodes.len();
        nodes.push(Node {
            kind,
            anchored: anchor > 0,
            end: id + 1,
        });
        if anchor > 0 {
            anchors.insert(anchor, id);
        }
        match open.last() {
            Some(&parent) => match &mut nodes[parent].kind {
                NodeKind::Sequence(collection) | NodeKind::Mapping(collection) => {
                    collection.children.push(id);
                }
                NodeKind::Scalar(_) | NodeKind::Alias(_) => unreachable!("only collections open"),
            },
            None => root = Some(id),
        }
        if opens {
            open.push(id);
        }
    }
    Ok((Tree { nodes, root }, false))
}

fn collection(tag: Option<String>) -> Collection {
    Collection {
        tag,
        children: Vec::new(),
    }
}

/// A tag's full name, as yaml spells it: `tag:yaml.org,2002:str` for `!!str`
/// and for the verbatim `!<tag:yaml.org,2002:str>` alike, `!x` for a local tag.
fn tag_name(tag: &Tag) -> String {
    format!("{}{}", tag.handle, tag.suffix)
}

/// Whether any mapping repeats a key, compared the way yaml does for its
/// duplicate-key error: resolved scalar keys, aliases never equal.
fn has_duplicate_keys(tree: &Tree) -> bool {
    tree.nodes.iter().any(|node| {
        let NodeKind::Mapping(mapping) = &node.kind else {
            return false;
        };
        let mut seen = HashSet::new();
        mapping.children.iter().step_by(2).any(|&key| {
            let NodeKind::Scalar(scalar) = &tree.nodes[key].kind else {
                return false;
            };
            key_identity(scalar).is_some_and(|identity| !seen.insert(identity))
        })
    })
}

/// Whether alias expansion stays within [`ALIAS_EXPANSION_BUDGET`] added
/// nodes. An alias inside its own anchor expands without end.
fn within_expansion_budget(tree: &Tree) -> bool {
    let Some(root) = tree.root else {
        return true;
    };
    let source_nodes = tree
        .nodes
        .iter()
        .filter(|node| !matches!(node.kind, NodeKind::Alias(_)))
        .count() as u64;
    let cap = source_nodes.saturating_add(ALIAS_EXPANSION_BUDGET);
    // Expanded sizes, computed depth-first with an explicit stack; `active`
    // marks the nodes being expanded, so reaching one again is a cycle.
    let mut size: Vec<Option<u64>> = vec![None; tree.nodes.len()];
    let mut active = vec![false; tree.nodes.len()];
    let mut stack: Vec<(NodeId, usize)> = vec![(root, 0)];
    active[root] = true;
    while let Some(frame) = stack.last_mut() {
        let id = frame.0;
        let pending = match &tree.nodes[id].kind {
            NodeKind::Scalar(_) => None,
            NodeKind::Alias(target) => Some(*target).filter(|target| size[*target].is_none()),
            NodeKind::Sequence(collection) | NodeKind::Mapping(collection) => {
                while frame.1 < collection.children.len()
                    && size[collection.children[frame.1]].is_some()
                {
                    frame.1 += 1;
                }
                collection.children.get(frame.1).copied()
            }
        };
        if let Some(next) = pending {
            if active[next] {
                return false;
            }
            active[next] = true;
            stack.push((next, 0));
            continue;
        }
        let total = match &tree.nodes[id].kind {
            NodeKind::Scalar(_) => 1,
            NodeKind::Alias(target) => size[*target].unwrap_or(u64::MAX),
            NodeKind::Sequence(collection) | NodeKind::Mapping(collection) => {
                collection.children.iter().fold(1u64, |sum, child| {
                    sum.saturating_add(size[*child].unwrap_or(u64::MAX))
                })
            }
        };
        // Every node is part of the root's expansion, so one over the cap is
        // enough to know the whole document is.
        if total > cap {
            return false;
        }
        size[id] = Some(total);
        active[id] = false;
        stack.pop();
    }
    true
}

/// yaml's alias rule, replayed in its conversion order (document order, which
/// is node order): each anchor starts at one use; every alias adds a use and,
/// the first time it is needed, fixes the anchor's alias count (the largest
/// leaf weight in its subtree — 1 per scalar, uses × count per nested alias,
/// 0 for an empty collection); uses × count above [`MAX_ALIAS_COUNT`] fails.
/// Run after the expansion budget, which bounds the work here.
fn passes_alias_count_rule(tree: &Tree) -> bool {
    // (uses, alias count) per anchored node, once conversion reaches it.
    let mut anchors: Vec<Option<(u64, u64)>> = vec![None; tree.nodes.len()];
    for id in 0..tree.nodes.len() {
        if tree.nodes[id].anchored {
            anchors[id] = Some((1, 0));
        }
        let NodeKind::Alias(target) = tree.nodes[id].kind else {
            continue;
        };
        let Some((uses, alias_count)) = anchors[target] else {
            continue;
        };
        let uses = uses + 1;
        let alias_count = if alias_count == 0 {
            subtree_alias_count(tree, target, &anchors)
        } else {
            alias_count
        };
        anchors[target] = Some((uses, alias_count));
        if uses.saturating_mul(alias_count) > MAX_ALIAS_COUNT {
            return false;
        }
    }
    true
}

/// yaml's `getAliasCount` for the subtree rooted at `start`: the maximum
/// over its leaves, aliases weighted by their anchor's current uses × count.
fn subtree_alias_count(tree: &Tree, start: NodeId, anchors: &[Option<(u64, u64)>]) -> u64 {
    (start..tree.nodes[start].end)
        .filter_map(|id| match tree.nodes[id].kind {
            NodeKind::Scalar(_) => Some(1),
            NodeKind::Alias(target) => {
                Some(anchors[target].map_or(0, |(uses, count)| uses.saturating_mul(count)))
            }
            NodeKind::Sequence(_) | NodeKind::Mapping(_) => None,
        })
        .max()
        .unwrap_or(0)
}

/// Whether the root is a mapping with no tag but `!!map` and no merge key.
/// yaml merges `<<` keys in some modes and not others, so a root that has
/// one can't be read the same way everywhere.
fn has_plain_mapping_root(tree: &Tree) -> bool {
    let Some(NodeKind::Mapping(mapping)) = tree.root.map(|root| &tree.nodes[root].kind) else {
        return false;
    };
    let map_tag = format!("{CORE_TAG_PREFIX}map");
    if mapping.tag.as_ref().is_some_and(|tag| *tag != map_tag) {
        return false;
    }
    !tree.root_pairs().any(|(key, _)| is_merge_key(tree, key))
}

/// A `<<` key in any spelling, or any key tagged `!!merge`.
fn is_merge_key(tree: &Tree, key: NodeId) -> bool {
    let NodeKind::Scalar(scalar) = tree.resolve(key) else {
        return false;
    };
    scalar.text == "<<" || scalar.tag.as_deref() == Some(&format!("{CORE_TAG_PREFIX}merge"))
}

/// Whether some column-0 `private:` line carries a truthy value. The key may
/// be quoted, and `!tag`/`&anchor` properties are skipped on both sides of
/// the colon; a quoted value is read verbatim (no escapes), an unquoted one
/// up to its comment and resolved like a plain scalar. Mirrors
/// `lineScanPrivate` in the TS classifier character for character.
pub(crate) fn line_scan_private(raw: &str) -> bool {
    raw.split(['\r', '\n'])
        .any(|line| line_value(line) == Some(ValueClass::Private))
}

fn line_value(line: &str) -> Option<ValueClass> {
    let rest = skip_properties(line);
    let rest = ["private", "\"private\"", "'private'"]
        .iter()
        .find_map(|key| rest.strip_prefix(key))?;
    let rest = rest.trim_start_matches([' ', '\t']).strip_prefix(':')?;
    let value = skip_properties(rest.trim_start_matches([' ', '\t']));
    Some(match value.chars().next() {
        Some(quote @ ('"' | '\'')) => classify_untagged(quoted_text(&value[1..], quote), false),
        _ => classify_untagged(strip_comment(value), true),
    })
}

/// Skip leading `!tag` and `&anchor` properties, each ended by a space or tab.
/// A property with nothing after it leaves nothing.
fn skip_properties(mut text: &str) -> &str {
    while text.starts_with(['!', '&']) {
        match text.find([' ', '\t']) {
            Some(end) => text = text[end..].trim_start_matches([' ', '\t']),
            None => return "",
        }
    }
    text
}

/// The text inside a quoted scalar that opened just before `rest`: up to the
/// closing quote (an escaped `\"` or a doubled `''` doesn't close), or the
/// rest of the line when it never closes.
fn quoted_text(rest: &str, quote: char) -> &str {
    let bytes = rest.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match (quote, bytes[index]) {
            ('"', b'\\') => index += 2,
            ('"', b'"') => return &rest[..index],
            ('\'', b'\'') if bytes.get(index + 1) == Some(&b'\'') => index += 2,
            ('\'', b'\'') => return &rest[..index],
            _ => index += 1,
        }
    }
    rest
}

/// An unquoted value without its trailing comment: a `#` that opens the value
/// or follows a space or tab starts one.
fn strip_comment(value: &str) -> &str {
    let bytes = value.as_bytes();
    let end = (0..bytes.len())
        .find(|&index| {
            bytes[index] == b'#' && (index == 0 || matches!(bytes[index - 1], b' ' | b'\t'))
        })
        .unwrap_or(bytes.len());
    value[..end].trim_end_matches([' ', '\t'])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load_reason(raw: &str) -> Option<UnreadableReason> {
        match load(raw) {
            Load::Loaded(_) => None,
            Load::NotLoaded(reason) => Some(reason),
        }
    }

    #[test]
    fn a_plain_mapping_loads() {
        assert!(load_reason("title: Foo\naliases: [a, b]").is_none());
        assert!(load_reason("!!map {title: Foo}").is_none());
    }

    #[test]
    fn refused_shapes_name_their_reason() {
        use UnreadableReason::*;
        assert_eq!(load_reason("[broken yaml"), Some(ParseFailed));
        assert_eq!(load_reason("private: *nope"), Some(ParseFailed));
        assert_eq!(load_reason("a: 1\na: 2"), Some(ParseFailed));
        assert_eq!(load_reason("a: {b: 1, b: 2}"), Some(ParseFailed));
        assert_eq!(load_reason("1: a\n1.0: b"), Some(ParseFailed));
        assert_eq!(load_reason("a: 1\n--- b"), Some(MultipleDocuments));
        assert_eq!(load_reason("- a\n- b"), Some(NotAMapping));
        assert_eq!(load_reason("# only a comment"), Some(NotAMapping));
        assert_eq!(load_reason("!custom {a: 1}"), Some(NotAMapping));
        assert_eq!(load_reason("<<: {a: 1}"), Some(NotAMapping));
        assert_eq!(load_reason("!!merge <<: {a: 1}"), Some(NotAMapping));
        assert_eq!(load_reason("a: &a [*a]"), Some(AliasBudget));
    }

    /// yaml's rule counts the anchor itself as a use: a scalar anchor takes
    /// 99 aliases, and the 100th trips `count × aliasCount > 100`.
    #[test]
    fn the_alias_count_rule_matches_yaml_at_its_boundary() {
        let aliases = |count: usize| format!("a: &x 1\nb: [{}]", vec!["*x"; count].join(", "));
        assert!(load_reason(&aliases(99)).is_none());
        assert_eq!(
            load_reason(&aliases(100)),
            Some(UnreadableReason::AliasBudget)
        );
        // Empty anchors carry no alias weight, however often they're used.
        let empty = format!("a: &e []\nb: [{}]", vec!["*e"; 500].join(", "));
        assert!(load_reason(&empty).is_none());
    }

    #[test]
    fn expansion_counts_only_nodes_aliases_add() {
        let long_list = format!("tags: [{}]", vec!["t"; 20_000].join(", "));
        assert!(load_reason(&long_list).is_none());
        // 30 aliases of a 400-node list add 12,000 nodes: over budget, though
        // yaml's own rule (31 uses × weight 1) would allow it.
        let list = vec!["t"; 399].join(", ");
        let wide = format!("a: &l [{list}]\nb: [{}]", vec!["*l"; 30].join(", "));
        assert_eq!(load_reason(&wide), Some(UnreadableReason::AliasBudget));
    }

    #[test]
    fn line_scan_reads_column_zero_private_lines() {
        for line in [
            "private: true",
            "private:\ttrue",
            "private:true",
            "private : yes",
            "\"private\": on",
            "'private': 1",
            "!x private: !!bool yes",
            "&k private: &v TRUE # locked",
            "private: 1.0",
            "private: 0x1",
            "private: \"true\" # c",
        ] {
            assert!(line_scan_private(line), "{line}");
        }
        for line in [
            " private: true",
            "# private: true",
            "- private: true",
            "{private: true}",
            "private: false",
            "private: y",
            "private: \"1.0\"",
            "private: *t",
            "private: #true",
            "privateer: true",
            "private: \"tr\\x75e\"",
            "private: !!bool",
        ] {
            assert!(!line_scan_private(line), "{line}");
        }
        assert!(line_scan_private("title: x\r\nprivate: true\r\n"));
        assert!(line_scan_private("title: x\rprivate: true"));
    }
}
