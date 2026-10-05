import { useMemo } from 'react'
import {
  movePinnedFilterTag,
  normalizePinnedTag,
  normalizePinnedTags,
  pinFilterTag,
  pinnedTagOrdersEqual,
  reorderPinnedFilterTags,
  unpinFilterTag,
  type PinnedTagMove,
} from '@reflect/core'
import { useSettings } from '@/providers/settings-provider.tsx'

/**
 * The shared pin list and its edits. Each edit returns true only when it
 * changed the loaded preferences right away; an edit queued before settings
 * load, or one that leaves the current list as it is, returns false.
 */
interface PinnedTagFilters {
  readonly tags: readonly string[]
  pinTag: (input: string) => boolean
  unpinTag: (tag: string) => boolean
  moveTag: (tag: string, move: PinnedTagMove) => boolean
  reorderTags: (original: readonly string[], next: readonly string[]) => boolean
}

/** Share validated, ordered filter preferences across All Notes and Settings. */
export function usePinnedTagFilters(): PinnedTagFilters {
  const { settings, updateSettingsWith } = useSettings()
  const tags = useMemo(
    () => normalizePinnedTags(settings.allNotesFilterTags),
    [settings.allNotesFilterTags],
  )

  const updateTags = (transform: (current: readonly string[]) => string[]): boolean => {
    let changed = false
    updateSettingsWith((current) => {
      const before = normalizePinnedTags(current.allNotesFilterTags)
      const after = transform(before)
      changed = !pinnedTagOrdersEqual(before, after)
      return changed ? { allNotesFilterTags: after } : {}
    })
    return changed
  }

  return {
    tags,
    pinTag: (input) => {
      const tag = normalizePinnedTag(input)
      return tag !== null && updateTags((current) => pinFilterTag(current, tag))
    },
    unpinTag: (input) => {
      const tag = normalizePinnedTag(input)
      return tag !== null && updateTags((current) => unpinFilterTag(current, tag))
    },
    moveTag: (input, move) => {
      const tag = normalizePinnedTag(input)
      return tag !== null && updateTags((current) => movePinnedFilterTag(current, tag, move))
    },
    reorderTags: (original, next) =>
      updateTags((current) => reorderPinnedFilterTags(current, original, next)),
  }
}
