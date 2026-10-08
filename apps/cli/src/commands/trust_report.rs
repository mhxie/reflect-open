//! `reflect trust-report` — where agent harnesses publish this graph's wiki
//! trust report (Plan 30): the path set in Reflect's Settings → Wiki, or the
//! default when none is set. Harnesses ask here instead of assuming the
//! default, since the setting lives outside the graph.

use std::fs;
use std::path::Path;

use reflect_graph_paths::{
    is_wiki_trust_report_path, DEFAULT_WIKI_TRUST_REPORT_PATH, WIKI_TRUST_REPORT_PATH_KEY,
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
    let configured = document.get(WIKI_TRUST_REPORT_PATH_KEY)?.as_str()?;
    is_wiki_trust_report_path(configured).then(|| configured.to_owned())
}

pub fn run(graph: &Graph, json: bool) -> Result<(), CliError> {
    let configured = settings_path().and_then(|path| configured_in(&path));
    let rel = configured
        .clone()
        .unwrap_or_else(|| DEFAULT_WIKI_TRUST_REPORT_PATH.to_owned());
    let absolute = graph.root.join(&rel);
    if json {
        return print_json(&TrustReportJson {
            path: &rel,
            absolute_path: absolute.display().to_string(),
            configured: configured.is_some(),
            exists: absolute.is_file(),
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
        fs::write(&settings, r#"{"wikiTrustReportPath":".reflect/x.json"}"#).unwrap();
        assert_eq!(configured_in(&settings), None);
        fs::write(&settings, r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(configured_in(&settings), None);
        assert_eq!(configured_in(&dir.path().join("missing.json")), None);
    }
}
