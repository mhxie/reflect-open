import { useEffect, useRef, useState } from 'react'
import { Priority } from '@meowdown/core'
import { useExtension, useKeymap } from '@meowdown/react'
import { todayIso } from '@/lib/dates.ts'
import { openUrlSync } from '@/lib/open-url.ts'
import { defineWikiAnchorChips, WIKI_ANCHORS_KEYMAP } from './wiki-anchor-chips.ts'
import type { WikiEvidenceOptions } from './wiki-evidence.ts'

interface WikiAnchorsBridgeProps {
  readonly onWikiLinkClick: NonNullable<WikiEvidenceOptions['openWikiLink']>
}

/**
 * Renders the surrounding editor's wiki evidence as numbered references (see
 * {@link defineWikiAnchorChips}); links open in the system browser, and
 * markers are judged on today's date. Its keys run ahead of the base keymap,
 * whose arrows would skip a folded block and Delete/Backspace would join it.
 */
export function WikiAnchorsBridge({ onWikiLinkClick }: WikiAnchorsBridgeProps): null {
  const navigateRef = useRef(onWikiLinkClick)
  useEffect(() => {
    navigateRef.current = onWikiLinkClick
  })
  const [extension] = useState(() =>
    defineWikiAnchorChips({
      asOf: todayIso,
      openUrl: openUrlSync,
      openWikiLink: (options) => navigateRef.current(options),
    }),
  )
  useExtension(extension)
  useKeymap(WIKI_ANCHORS_KEYMAP, { priority: Priority.high })
  return null
}
