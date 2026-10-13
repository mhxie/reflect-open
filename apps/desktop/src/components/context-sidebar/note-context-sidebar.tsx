import type { ReactElement } from 'react'
import { NoteActionsSection } from './note-actions-section.tsx'
import { OutlineSection } from './outline-section.tsx'
import { PublishedUrlSection } from './published-url-section.tsx'
import { SimilarNotesSection } from './similar-notes-section.tsx'
import { WikiLanguageSwitch } from './wiki-language-switch.tsx'

interface NoteContextSidebarProps {
  /** Graph-relative path of the open note the sidebar describes. */
  path: string
}

/**
 * An ordinary note's contextual sidebar. Pinned at the top, when the note has
 * them: a wiki entry's language switch, the note actions and the published
 * link. Below them scroll the note's outline and its semantic neighbors — the
 * only place similar notes appear. A window too short for the pinned parts and
 * a few lines of sections scrolls the whole sidebar instead. Inbound links live
 * under the note itself (the incoming-backlinks panel), not here. Rendered in
 * the AppShell's right region on `note` routes.
 */
export function NoteContextSidebar({ path }: NoteContextSidebarProps): ReactElement {
  return (
    <div className="flex h-full flex-col overflow-y-auto text-text">
      {/* pb-2: the action buttons' own padding makes up the rest of the 16px. */}
      <div className="flex-none space-y-4 border-b border-border pt-6 pb-2 empty:hidden">
        <WikiLanguageSwitch path={path} />
        <NoteActionsSection path={path} showTrash />
        <PublishedUrlSection path={path} />
      </div>
      <div className="min-h-24 flex-1 overflow-y-auto">
        <div className="space-y-4 py-4">
          <OutlineSection path={path} />
          <SimilarNotesSection path={path} />
        </div>
      </div>
    </div>
  )
}
