import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cachedRatio,
  persistRatios,
  ratioCacheFor,
  recordRatio,
  resetRatioCaches,
} from './attachment-ratio-cache.ts'

/** Runs in the browser project: the cache persists through real localStorage. */

const ROOT = '/graphs/ratio-test'
const STORAGE_KEY = `reflect.attachment-ratios:${ROOT}`
const GRAPHS_KEY = 'reflect.attachment-ratios.graphs'

function storageKeys(): string[] {
  return Object.keys(localStorage).filter((key) => key.startsWith('reflect.attachment-ratios'))
}

function clearStorage(): void {
  for (const key of storageKeys()) {
    localStorage.removeItem(key)
  }
}
const photo = { path: 'assets/photo.png', size: 100, modifiedMs: 5 }
let otherWindow: typeof import('./attachment-ratio-cache.ts') | undefined

async function isolatedWindow(): Promise<typeof import('./attachment-ratio-cache.ts')> {
  otherWindow = await vi.importActual<typeof import('./attachment-ratio-cache.ts')>(
    './attachment-ratio-cache.ts?window=other',
  )
  return otherWindow
}

function forgetMemory(): void {
  resetRatioCaches()
  otherWindow?.resetRatioCaches()
}

beforeEach(() => {
  forgetMemory()
  clearStorage()
})

afterEach(() => {
  forgetMemory()
  clearStorage()
})

