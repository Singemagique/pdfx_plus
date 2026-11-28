// Find's state machine, outside React: the open/closed bar, the debounced query, the ordered match
// list across the collection, the current match and navigation. Components read it through
// useSyncExternalStore with primitive (or identity-stable) snapshots, so a keystroke re-renders
// only the bar, and a new result set re-renders only the page cells whose status changed.

import type { Overlay } from '../edit/model'
import { makePageKey } from '../edit/model'
import { footprint } from '../pdfx/mirror'
import type { DocEntry, PageEntry } from '../types'
import { createFindEngine, type FindEngine, type PageMatches } from './engine'
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
  /** More matches exist than were listed (a page hit the engine's per-page limit). */
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
  /** The index's per-page text, for the OCR side (supply, Stage 0, Copy Page Text). */
  text: FindTextAccess
}

/**
 * What the OCR side reads and writes in Find's index, per page key (DESIGN.md §3.4.1, §3.6): the
 * recognised-text supplement, the native text (extracted once, shared with Find), a hook on every
 * native extraction (Stage 0 and Find's full-extraction trigger) and the effective page text
 * (native ∪ supplement, redaction-filtered: what Find searches and Copy Page Text copies).
 */
export type FindTextAccess = Pick<
  FindEngine,
  'setSupplement' | 'readNative' | 'onNativeText' | 'getPageText'
>

export interface FindControllerOptions {
  /** Builds the index (tests pass a fake); it must call `onChange` when results may differ. */
  createEngine?: (onChange: () => void) => FindEngine
  onNavigate: (match: FindMatch) => void
  /** The page a new search starts from (the full-view page, else the selected one). */
  getAnchorPageId: () => string | null
  debounceMs?: number
  throttleMs?: number
}

interface PageInfo {
  docId: string
  page: PageEntry
  pageKey: string
  order: number
}

/**
 * One matching page. Matches are never materialized as a flat list: match `i` of the collection is
 * found by binary search over the pages' `offset`s, so a common word over thousands of pages costs
 * one entry per page, and every match stays reachable.
 */
interface PageHits {
  info: PageInfo
  /** [start, end) pairs into the page's normalized text. */
  text: Int32Array
  /** Overlay hits, top of the page first. */
  overlays: PageMatches['overlays']
  count: number
  /** The collection-wide index of this page's first match. */
  offset: number
}

const EMPTY_HIGHLIGHTS: readonly PageHighlight[] = Object.freeze([])

