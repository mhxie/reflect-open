import { z } from 'zod'

/**
 * Loaded media shapes for the Attachments card flow, remembered per graph
 * across launches so the flow lays out at its final sizes on the first paint
 * instead of reflowing as each thumbnail decodes. A rebuildable UI cache, not
 * graph data: each record is valid only for the file version (size + mtime)
 * it was measured on, and losing the store just costs one reflow.
 *
 * Storage is read and written directly, not through a per-window memo: every
 * window of the app shares it, and each must see the others' writes.
 */

/** The fields of a library entry a record is keyed and validated on. */
export interface RatioSubject {
  readonly path: string
  readonly size: number
  readonly modifiedMs: number
}

interface RatioRecord {
  /** Height / width of the loaded media. */
  readonly ratio: number
  readonly size: number
  readonly modifiedMs: number
}

/** Per graph: path → record, in least-recently-written-first order. */
export type RatioCache = Map<string, RatioRecord>

/** Stored as `{ path: [ratio, size, modifiedMs] }` to keep the JSON small. */
const storedRatiosSchema = z.record(
  z.string(),
  z.tuple([z.number().positive(), z.number(), z.number()]),
)

/**
 * Records kept per graph (the least recently written go first past this),
 * and graphs kept (the least recently persisted lose their store): every
 * `reflect.*` key shares the webview origin's few-megabyte storage quota, so
 * the cache stays a bounded slice of it — about 150 KB per graph.
 */
const MAX_RECORDS = 2000
const MAX_GRAPHS = 3

/**
 * Measurements this close are the same shape: one image's thumbnails at
 * different widths round their heights differently. Stored ratios keep three
 * decimals, which is finer than any visible difference.
 */
const RATIO_TOLERANCE = 0.005
const RATIO_PRECISION = 1000

const STORE_PREFIX = 'reflect.attachment-ratios:'

/**
 * Graph roots, most recently persisted first: the eviction order for these
 * stores, and nothing more — not the app's recent-graphs list. Advisory: the
 * stored keys decide what exists.
 */
const GRAPH_ORDER_KEY = 'reflect.attachment-ratios.graphs'
const graphOrderSchema = z.array(z.string())

/** Writes wait this long after the last change, so a burst of loads is one write. */
const PERSIST_DELAY_MS = 1000

const caches = new Map<string, RatioCache>()
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingRecords = new WeakSet<RatioRecord>()

/**
 * Run `access` against localStorage, or return `fallback` where storage is
 * unavailable or refuses (a private window, the quota). Best-effort, as a
 * cache can afford to be.
 */
function withStorage<T>(access: (storage: Storage) => T, fallback: T): T {
  try {
    return access(window.localStorage)
  } catch {
    return fallback
  }
}

/** Parse a stored JSON value against `schema`; undefined when missing or malformed. */
function readJson<T>(storage: Storage, key: string, schema: z.ZodType<T>): T | undefined {
  const result = schema.safeParse(JSON.parse(storage.getItem(key) ?? 'null'))
  return result.success ? result.data : undefined
}

/** The roots of every graph with a stored cache. */
function storedGraphRoots(): string[] {
  return withStorage(
    (storage) =>
      Object.keys(storage)
        .filter((key) => key.startsWith(STORE_PREFIX))
        .map((key) => key.slice(STORE_PREFIX.length)),
    [],
  )
}

/** A cache that remembers nothing past this session, for when no graph is open. */
export function emptyRatioCache(): RatioCache {
  return new Map<string, RatioRecord>()
}

function readStoredRatios(graphRoot: string): RatioCache {
  const stored =
    withStorage(
      (storage) => readJson(storage, `${STORE_PREFIX}${graphRoot}`, storedRatiosSchema),
      undefined,
    ) ?? {}
  return new Map(
    Object.entries(stored).map(([path, [ratio, size, modifiedMs]]) => [
      path,
      { ratio, size, modifiedMs },
    ]),
  )
}

function trimRatioCache(cache: RatioCache): void {
  for (const path of cache.keys()) {
    if (cache.size <= MAX_RECORDS) {
      break
    }
    cache.delete(path)
  }
}

