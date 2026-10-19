/**
 * Local-only folders: folders (by name, e.g. `secure`) whose notes stay on
 * this device. The desktop reads them — usually through a symlink into a
 * separate raw store outside the graph — but every note inside one is treated
 * as private everywhere (AI, asset descriptions, publishing, any network
 * path) and is never committed by Git sync.
 *
 * They are read-only unless the graph's configuration also lists their name
 * as editable. Then the user edits notes in place: Rust keeps every such
 * write inside the folder, checks it against the revision its writer read,
 * and never follows a link inside the folder. Everything else (pulls,
 * imports, background passes) still never writes there.
 *
 * The folder names come from Rust (`GraphInfo.localOnlyFolders` and
 * `GraphInfo.localOnlyEditableFolders`, loaded from the settings store when
 * the graph opens), so the walk, the read guard, the index flag, the edit
 * resolver, and these gates share one configuration. Each open graph's
 * {@link LocalOnlyFolders} is its `GraphSession.localOnly`, so a pass that
 * outlives a graph switch keeps deciding with its own graph's folders.
 *
 * The predicates mirror `LocalOnlyFolders` in `crates/graph-paths` exactly —
 * per `/`-separated component, empty and `.` segments skipped, ASCII
 * case-insensitive, directory components only — and
 * `fixtures/local-only-paths.json` and `fixtures/local-only-editable.json`
 * pin the two together. They are the UI's gates and a first check: Rust
 * decides again for every path that leaves this machine and every write into
 * a local-only folder.
 */

/**
 * One graph's local-only folder names, ASCII-folded.
 */
export interface LocalOnlyFolders {
  /**
   * Every configured local-only folder name.
   */
  readonly folders: ReadonlySet<string>
  /**
   * The configured names whose notes are editable in place.
   */
  readonly editable: ReadonlySet<string>
}

/**
 * A graph without local-only folders.
 */
export const NO_LOCAL_ONLY_FOLDERS: LocalOnlyFolders = {
  folders: new Set(),
  editable: new Set(),
}

/**
 * The local-only folders named by a graph's configuration, and, of those, the
 * ones editable in place. An editable name that is not a configured folder
 * grants nothing.
 */
export function createLocalOnlyFolders(
  names: readonly string[],
  editable: readonly string[] = [],
): LocalOnlyFolders {
  if (names.length === 0) {
    return NO_LOCAL_ONLY_FOLDERS
  }
  const folders = new Set(names.map(foldAscii))
  return {
    folders,
    editable: new Set(editable.map(foldAscii).filter((key) => folders.has(key))),
  }
}

/** ASCII-only lowercase, matching Rust's `eq_ignore_ascii_case`. */
function foldAscii(name: string): string {
  return name.replaceAll(/[A-Z]/g, (letter) => letter.toLowerCase())
}

/** A path's directory components (every component but the last), as written. */
function directoryComponents(path: string): string[] {
  return path
    .split('/')
    .filter((component) => component !== '' && component !== '.')
    .slice(0, -1)
}

/**
 * Whether a graph-relative path lies inside one of the graph's local-only
 * folders: some directory component (every component but the last) is a
 * configured name. Such a note is private regardless of its frontmatter, and
 * this is the predicate every privacy gate uses, editable folder or not.
 */
export function isLocalOnlyPath(localOnly: LocalOnlyFolders, path: string): boolean {
  if (localOnly.folders.size === 0) {
    return false
  }
  return directoryComponents(path).some((component) => localOnly.folders.has(foldAscii(component)))
}

/**
 * Whether a graph-relative path lies inside local-only folders that are all
 * editable: it is local-only ({@link isLocalOnlyPath}) and every directory
 * component carrying a configured name is an editable one, so a folder
 * nested in a read-only folder stays read-only. Mirrors
 * `LocalOnlyFolders::editable_contains`.
 */
export function isEditableLocalOnlyPath(localOnly: LocalOnlyFolders, path: string): boolean {
  const configured = directoryComponents(path)
    .map(foldAscii)
    .filter((key) => localOnly.folders.has(key))
  return configured.length > 0 && configured.every((key) => localOnly.editable.has(key))
}

/**
 * Whether a graph-relative path lies inside a local-only folder that is
 * read-only: some directory component carrying a configured name is not
 * editable. Every edit gate (the editor, task toggles, note actions,
 * attachment intake, link rewrites) refuses such a note.
 */
export function isLocalOnlyReadOnlyPath(localOnly: LocalOnlyFolders, path: string): boolean {
  return isLocalOnlyPath(localOnly, path) && !isEditableLocalOnlyPath(localOnly, path)
}

/**
 * The local-only folder a path lies in: the path through its innermost
 * directory component carrying a configured name, spelled as requested, with
 * empty and `.` segments dropped (`finance//secure/sub/x.md` →
 * `finance/secure`). `null` outside every local-only folder. An editable
 * note's attachments live in `<folder>/assets/`. Mirrors
 * `LocalOnlyFolders::folder_root`.
 */
export function localOnlyFolderRoot(localOnly: LocalOnlyFolders, path: string): string | null {
  const directories = directoryComponents(path)
  const innermost = directories.findLastIndex((component) =>
    localOnly.folders.has(foldAscii(component)),
  )
  return innermost === -1 ? null : directories.slice(0, innermost + 1).join('/')
}