export function createFindController({
  createEngine = (onChange) => createFindEngine({ onChange }),
  onNavigate,
  getAnchorPageId,
  debounceMs = 150,
  throttleMs = 120
}: FindControllerOptions): FindController {
  const listeners = new Set<() => void>()
  let isOpen = false
  let activated = false
  let raw = ''
  let query = ''
  let re: RegExp | null = null
  let docs: readonly DocEntry[] = []
  let pages = new Map<string, PageInfo>()
  let hits: PageHits[] = []
  /** pageId → index into `hits`. */
  let hitIndex = new Map<string, number>()
  let total = 0
  let current = -1
  let currentMatch: FindMatch | null = null
  let capped = false
  let version = 0
  let focusNonce = 0
  let debounce: ReturnType<typeof setTimeout> | null = null
  let throttle: ReturnType<typeof setTimeout> | null = null
  const highlightCache = new Map<string, { version: number; value: readonly PageHighlight[] }>()
  let overlays: readonly Overlay[] = []
  /**
   * Page key → its page height (page px), for turning redaction geoms into page-px boxes. Never
   * pruned: a key's height is fixed (sources are immutable), and keeping a removed page's height
   * keeps its redactions in the engine, as the engine's contract intends (kept until cleared).
   */
  const heights = new Map<string, number>()
  /** Page keys the engine currently holds redactions for. */
  let redactedKeys = new Set<string>()

  const engine = createEngine(() => scheduleRecompute())

  /**
   * Feed the engine every live page's redaction boxes (DESIGN.md §3.6.1): Find never reports text
   * the user has boxed out, matching what an export will contain. The box is the redaction's
   * rotation-aware footprint (mirror.ts, the same box export redacts). A page key never seen yet
   * has no known height and is skipped until it is. Cheap when nothing changed: the engine
   * ignores an unchanged set.
   */
  function syncRedactions(): void {
    const next = new Map<string, PageRect[]>()
    for (const o of overlays) {
      if (o.type !== 'redaction') continue
      const h = heights.get(o.pageKey)
      if (h === undefined) continue
      const f = footprint(o.geom)
      const rect = { x: f.x0, y: h - f.y1, w: f.x1 - f.x0, h: f.y1 - f.y0 }
      const list = next.get(o.pageKey)
      if (list) list.push(rect)
      else next.set(o.pageKey, [rect])
    }
    for (const key of redactedKeys) if (!next.has(key)) engine.setRedactions(key, null)
    for (const [key, rects] of next) engine.setRedactions(key, rects)
    redactedKeys = new Set(next.keys())
  }

  let barState: FindBarState = buildBar()

  function buildBar(): FindBarState {
    const { indexed, total: indexTotal } = engine.progress()
    return {
      open: isOpen,
      query,
      focusNonce,
      total,
      capped,
      currentIndex: current,
      pagesMatched: hits.length,
      indexing: activated && indexed < indexTotal,
      indexed,
      indexTotal
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

  /** The index into `hits` of the page holding match `i` (0 <= i < total). */
  function hitAt(i: number): number {
    let lo = 0
    let hi = hits.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (hits[mid].offset <= i) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  function matchAt(i: number): FindMatch | null {
    if (i < 0 || i >= total) return null
    const h = hits[hitAt(i)]
    const { info } = h
    const base = {
      docId: info.docId,
      pageId: info.page.id,
      pageKey: info.pageKey,
      order: info.order
    }
    const j = i - h.offset
    const nText = h.text.length / 2
    if (j < nText) return { ...base, kind: 'text', start: h.text[2 * j], end: h.text[2 * j + 1] }
    const o = h.overlays[j - nText]
    return { ...base, kind: 'overlay', start: o.start, end: o.end, overlayId: o.overlayId }
  }

  function setCurrent(i: number): void {
    current = i
    currentMatch = matchAt(i)
  }

  /** The index of a match equal to `m` (same page, kind, start and overlay) in the new hits, or -1. */
  function indexOfMatch(m: FindMatch): number {
    const hi = hitIndex.get(m.pageId)
    if (hi === undefined) return -1
    const h = hits[hi]
    if (m.kind === 'text') {
      for (let j = 0; j < h.text.length; j += 2) if (h.text[j] === m.start) return h.offset + j / 2
      return -1
    }
    const k = h.overlays.findIndex((o) => o.overlayId === m.overlayId && o.start === m.start)
    return k >= 0 ? h.offset + h.text.length / 2 + k : -1
  }

  /** The index into `hits` of the first matching page at or after position `order`. */
  function hitFrom(order: number): number {
    let lo = 0
    let hi = hits.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (hits[mid].info.order < order) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** The first match at or after page position `order`, else the first match (-1 if none). */
  function firstFrom(order: number): number {
    if (total === 0) return -1
    const k = hitFrom(order)
    return k < hits.length ? hits[k].offset : 0
  }

  /** The last match before page position `order`, else the last match (-1 if none). */
  function lastBefore(order: number): number {
    if (total === 0) return -1
    const k = hitFrom(order) - 1
    return k >= 0 ? hits[k].offset + hits[k].count - 1 : total - 1
  }

  function anchorOrder(): number {
    const anchor = getAnchorPageId()
    return anchor ? (pages.get(anchor)?.order ?? 0) : 0
  }

  /**
   * Where a new search starts: the first match reading on from the anchor page, wrapping to the
   * start. While indexing, a page on the way there may not be indexed yet and could hold a nearer
   * match, so this returns -1 (wait) until every page from the anchor up to the pick is indexed —
   * a search must not jump to page 1 just because the anchor's own page had not been read yet.
   */
  function freshPick(): number {
    if (total === 0) return -1
    const { indexed, total: all } = engine.progress()
    const from = anchorOrder()
    if (indexed >= all) return firstFrom(from)
    const list = [...pages.values()]
    const n = list.length
    const start = Math.min(Math.max(0, from), Math.max(0, n - 1))
    for (let step = 0; step < n; step++) {
      const info = list[(start + step) % n]
      if (!engine.getPageText(info.pageKey)) return -1
      const k = hitIndex.get(info.page.id)
      if (k !== undefined) return hits[k].offset
    }
    return -1
  }

  function navigate(): void {
    if (currentMatch) onNavigate(currentMatch)
  }

  /**
   * Rebuild the ordered match list. `fresh` (a new query, or reopening) picks the current match
   * from the anchor page and navigates to it; otherwise the current match is kept when it still
   * exists, and the view only moves when its page went away.
   */
  function recompute(fresh: boolean): void {
    if (!isOpen) return
    if (fresh) {
      // Index onwards from where this search starts, so its first pick is known soonest.
      const anchor = getAnchorPageId()
      const info = anchor ? pages.get(anchor) : undefined
      if (info) engine.prioritize(info.pageKey)
    }
    const prev = fresh ? null : currentMatch
    const results = query && re ? engine.search(query, re) : null
    const nextHits: PageHits[] = []
    const nextIndex = new Map<string, number>()
    let nextTotal = 0
    let nextCapped = false
    if (results) {
      const top = (id: string): number => {
        const g = engine.getOverlay(id)?.geom
        return g ? g.y + g.h : 0
      }
      for (const info of pages.values()) {
        const pm = results.get(info.pageKey)
        if (!pm) continue
        const overlays =
          pm.overlays.length > 1
            ? [...pm.overlays].sort((a, b) => top(b.overlayId) - top(a.overlayId))
            : pm.overlays
        const count = pm.text.length / 2 + overlays.length
        nextIndex.set(info.page.id, nextHits.length)
        nextHits.push({ info, text: pm.text, overlays, count, offset: nextTotal })
        nextTotal += count
        if (pm.capped) nextCapped = true
      }
    }
    hits = nextHits
    hitIndex = nextIndex
    total = nextTotal
    capped = nextCapped

    let nav = false
    if (prev) {
      const kept = indexOfMatch(prev)
      if (kept >= 0) setCurrent(kept)
      else {
        setCurrent(firstFrom(pages.get(prev.pageId)?.order ?? prev.order))
        nav = currentMatch !== null && currentMatch.pageId !== prev.pageId
      }
    } else {
      // A new query (or one still waiting for its first pick while indexing): start from the
      // anchor page.
      setCurrent(freshPick())
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
    setCurrent(-1)
    if (isOpen) recompute(true)
    else refreshBar()
    return true
  }

  function step(dir: 1 | -1): void {
    if (!isOpen) return
    if (flush()) return
    const n = total
    if (n === 0) return
    // No pick yet (still indexing towards it): step from the anchor page.
    if (current < 0) setCurrent(dir > 0 ? firstFrom(anchorOrder()) : lastBefore(anchorOrder()))
    else setCurrent((current + dir + n) % n)
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
      if (currentMatch?.pageId === pageId) return 'current'
      return hitIndex.has(pageId) ? 'hit' : null
    },
    getPageHighlights(pageId) {
      const hi = isOpen ? hitIndex.get(pageId) : undefined
      if (hi === undefined) return EMPTY_HIGHLIGHTS
      const cached = highlightCache.get(pageId)
      if (cached && cached.version === version) return cached.value
      const h = hits[hi]
      const out: PageHighlight[] = []
      const pt = engine.getPageText(h.info.pageKey)
      for (let j = 0; j < h.text.length; j += 2) {
        if (!pt) break
        const isCurrent = h.offset + j / 2 === current
        for (const rect of textMatchRects(pt, h.text[j], h.text[j + 1]))
          out.push({ rect, current: isCurrent })
      }
      const nText = h.text.length / 2
      h.overlays.forEach((o, k) => {
        const ov = engine.getOverlay(o.overlayId)
        const isCurrent = h.offset + nText + k === current
        if (ov) out.push({ rect: overlayRect(ov.geom, h.info.page.height), current: isCurrent })
      })
      const value = out.length ? out : EMPTY_HIGHLIGHTS
      highlightCache.set(pageId, { version, value })
      return value
    },
    getCurrentMatch: () => (isOpen ? currentMatch : null),
    open() {
      if (!activated) {
        activated = true
        // Index from the page the search will start at, so its matches come first.
        const anchor = getAnchorPageId()
        engine.activate(anchor ? pages.get(anchor)?.pageKey : undefined)
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
      hits = []
      hitIndex = new Map()
      total = 0
      setCurrent(-1)
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
      for (const d of next) {
        for (const p of d.pages) {
          const pageKey = makePageKey(p.source.id, p.pageIndex)
          map.set(p.id, { docId: d.id, page: p, pageKey, order: order++ })
          heights.set(pageKey, p.height)
        }
      }
      pages = map
      // Redactions BEFORE reconcile: a page that comes back (undo of a delete) may get its cached
      // text back synchronously, and a search may rerun right there; its boxes must already be
      // in place, or the redacted match is counted and navigated to for that moment.
      syncRedactions()
      engine.reconcile(next)
      if (isOpen && query) scheduleRecompute()
    },
    setOverlays(next) {
      overlays = next
      engine.setOverlays(next)
      syncRedactions()
    },
    cancelTimers() {
      clearDebounce()
      clearThrottle()
    },
    text: {
      setSupplement: (key, s) => engine.setSupplement(key, s),
      readNative: (key) => engine.readNative(key),
      onNativeText: (listener) => engine.onNativeText(listener),
      getPageText: (key) => engine.getPageText(key)
    }
  }
}
