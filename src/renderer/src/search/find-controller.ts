// Find's state machine, outside React: the open/closed bar, the debounced query, the ordered match
// list across the collection, the current match and navigation. Components read it through
// useSyncExternalStore with primitive (or identity-stable) snapshots, so a keystroke re-renders
// only the bar, and a new result set re-renders only the page cells whose status changed.

import type { Overlay } from '../edit/model'
import { makePageKey } from '../edit/model'
import type { DocEntry, PageEntry } from '../types'
import { createFindEngine, type FindEngine } from './engine'
import { overlayRect, textMatchRects, type PageRect } from './geometry'
import { compileQuery, normalizeQuery } from './normalize'

export interface FindMatch {
  docId: string
  pageId: string
  pageKey: string
  /** The page's position in the collection (documents in order, then pages). */
  order: number
  kind: 'text' | 'overlay'
  start: number
  end: number
  overlayId?: string
}

export interface PageHighlight {
  rect: PageRect
  current: boolean
}

export interface FindBarState {
  open: boolean
  /** The committed, normalized query ('' = nothing to search). */
  query: string
  /** Bumped whenever the bar should (re)focus and select its input. */
  focusNonce: number
  total: number
  /** More matches exist than were listed. */
  capped: boolean
  /** Index of the current match, -1 for none. */
  currentIndex: number
  pagesMatched: number
  /** Text extraction has not reached every page yet. */
  indexing: boolean
  indexed: number
  indexTotal: number
}

export type PageFindStatus = 'current' | 'hit' | null

export interface FindController {
  subscribe(listener: () => void): () => void
  getBarState(): FindBarState
  /** The raw text last typed into the bar (kept across close/reopen). */
  getRawQuery(): string
  getPageStatus(pageId: string): PageFindStatus
  getPageHighlights(pageId: string): readonly PageHighlight[]
  getCurrentMatch(): FindMatch | null
  open(): void
  close(): void
  setQuery(raw: string): void
  /** Commit a pending (debounced) query now; true when that changed the query. */
  flush(): boolean
  next(): void
  prev(): void
  setDocs(docs: readonly DocEntry[]): void
  setOverlays(overlays: readonly Overlay[]): void
  cancelTimers(): void
}

export interface FindControllerOptions {
  /** Builds the index (tests pass a fake); it must call `onChange` when results may differ. */
  createEngine?: (onChange: () => void) => FindEngine
  onNavigate: (match: FindMatch) => void
  /** The page a new search starts from (the full-view page, else the selected one). */
  getAnchorPageId: () => string | null
  debounceMs?: number
  throttleMs?: number
  maxMatches?: number
}

interface PageInfo {
  docId: string
  page: PageEntry
  order: number
}

const EMPTY_HIGHLIGHTS: readonly PageHighlight[] = Object.freeze([])

const sameMatch = (a: FindMatch, b: FindMatch): boolean =>
  a.pageId === b.pageId && a.kind === b.kind && a.start === b.start && a.overlayId === b.overlayId

