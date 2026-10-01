/**
 * Local-only folders: folders (by name, e.g. `secure`) whose notes stay on
 * this device. The desktop reads them — usually through a symlink into a
 * separate raw store outside the graph — but every note inside one is treated
 * as private everywhere (AI, asset descriptions, publishing, any network
 * path), opens read-only, is never written, and is never committed by Git
 * sync.
 *
 * The folder names come from Rust (`GraphInfo.localOnlyFolders`, loaded from
 * the settings store when the graph opens), so the walk, the read guard, the
 * index flag, and these gates share one configuration. The graph-open
 * commands record them here as the open graph's session state.
 *
 * The predicate mirrors `LocalOnlyFolders::contains` in
 * `crates/graph-paths` exactly — per `/`-separated component, empty and `.`
 * segments skipped, ASCII case-insensitive, directory components only — and
 * `fixtures/local-only-paths.json` pins the two together.
 */

/** ASCII-only lowercase, matching Rust's `eq_ignore_ascii_case`. */
function foldAscii(name: string): string {
  return name.replaceAll(/[A-Z]/g, (letter) => letter.toLowerCase())
}

let folderKeys: ReadonlySet<string> = new Set()

/** Record the open graph's local-only folder names (from `GraphInfo`). */
export function setLocalOnlyFolders(names: readonly string[]): void {
  folderKeys = new Set(names.map(foldAscii))
}

/**
 * Whether a graph-relative path lies inside a local-only folder of the open
 * graph: some directory component (every component but the last) is a
 * configured name. Such a note is private and read-only regardless of its
 * frontmatter.
 */
export function isLocalOnlyPath(path: string): boolean {
  if (folderKeys.size === 0) {
    return false
  }
  const components = path.split('/').filter((component) => component !== '' && component !== '.')
  return components.slice(0, -1).some((component) => folderKeys.has(foldAscii(component)))
}
