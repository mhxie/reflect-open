//! The `reflect` binary: clap surface + exit-code mapping. All behavior lives
//! in the library modules so integration tests exercise the same code paths.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::error::ErrorKind;
use clap::{CommandFactory, Parser, Subcommand};

use reflect_cli::commands::search::SearchMode;
use reflect_cli::error::CliError;
use reflect_cli::{commands, graph};
use reflect_index_schema::MAX_SEARCH_RESULTS;

/// Read and discover notes in a Reflect graph.
///
/// The graph resolves from --graph, then $REFLECT_GRAPH, then the nearest
/// ancestor of the current directory containing .reflect/. Notes marked
/// `private: true` are never returned. Exit codes: 0 ok, 1 error, 2 usage,
/// 3 not found or private, 4 search index missing, 5 the app isn't serving
/// the graph (semantic and hybrid search).
#[derive(Parser)]
#[command(name = "reflect", version)]
struct Cli {
    /// Graph directory (default: nearest ancestor with .reflect/, or $REFLECT_GRAPH)
    #[arg(long, global = true, value_name = "PATH")]
    graph: Option<PathBuf>,

    /// Emit JSON on stdout instead of human-readable text
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print today's daily note
    Today {
        /// Print the daily note's absolute path instead (works before the file exists)
        #[arg(long)]
        path: bool,
    },
    /// Full-text search over the graph's search index
    Search {
        /// Search terms (matched literally, ranked by relevance)
        query: String,
        /// Maximum number of results (at most 100 for semantic and hybrid)
        #[arg(long, default_value_t = 20, value_parser = parse_limit)]
        limit: usize,
        /// lexical reads the index; semantic and hybrid ask the running Reflect app
        #[arg(long, value_enum, default_value_t = SearchMode::Lexical)]
        mode: SearchMode,
    },
    /// Print a note, resolved by date, path, title, or alias
    Show {
        /// A YYYY-MM-DD date, graph-relative path, note title, or alias
        note: String,
    },
    /// Resolve a note to its absolute path (for piping into editors/tools)
    Path {
        /// A YYYY-MM-DD date, graph-relative path, note title, or alias
        note: String,
    },
    /// Open a note in the Reflect app via its reflect:// deep link
    Open {
        /// A YYYY-MM-DD date, graph-relative path, note title, or alias
        note: String,
        /// Print the URL without launching the app
        #[arg(long)]
        print: bool,
    },
}

/// `--limit`: a whole number of at least 1. Semantic and hybrid searches are
/// further held to [`MAX_SEARCH_RESULTS`] ([`check_usage`]).
fn parse_limit(value: &str) -> Result<usize, String> {
    match value.parse::<usize>() {
        Ok(limit) if limit >= 1 => Ok(limit),
        _ => Err(format!("{value:?} is not a whole number of at least 1")),
    }
}

/// Usage rules clap can't express per argument: the app's socket answers at
/// most [`MAX_SEARCH_RESULTS`] results, so semantic and hybrid searches
/// refuse a larger `--limit` up front (a usage error, exit 2) rather than
/// failing at the app. Lexical search reads the index and has no such bound.
fn check_usage(cli: &Cli) {
    if let Command::Search { limit, mode, .. } = &cli.command {
        if *mode != SearchMode::Lexical && *limit > MAX_SEARCH_RESULTS {
            Cli::command()
                .error(
                    ErrorKind::ValueValidation,
                    format!(
                        "--limit must be at most {MAX_SEARCH_RESULTS} for semantic and hybrid search"
                    ),
                )
                .exit();
        }
    }
}

fn run(cli: &Cli) -> Result<(), CliError> {
    let graph = graph::resolve(cli.graph.as_deref())?;
    match &cli.command {
        Command::Today { path } => commands::today::run(&graph, cli.json, *path),
        Command::Search { query, limit, mode } => {
            commands::search::run(&graph, cli.json, query, *limit, *mode)
        }
        Command::Show { note } => commands::show::run(&graph, cli.json, note),
        Command::Path { note } => commands::path::run(&graph, cli.json, note),
        Command::Open { note, print } => commands::open::run(&graph, cli.json, note, *print),
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    check_usage(&cli);
    match run(&cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("reflect: {err}");
            ExitCode::from(err.exit_code())
        }
    }
}