describe('attachment ratio cache', () => {
  it('remembers a ratio only for the file version it was measured on', () => {
    const cache = ratioCacheFor(ROOT)

    expect(recordRatio(cache, photo, 0.5)).toBe(true)
    expect(recordRatio(cache, photo, 0.5)).toBe(false)

    expect(cachedRatio(cache, photo)).toBe(0.5)
    expect(cachedRatio(cache, { ...photo, size: 101 })).toBeUndefined()
    expect(cachedRatio(cache, { ...photo, modifiedMs: 6 })).toBeUndefined()
    expect(cachedRatio(cache, { ...photo, path: 'assets/other.png' })).toBeUndefined()
  })

  it('treats the same image measured at another thumbnail width as unchanged', () => {
    const cache = ratioCacheFor(ROOT)

    // A 3:2 portrait's thumbnails: 213 px tall at 320 wide, 427 at 640.
    expect(recordRatio(cache, photo, 213 / 320)).toBe(true)
    expect(recordRatio(cache, photo, 427 / 640)).toBe(false)
    expect(cachedRatio(cache, photo)).toBe(0.666)
    expect(recordRatio(cache, photo, 0.75)).toBe(true)
  })

  it('survives a relaunch through storage, per graph', () => {
    recordRatio(ratioCacheFor(ROOT), photo, 1.25)
    persistRatios(ROOT)
    forgetMemory()

    expect(cachedRatio(ratioCacheFor(ROOT), photo)).toBe(1.25)
    expect(cachedRatio(ratioCacheFor('/graphs/another'), photo)).toBeUndefined()
  })

  it('merges measurements from two windows that opened the same graph before either write', async () => {
    const other = await isolatedWindow()
    const firstCache = ratioCacheFor(ROOT)
    const secondCache = other.ratioCacheFor(ROOT)
    const secondPhoto = { ...photo, path: 'assets/second.png' }
    expect(firstCache).not.toBe(secondCache)

    recordRatio(firstCache, photo, 0.5)
    persistRatios(ROOT)
    other.recordRatio(secondCache, secondPhoto, 1.25)
    other.persistRatios(ROOT)

    expect(cachedRatio(secondCache, photo)).toBe(0.5)
    expect(cachedRatio(secondCache, secondPhoto)).toBe(1.25)
    persistRatios(ROOT)
    expect(cachedRatio(firstCache, secondPhoto)).toBe(1.25)
    forgetMemory()
    expect(cachedRatio(ratioCacheFor(ROOT), photo)).toBe(0.5)
    expect(cachedRatio(ratioCacheFor(ROOT), secondPhoto)).toBe(1.25)
  })

  it('refreshes stale windows without overwriting newer file versions or measurements', async () => {
    const other = await isolatedWindow()
    const firstCache = ratioCacheFor(ROOT)
    const secondCache = other.ratioCacheFor(ROOT)
    const updatedPhoto = { ...photo, modifiedMs: 6 }

    recordRatio(firstCache, photo, 0.5)
    other.recordRatio(secondCache, updatedPhoto, 1.25)
    other.persistRatios(ROOT)
    persistRatios(ROOT)

    expect(cachedRatio(firstCache, photo)).toBeUndefined()
    expect(cachedRatio(firstCache, updatedPhoto)).toBe(1.25)
    recordRatio(firstCache, updatedPhoto, 1.5)
    persistRatios(ROOT)
    other.persistRatios(ROOT)

    expect(cachedRatio(secondCache, updatedPhoto)).toBe(1.5)
    forgetMemory()
    expect(cachedRatio(ratioCacheFor(ROOT), updatedPhoto)).toBe(1.5)
  })

  it('keeps the record cap and write order when merging another window’s full cache', async () => {
    const other = await isolatedWindow()
    const firstCache = ratioCacheFor(ROOT)
    const secondCache = other.ratioCacheFor(ROOT)
    for (let index = 0; index < 2000; index++) {
      recordRatio(firstCache, { ...photo, path: `assets/${index}.png` }, 1)
    }
    persistRatios(ROOT)
    other.recordRatio(secondCache, photo, 0.5)
    other.persistRatios(ROOT)
    persistRatios(ROOT)

    expect(secondCache.size).toBe(2000)
    expect(firstCache.size).toBe(2000)
    expect(firstCache.has('assets/0.png')).toBe(false)
    expect(cachedRatio(firstCache, photo)).toBe(0.5)
    forgetMemory()
    expect(ratioCacheFor(ROOT).size).toBe(2000)
    expect(ratioCacheFor(ROOT).has('assets/0.png')).toBe(false)
    expect(cachedRatio(ratioCacheFor(ROOT), photo)).toBe(0.5)
  })

  it('starts empty when the stored value is malformed', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'assets/photo.png': ['wide', 100, 5] }))

    expect(ratioCacheFor(ROOT).size).toBe(0)
  })

  it('drops the least recently written records past its cap', () => {
    const cache = ratioCacheFor(ROOT)
    for (let index = 0; index <= 2000; index++) {
      recordRatio(cache, { path: `assets/${index}.png`, size: 1, modifiedMs: 1 }, 1)
    }

    expect(cache.size).toBe(2000)
    expect(cache.has('assets/0.png')).toBe(false)
    expect(cache.has('assets/2000.png')).toBe(true)
  })

  it('keeps stores for the three most recently persisted graphs only', () => {
    for (const root of ['/graphs/a', '/graphs/b', '/graphs/c', '/graphs/d']) {
      recordRatio(ratioCacheFor(root), photo, 1)
      persistRatios(root)
    }

    expect(storageKeys().sort()).toEqual([
      GRAPHS_KEY,
      'reflect.attachment-ratios:/graphs/b',
      'reflect.attachment-ratios:/graphs/c',
      'reflect.attachment-ratios:/graphs/d',
    ])
    expect(JSON.parse(localStorage.getItem(GRAPHS_KEY) ?? '[]')).toEqual([
      '/graphs/d',
      '/graphs/c',
      '/graphs/b',
    ])
    forgetMemory()
    expect(cachedRatio(ratioCacheFor('/graphs/a'), photo)).toBeUndefined()
    expect(cachedRatio(ratioCacheFor('/graphs/d'), photo)).toBe(1)
  })

  it('sees what other windows stored: evicts unlisted stores, keeps freshly listed ones', () => {
    // Another window stored /graphs/d and /graphs/e and listed them, and a
    // store it wrote under a stale order is listed nowhere.
    const stored = JSON.stringify({ 'assets/photo.png': [1, 100, 5] })
    localStorage.setItem('reflect.attachment-ratios:/graphs/d', stored)
    localStorage.setItem('reflect.attachment-ratios:/graphs/e', stored)
    localStorage.setItem('reflect.attachment-ratios:/graphs/orphan', stored)
    localStorage.setItem(GRAPHS_KEY, JSON.stringify(['/graphs/d', '/graphs/e']))

    recordRatio(ratioCacheFor('/graphs/a'), photo, 1)
    persistRatios('/graphs/a')

    expect(storageKeys().sort()).toEqual([
      GRAPHS_KEY,
      'reflect.attachment-ratios:/graphs/a',
      'reflect.attachment-ratios:/graphs/d',
      'reflect.attachment-ratios:/graphs/e',
    ])
  })

  it('keeps only the current graph when the order is corrupt, orphaning nothing', () => {
    localStorage.setItem('reflect.attachment-ratios:/graphs/b', JSON.stringify({}))
    localStorage.setItem(GRAPHS_KEY, 'not json')

    recordRatio(ratioCacheFor('/graphs/a'), photo, 1)
    persistRatios('/graphs/a')

    expect(storageKeys().sort()).toEqual([GRAPHS_KEY, 'reflect.attachment-ratios:/graphs/a'])
  })
})
