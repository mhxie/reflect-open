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

interface PinnedTagFilters {
  readonly tags: readonly string[]
  pinTag: (input: string) => void
  unpinTag: (tag: string) => void
  moveTag: (tag: string, move: PinnedTagMove) => void
  reorderTags: (original: readonly string[], next: readonly string[]) => void
}

/** Share validated, ordered filter preferences across All Notes and Settings. */
export function usePinnedTagFilters(): PinnedTagFilters {
  const { settings, updateSettingsWith } = useSettings()
  const tags = useMemo(
    () => normalizePinnedTags(settings.allNotesFilterTags),
    [settings.allNotesFilterTags],
  )

  const updateTags = (transform: (current: readonly string[]) => string[]): void => {
    updateSettingsWith((current) => {
      const before = normalizePinnedTags(current.allNotesFilterTags)
      const after = transform(before)
      return pinnedTagOrdersEqual(before, after) ? {} : { allNotesFilterTags: after }
    })
  }

  return {
    tags,
    pinTag: (input) => {
      const tag = normalizePinnedTag(input)
      if (tag !== null) {
        updateTags((current) => pinFilterTag(current, tag))
      }
    },
    unpinTag: (input) => {
      const tag = normalizePinnedTag(input)
      if (tag !== null) {
        updateTags((current) => unpinFilterTag(current, tag))
      }
    },
    moveTag: (input, move) => {
      const tag = normalizePinnedTag(input)
      if (tag !== null) {
        updateTags((current) => movePinnedFilterTag(current, tag, move))
      }
    },
    reorderTags: (original, next) =>
      updateTags((current) => reorderPinnedFilterTags(current, original, next)),
  }
}
