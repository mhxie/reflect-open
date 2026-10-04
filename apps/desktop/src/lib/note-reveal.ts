/**
 * A request to scroll a note to the heading a link's `#fragment` names
 * (`[[Plan#Next steps]]`, a wiki claim's `[[Entry#^c3]]`). Hosts hand one to
 * their note pane; a new `key` asks again for the same fragment.
 */
export interface NoteReveal {
  readonly fragment: string
  readonly key: number
}
