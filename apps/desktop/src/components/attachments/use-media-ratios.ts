import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  cachedRatio,
  emptyRatioCache,
  ratioCacheFor,
  recordRatio,
  schedulePersistRatios,
  type RatioCache,
  type RatioSubject,
} from './attachment-ratio-cache.ts'

export interface MediaRatios {
  /**
   * The file's loaded media ratio (height / width), if this version of it has
   * reported one. Its identity changes whenever a ratio does, so a layout can
   * depend on it.
   */
  readonly ratioOf: (subject: RatioSubject) => number | undefined
  /**
   * Record loaded media's natural size. Reports landing in the same frame
   * coalesce into one update, so thumbnails streaming in cost one relayout
   * per frame rather than one each.
   */
  readonly report: (subject: RatioSubject, width: number, height: number) => void
}

function readerFor(cache: RatioCache): MediaRatios['ratioOf'] {
  return (subject) => cachedRatio(cache, subject)
}

/** Media ratios for laying out the graph's Attachments card flow (see `attachment-ratio-cache`). */
export function useMediaRatios(graphRoot: string | null): MediaRatios {
  const cache = useMemo(
    () => (graphRoot === null ? emptyRatioCache() : ratioCacheFor(graphRoot)),
    [graphRoot],
  )
  const [reader, setReader] = useState(() => ({ cache, ratioOf: readerFor(cache) }))
  // A new graph swaps the cache; adjust the reader during render, not in an effect.
  if (reader.cache !== cache) {
    setReader({ cache, ratioOf: readerFor(cache) })
  }

  const frame = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current)
      }
    },
    [],
  )
  const report = useCallback(
    (subject: RatioSubject, width: number, height: number) => {
      if (width <= 0 || height <= 0 || !recordRatio(cache, subject, height / width)) {
        return
      }
      if (graphRoot !== null) {
        schedulePersistRatios(graphRoot)
      }
      if (frame.current === null) {
        frame.current = requestAnimationFrame(() => {
          frame.current = null
          setReader({ cache, ratioOf: readerFor(cache) })
        })
      }
    },
    [cache, graphRoot],
  )
  return { ratioOf: reader.ratioOf, report }
}
