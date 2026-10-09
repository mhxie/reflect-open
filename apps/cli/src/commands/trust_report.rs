//! `reflect trust-report` — where agent harnesses publish this graph's wiki
//! trust report: the path set in Reflect's Settings → Wiki, or the
//! default when none is set. Harnesses ask here instead of assuming the
//! default, since the setting lives outside the graph.

use std::fs;
use std::path::Path;

use reflect_graph_paths::{
    is_wiki_trust_report_path, normalize_wiki_trust_report_path, DEFAULT_WIKI_TRUST_REPORT_PATH,
    WIKI_TRUST_REPORT_PATH_KEY,
};
use serde_json::Value;

use crate::commands::output::{print_json, TrustReportJson};
use crate::commands::warn;
use crate::error::CliError;
use crate::graph::Graph;
use crate::local_only_settings::settings_path;

/// The configured report path in the settings document at `path`, or `None`
/// when it is missing, unset, or not a path Reflect would read.
fn configured_in(path: &Path) -> Option<String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) => {
            if err.kind() != std::io::ErrorKind::NotFound {
                warn(format!(
                    "Reflect's settings could not be read ({err}); using the default"
                ));
            }
            return None;
        }
    };
    let document: Value = serde_json::from_str(&raw).ok()?;
    normalize_wiki_trust_report_path(document.get(WIKI_TRUST_REPORT_PATH_KEY)?.as_str()?)
}

/// Whether Reflect can read a report at `rel`: no link on the way (its
/// reader follows none, so a linked `.harness/` would hide the report or
/// send the harness's write out of the graph), and the existing folders,
/// with the filesystem's own name folding, land at a report path.
fn lands_in_graph(root: &Path, rel: &str) -> bool {
    let (Ok(canonical_root), joined) = (root.canonicalize(), root.join(rel)) else {
        return false;
    };
    let mut prefix = root.to_path_buf();
    for component in Path::new(rel).components() {
        prefix.push(component);
        match prefix.symlink_metadata() {
            Ok(meta) if meta.file_type().is_symlink() => return false,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    let mut existing = joined.as_path();
    let mut missing = Vec::new();
    while existing.symlink_metadata().is_err() {
        match (existing.file_name(), existing.parent()) {
            (Some(name), Some(parent)) => {
                missing.push(name);
                existing = parent;
            }
            _ => return false,
        }
    }
    let Ok(landed) = existing.canonicalize() else {
        return false;
    };
    let Ok(landed) = landed.strip_prefix(&canonical_root) else {
        return false;
    };
    let mut landed = landed.to_path_buf();
    landed.extend(missing.iter().rev());
    is_wiki_trust_report_path(&landed.to_string_lossy().replace('\\', "/"))
}

pub fn run(graph: &Graph, json: bool) -> Result<(), CliError> {
    let configured = settings_path().and_then(|path| configured_in(&path));
    let rel = configured
        .clone()
        .unwrap_or_else(|| DEFAULT_WIKI_TRUST_REPORT_PATH.to_owned());
    let absolute = graph.root.join(&rel);
    if !lands_in_graph(&graph.root, &rel) {
        return Err(CliError::Private(format!(
            "{rel} goes through a link, which Reflect does not follow, or into Reflect's \
             own folders, so no harness should write there: point it at a plain folder \
             in the graph"
        )));
    }
    if json {
        // Unknown local-only folders refuse (exit 3) rather than read as none.
        let index = super::open_index_for_resolution(&graph.root)?;
        let local_only = super::local_only_of(&graph.root, index.as_ref())?;
        return print_json(&TrustReportJson {
            path: &rel,
            absolute_path: absolute.display().to_string(),
            configured: configured.is_some(),
            exists: absolute.is_file(),
            local_only_folders: local_only.as_ref().map_or(&[], |folders| folders.names()),
        });
    }
    println!("{}", absolute.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::configured_in;
    use std::fs;

    #[test]
    fn reads_a_valid_configured_path_and_ignores_others() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        fs::write(
            &settings,
            r#"{"wikiTrustReportPath":"_meta/wiki-trust.json"}"#,
        )
        .unwrap();
        assert_eq!(
            configured_in(&settings).as_deref(),
            Some("_meta/wiki-trust.json")
        );
        fs::write(&settings, r#"{"wikiTrustReportPath":" ./_meta/t.json "}"#).unwrap();
        assert_eq!(configured_in(&settings).as_deref(), Some("_meta/t.json"));
        fs::write(&settings, r#"{"wikiTrustReportPath":".reflect/x.json"}"#).unwrap();
        assert_eq!(configured_in(&settings), None);
        fs::write(&settings, r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(configured_in(&settings), None);
        assert_eq!(configured_in(&dir.path().join("missing.json")), None);
    }
}
