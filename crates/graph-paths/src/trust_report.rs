//! Where an agent harness's wiki trust report may live. The desktop
//! reader and the CLI share these rules; the TypeScript settings check runs
//! the same corpus (`fixtures/wiki-trust-report-paths.json`).

/// The report path a harness writes unless the user configures another.
pub const DEFAULT_WIKI_TRUST_REPORT_PATH: &str = ".harness/wiki-trust.json";

/// The desktop settings key holding the configured report path.
pub const WIKI_TRUST_REPORT_PATH_KEY: &str = "wikiTrustReportPath";

/// Whether `rel` names a place a trust report may live: plain `/`-separated
/// segments (none empty, `.`, `..`, or holding `\` or `:`, so no Windows
/// drive or stream can redirect it), ending in `.json` in any
/// case, and not under Reflect's `.reflect/` state or `.git/`. Hidden folders
/// such as `.harness/` are allowed.
pub fn is_wiki_trust_report_path(rel: &str) -> bool {
    let segments: Vec<&str> = rel.split('/').collect();
    let plain = segments.iter().all(|segment| {
        !segment.is_empty() && *segment != "." && *segment != ".." && !segment.contains(['\\', ':'])
    });
    let first = segments[0];
    plain
        && !first.eq_ignore_ascii_case(".reflect")
        && !first.eq_ignore_ascii_case(".git")
        && rel.to_ascii_lowercase().ends_with(".json")
}

/// A configured path as Reflect's settings field reads it: trimmed, a
/// leading `./` dropped, and `None` unless [`is_wiki_trust_report_path`]
/// accepts the result.
pub fn normalize_wiki_trust_report_path(input: &str) -> Option<String> {
    let trimmed = input.trim();
    let path = trimmed.strip_prefix("./").unwrap_or(trimmed);
    is_wiki_trust_report_path(path).then(|| path.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{
        is_wiki_trust_report_path, normalize_wiki_trust_report_path, DEFAULT_WIKI_TRUST_REPORT_PATH,
    };
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Case {
        path: String,
        valid: bool,
    }

    #[derive(Deserialize)]
    struct Corpus {
        cases: Vec<Case>,
        default: String,
    }

    #[test]
    fn matches_the_shared_corpus() {
        let raw = include_str!("../../../fixtures/wiki-trust-report-paths.json");
        let corpus: Corpus = serde_json::from_str(raw).unwrap();
        for case in corpus.cases {
            assert_eq!(
                is_wiki_trust_report_path(&case.path),
                case.valid,
                "{:?}",
                case.path
            );
        }
        assert_eq!(DEFAULT_WIKI_TRUST_REPORT_PATH, corpus.default);
    }

    #[test]
    fn normalizes_as_the_settings_field_does() {
        assert_eq!(
            normalize_wiki_trust_report_path(" ./_meta/wiki-trust.json ").as_deref(),
            Some("_meta/wiki-trust.json")
        );
        assert_eq!(normalize_wiki_trust_report_path("./.reflect/x.json"), None);
    }
}