export function createFindController({
  createEngine = (onChange) => createFindEngine({ onChange }),
  onNavigate,
  getAnchorPageId,
  debounceMs = 150,
  throttleMs = 120,
  maxMatches = 5000
}: FindControllerOptions): FindController {
  const listeners = new Set<() => void>()
  let isOpen = false
  let activated = false
  let raw = ''
  let query = ''
  let re: RegExp | null = null
  let docs: readonly DocEntry[] = []
  let pages = new Map<string, PageInfo>()
  let ordered: FindMatch[] = []
  let byPage = new Map<string, number[]>()
  let current = -1
  let capped = false
  let version = 0
  let focusNonce = 0
  let debounce: ReturnType<typeof setTimeout> | null = null
  let throttle: ReturnType<typeof setTimeout> | null = null
  const highlightCache = new Map<string, { version: number; value: readonly PageHighlight[] }>()

  const engine = createEngine(() => scheduleRecompute())

  let barState: FindBarState = buildBar()

  function buildBar(): FindBarState {
    const { indexed, total } = engine.progress()
    return {
      open: isOpen,
      query,
      focusNonce,
      total: ordered.length,
      capped,
      currentIndex: current,
      pagesMatched: byPage.size,
      indexing: activated && indexed < total,
      indexed,
      indexTotal: total
    }
  }

  function refreshBar(): void {
    const next = buildBar()
    const prev = barState
    for (const k of Object.keys(next) as Array<keyof FindBarState>) {
      if (next[k] !== prev[k]) {
        barState = next
        return
      }
    }
  }

  function notify(): void {
    refreshBar()
    for (const l of [...listeners]) l()
  }

  function clearDebounce(): void {
    if (debounce) clearTimeout(debounce)
    debounce = null
  }

  function clearThrottle(): void {
    if (throttle) clearTimeout(throttle)
    throttle = null
  }

  function scheduleRecompute(): void {
    if (!isOpen) return
    const { indexed, total } = engine.progress()
    if (indexed >= total) {
      clearThrottle()
      recompute(false)
      return
    }
    if (throttle) return
    throttle = setTimeout(() => {
      throttle = null
      recompute(false)
    }, throttleMs)
  }

  function navigate(): void {
    const m = ordered[current]
    if (m) onNavigate(m)
  }

  /** The first match at or after page position `order`, else the first match (-1 if none). */
  function firstFrom(order: number): number {
    if (ordered.length === 0) return -1
    const i = ordered.findIndex((m) => m.order >= order)
    return i >= 0 ? i : 0
  }

  /**
   * Rebuild the ordered match list. `fresh` (a new query, or reopening) picks the current match
   * from the anchor page and navigates to it; otherwise the current match is kept when it still
   * exists, and the view only moves when its page went away.
   */
  function recompute(fresh: boolean): void {
    if (!isOpen) return
    const prev = fresh ? null : (ordered[current] ?? null)
    const results = query && re ? engine.search(query, re) : null
    const nextOrdered: FindMatch[] = []
    const nextByPage = new Map<string, number[]>()
    let nextCapped = false
    if (results) {
      for (const info of pages.values()) {
        const pageKey = makePageKey(info.page.source.id, info.page.pageIndex)
        const pm = results.get(pageKey)
        if (!pm) continue
        const indices: number[] = []
        nextByPage.set(info.page.id, indices)
        const base = { docId: info.docId, pageId: info.page.id, pageKey, order: info.order }
        const push = (m: FindMatch): void => {
          if (nextOrdered.length >= maxMatches) {
            nextCapped = true
            return
          }
          indices.push(nextOrdered.length)
          nextOrdered.push(m)
        }
        for (let i = 0; i < pm.text.length; i += 2) {
          push({ ...base, kind: 'text', start: pm.text[i], end: pm.text[i + 1] })
        }
        const top = (id: string): number => {
          const g = engine.getOverlay(id)?.geom
          return g ? g.y + g.h : 0
        }
        const ovs = [...pm.overlays].sort((a, b) => top(b.overlayId) - top(a.overlayId))
        for (const o of ovs) {
          push({ ...base, kind: 'overlay', start: o.start, end: o.end, overlayId: o.overlayId })
        }
      }
    }
    ordered = nextOrdered
    byPage = nextByPage
    capped = nextCapped

    let nav = false
    if (prev) {
      const kept = ordered.findIndex((m) => sameMatch(m, prev))
      if (kept >= 0) current = kept
      else {
        current = firstFrom(pages.get(prev.pageId)?.order ?? prev.order)
        nav = current >= 0 && ordered[current].pageId !== prev.pageId
      }
    } else {
      // A new query (or the first matches of one still indexing): start from the anchor page.
      const anchor = getAnchorPageId()
      current = firstFrom(anchor ? (pages.get(anchor)?.order ?? 0) : 0)
      nav = current >= 0
    }
    version++
    notify()
    if (nav) navigate()
  }

  function commitQuery(): boolean {
    clearDebounce()
    const norm = normalizeQuery(raw)
    if (norm === query) return false
    query = norm
    re = compileQuery(norm)
    current = -1
    ordered = []
    if (isOpen) recompute(true)
    else refreshBar()
    return true
  }

  function step(dir: 1 | -1): void {
    if (!isOpen) return
    if (flush()) return
    const n = ordered.length
    if (n === 0) return
    current = current < 0 ? (dir > 0 ? 0 : n - 1) : (current + dir + n) % n
    version++
    notify()
    navigate()
  }

  function flush(): boolean {
    return debounce ? commitQuery() : false
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getBarState: () => barState,
    getRawQuery: () => raw,
    getPageStatus(pageId) {
      if (!isOpen) return null
      if (ordered[current]?.pageId === pageId) return 'current'
      return byPage.has(pageId) ? 'hit' : null
    },
    getPageHighlights(pageId) {
      const indices = isOpen ? byPage.get(pageId) : undefined
      if (!indices || indices.length === 0) return EMPTY_HIGHLIGHTS
      const cached = highlightCache.get(pageId)
      if (cached && cached.version === version) return cached.value
      const info = pages.get(pageId)
      const out: PageHighlight[] = []
      for (const i of indices) {
        const m = ordered[i]
        const isCurrent = i === current
        if (m.kind === 'text') {
          const pt = engine.getPageText(m.pageKey)
          if (!pt) continue
          for (const rect of textMatchRects(pt, m.start, m.end))
            out.push({ rect, current: isCurrent })
        } else if (m.overlayId && info) {
          const ov = engine.getOverlay(m.overlayId)
          if (ov) out.push({ rect: overlayRect(ov.geom, info.page.height), current: isCurrent })
        }
      }
      const value = out.length ? out : EMPTY_HIGHLIGHTS
      highlightCache.set(pageId, { version, value })
      return value
    },
    getCurrentMatch: () => (isOpen ? (ordered[current] ?? null) : null),
    open() {
      if (!activated) {
        activated = true
        engine.activate()
      }
      focusNonce++
      if (isOpen) {
        notify()
        return
      }
      isOpen = true
      // A query typed just before closing may not have been committed yet.
      clearDebounce()
      const norm = normalizeQuery(raw)
      if (norm !== query) {
        query = norm
        re = compileQuery(norm)
      }
      if (query) recompute(true)
      else notify()
    },
    close() {
      if (!isOpen) return
      isOpen = false
      clearDebounce()
      clearThrottle()
      ordered = []
      byPage = new Map()
      current = -1
      capped = false
      highlightCache.clear()
      version++
      notify()
    },
    setQuery(next) {
      raw = next
      clearDebounce()
      debounce = setTimeout(() => {
        debounce = null
        commitQuery()
      }, debounceMs)
    },
    flush,
    next: () => step(1),
    prev: () => step(-1),
    setDocs(next) {
      if (next === docs) return
      docs = next
      const map = new Map<string, PageInfo>()
      let order = 0
      for (const d of next)
        for (const p of d.pages) map.set(p.id, { docId: d.id, page: p, order: order++ })
      pages = map
      engine.reconcile(next)
      if (isOpen && query) scheduleRecompute()
    },
    setOverlays(overlays) {
      engine.setOverlays(overlays)
    },
    cancelTimers() {
      clearDebounce()
      clearThrottle()
    }
  }
}
