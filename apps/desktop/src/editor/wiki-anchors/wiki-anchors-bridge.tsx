import { useState } from 'react'
import { Priority } from '@meowdown/core'
import { useExtension, useKeymap } from '@meowdown/react'
import { todayIso } from '@/lib/dates.ts'
import { openUrlSync } from '@/lib/open-url.ts'
import { defineWikiAnchorChips, WIKI_ANCHORS_KEYMAP } from './wiki-anchor-chips.ts'

/**
 * Renders the surrounding editor's wiki `anchors` fences as source chips (see
 * {@link defineWikiAnchorChips}); links open in the system browser, and
 * markers are judged on today's date. Its keys run ahead of the base keymap,
 * whose arrows would skip a folded block and Delete/Backspace would join it.
 */
export function WikiAnchorsBridge(): null {
  const [extension] = useState(() =>
    defineWikiAnchorChips({ asOf: todayIso, openUrl: openUrlSync }),
  )
  useExtension(extension)
  useKeymap(WIKI_ANCHORS_KEYMAP, { priority: Priority.high })
  return null
}