/** The graph's ratio cache, read from storage on first use. */
export function ratioCacheFor(graphRoot: string): RatioCache {
  const existing = caches.get(graphRoot)
  if (existing !== undefined) {
    return existing
  }
  const cache = readStoredRatios(graphRoot)
  caches.set(graphRoot, cache)
  return cache
}

/** The remembered ratio for this version of the file, if any. */
export function cachedRatio(cache: RatioCache, subject: RatioSubject): number | undefined {
  const record = cache.get(subject.path)
  return record !== undefined &&
    record.size === subject.size &&
    record.modifiedMs === subject.modifiedMs
    ? record.ratio
    : undefined
}

/** Remember a measured ratio; returns whether anything changed. */
export function recordRatio(cache: RatioCache, subject: RatioSubject, measured: number): boolean {
  const ratio = Math.round(measured * RATIO_PRECISION) / RATIO_PRECISION
  const known = cachedRatio(cache, subject)
  if (ratio <= 0 || (known !== undefined && Math.abs(known - ratio) < RATIO_TOLERANCE)) {
    return false
  }
  // Re-insert so the map's order stays least-recently-written first.
  cache.delete(subject.path)
  const record = { ratio, size: subject.size, modifiedMs: subject.modifiedMs }
  cache.set(subject.path, record)
  pendingRecords.add(record)
  trimRatioCache(cache)
  return true
}

/** Merge other windows' measurements and write the graph's cache to storage now. */
export function persistRatios(graphRoot: string): void {
  const timer = persistTimers.get(graphRoot)
  if (timer !== undefined) {
    clearTimeout(timer)
    persistTimers.delete(graphRoot)
  }
  const cache = caches.get(graphRoot)
  if (cache === undefined) {
    return
  }
  const merged = new Map(cache)
  for (const [path, storedRecord] of readStoredRatios(graphRoot)) {
    const localRecord = cache.get(path)
    if (
      localRecord !== undefined &&
      (localRecord.modifiedMs > storedRecord.modifiedMs ||
        (localRecord.modifiedMs === storedRecord.modifiedMs && pendingRecords.has(localRecord)))
    ) {
      continue
    }
    merged.delete(path)
    merged.set(path, storedRecord)
  }
  for (const [path, record] of cache) {
    if (pendingRecords.has(record) && merged.get(path) === record) {
      merged.delete(path)
      merged.set(path, record)
    }
  }
  trimRatioCache(merged)
  cache.clear()
  for (const [path, record] of merged) {
    cache.set(path, record)
  }
  const stored: z.infer<typeof storedRatiosSchema> = {}
  for (const [path, record] of cache) {
    stored[path] = [record.ratio, record.size, record.modifiedMs]
  }
  const order = [
    graphRoot,
    ...(
      withStorage((storage) => readJson(storage, GRAPH_ORDER_KEY, graphOrderSchema), undefined) ??
      []
    ).filter((root) => root !== graphRoot),
  ].slice(0, MAX_GRAPHS)
  const kept = new Set(order)
  const persisted = withStorage((storage) => {
    // Evict first, so a store near the quota makes room before the write.
    for (const root of storedGraphRoots()) {
      if (!kept.has(root)) {
        storage.removeItem(`${STORE_PREFIX}${root}`)
        caches.delete(root)
      }
    }
    storage.setItem(`${STORE_PREFIX}${graphRoot}`, JSON.stringify(stored))
    storage.setItem(GRAPH_ORDER_KEY, JSON.stringify(order))
    return true
  }, false)
  if (persisted) {
    for (const record of cache.values()) {
      pendingRecords.delete(record)
    }
  }
}

/** Write the graph's cache once changes have settled. */
export function schedulePersistRatios(graphRoot: string): void {
  const timer = persistTimers.get(graphRoot)
  if (timer !== undefined) {
    clearTimeout(timer)
  }
  persistTimers.set(
    graphRoot,
    setTimeout(() => persistRatios(graphRoot), PERSIST_DELAY_MS),
  )
}

/** Test seam: forget every in-memory cache and pending write. */
export function resetRatioCaches(): void {
  for (const timer of persistTimers.values()) {
    clearTimeout(timer)
  }
  persistTimers.clear()
  caches.clear()
}
