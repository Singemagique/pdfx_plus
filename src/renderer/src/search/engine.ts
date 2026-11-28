// The text index behind Find: per-page extracted text (cached by page key — sources are
// immutable, so a page keeps its text across reorders and moves), the user's own text overlays,
// and a per-query match cache. Extraction is lazy (nothing runs before activate()), incremental
// (onChange fires as pages land) and bounded (a few pages at a time, because every document shares
// one pdf.js worker with thumbnail rendering).

//
// On top of the extraction, per page KEY (so two duplicates of one page never share them):
// - a SUPPLEMENT (recognised text, DESIGN.md §3.6.1): appended to the native items, or replacing
//   them (an `ocr-ours` page after Replace / Remove);
// - REDACTIONS: boxes whose text is filtered out of native and supplement items alike at build
//   time (redact-filter.ts), so what Find reports matches what an export will contain.
// The page's effective text is buildPageText(filter(native ∪ supplement)) with the page's own
// viewport transform. The stored extraction stays write-once and is never mutated: dropping a
// supplement or a redaction brings the original text back.

import type { Geom, Overlay } from '../edit/model'
import { makePageKey } from '../edit/model'
import { stripRedactedOverlays } from '../pdfx/mirror'
import type { DocEntry, PdfSource } from '../types'
import {
  asPageTextItem,
  buildPageText,
  EMPTY_PAGE_TEXT,
  extractPageText,
  type PageText,
  type PageTextItem
} from './extract'
import type { PageRect } from './geometry'
import { findAll, normalizeQuery } from './normalize'
import { filterRedacted, normalizeRect } from './redact-filter'

/**
 * Recognised text for one page key, as PageTextItems in the page's pdf.js user space
 * (ocr/to-page-text.ts). `append`: after the native text; `replace`: instead of it.
 */
export interface PageSupplement {
  mode: 'append' | 'replace'
  items: readonly PageTextItem[]
}

/** Matches on one page key: text pairs into PageText.norm, and overlay hits. */
export interface PageMatches {
  /** [start, end) pairs into the page's normalized text. */
  text: Int32Array
  overlays: { overlayId: string; start: number; end: number }[]
  /** More matches exist on the page than were kept (the per-page limit was hit). */
  capped: boolean
}

export interface OverlayText {
  overlayId: string
  pageKey: string
  norm: string
  geom: Geom
}

export interface FindEngine {
  /**
   * Start indexing (idempotent). Before this, nothing is ever extracted. `first` (a page key) is
   * indexed first, then the pages after it, then the rest (see prioritize).
   */
  activate(first?: string): void
  /**
   * Reorder the pending queue to run from page key `key` onwards, in collection order, wrapping
   * to the start: the pages a search starting at `key` reaches first are indexed first.
   */
  prioritize(key: string): void
  /** Track the live pages: drop removed ones, queue new ones (once active). */
  reconcile(docs: readonly DocEntry[]): void
  /**
   * Track the searchable overlay texts (a no-op for the same array). A text or form value a
   * redaction covers (drawn above it, footprints touching: what export drops) is not searchable.
   */
  setOverlays(overlays: readonly Overlay[]): void
  /** Matches per live page key for a normalized query and its compiled regex. */
  search(norm: string, re: RegExp): ReadonlyMap<string, PageMatches | null>
  /**
   * Set (or clear, with null) a page key's recognised text. Ignored for a key that is not live
   * (a late result for a removed page); dropped by reconcile when its key goes, so the supplier
   * re-supplies a key that comes back. Searchable once the key's native text is indexed (its
   * viewport transform comes from there).
   */
  setSupplement(pageKey: string, supplement: PageSupplement | null): void
  /**
   * Set (or clear, with null or []) the redaction boxes of a page key, in page px (the frame
   * textMatchRects returns). Kept until cleared, whether or not the key is live: forgetting a box
   * would make redacted text findable again, keeping a stale one only hides text.
   */
  setRedactions(pageKey: string, rects: readonly PageRect[] | null): void
  progress(): { indexed: number; total: number }
  /** The page's effective text: native ∪ supplement, redaction-filtered. */
  getPageText(pageKey: string): PageText | undefined
  getOverlay(overlayId: string): OverlayText | undefined
}

export interface FindEngineOptions {
  onChange: () => void
  extract?: (pdf: PdfSource['pdf'], pageIndex: number) => Promise<PageText>
  concurrency?: number
  /** Most matches kept per page. */
  perPageLimit?: number
  /** The matcher (injectable so tests can count work). */
  match?: typeof findAll
}

const EMPTY_PAIRS = new Int32Array(0)

/** The visible text an overlay contributes to search, or null. */
function overlaySearchText(o: Overlay): string | null {
  if (o.type === 'text') return o.text
  // Text fields and choice values. Checkbox booleans and radio export names aren't visible text.
  if (o.type === 'formValue' && typeof o.value === 'string' && o.control !== 'radio') return o.value
  return null
}

export function createFindEngine({
  onChange,
  extract = extractPageText,
  concurrency = 2,
  perPageLimit = 1000,
  match = findAll
}: FindEngineOptions): FindEngine {
  let active = false
  /** Live page keys → where to extract them from, in collection order. */
  let live = new Map<string, { pdf: PdfSource['pdf']; pageIndex: number }>()
  /** Live page key → its position in collection order (first occurrence). */
  let liveOrder = new Map<string, number>()
  const texts = new Map<string, PageText>()
  /**
   * Extraction dedupe across page keys that share a proxy (duplicated pages). Released in
   * reconcile once no live page uses the proxy, so a removed document's text is not kept alive by
   * a proxy that undo history (or anything else) still references.
   */
  const byProxy = new Map<object, Map<number, PageText | Promise<PageText>>>()
  const queue: string[] = []
  const queued = new Set<string>()
  /** Keys with an extraction (or a wait on a shared one) still outstanding → how many. */
  const outstanding = new Map<string, number>()
  let inFlight = 0
  const warned = new Set<string>()

  let lastOverlays: readonly Overlay[] | null = null
  const overlayNorm = new WeakMap<Overlay, string>()
  let overlayRefs = new Map<string, Overlay[]>()
  let overlayTexts = new Map<string, OverlayText[]>()
  let overlayById = new Map<string, OverlayText>()

  const supplements = new Map<string, PageSupplement>()
  const redactions = new Map<string, PageRect[]>()
  /** Effective texts of keys with a supplement or redactions, built on first use. */
  const derived = new Map<string, PageText>()

  let cache: { query: string; perKey: Map<string, PageMatches | null> } | null = null

  const invalidate = (key: string): void => {
    cache?.perKey.delete(key)
    derived.delete(key)
  }

  const store = (key: string, result: PageText): boolean => {
    // A stale completion for a source that has since been removed must not resurrect it. A key
    // that was removed and re-added meanwhile is fine: sources are immutable, so its text is too.
    if (!live.has(key) || texts.has(key)) return false
    texts.set(key, result)
    invalidate(key)
    return true
  }

  /** The effective text of a key (undefined until its native text is indexed). */
  function pageText(key: string): PageText | undefined {
    const native = texts.get(key)
    if (!native) return undefined
    const sup = supplements.get(key)
    const red = redactions.get(key)
    if (!sup && !red) return native
    const built = derived.get(key)
    if (built) return built
    let items: readonly PageTextItem[] = native.items.map(asPageTextItem)
    if (sup?.mode === 'replace') items = sup.items
    else if (sup && sup.items.length > 0) {
      // The native text's last line ends before the recognised text starts, even when pdf.js
      // left the last item open (same baseline: the two must still not run together).
      const base = items.slice()
      const last = base[base.length - 1]
      if (last && !last.hasEOL) base[base.length - 1] = { ...last, hasEOL: true }
      items = [...base, ...sup.items]
    }
    const pt = buildPageText(filterRedacted(items, red, native.vt), native.vt)
    derived.set(key, pt)
    return pt
  }

  function setSupplement(key: string, s: PageSupplement | null): void {
    if (s === null) {
      if (!supplements.delete(key)) return
    } else {
      if (!live.has(key) || supplements.get(key) === s) return
      supplements.set(key, s)
    }
    invalidate(key)
    onChange()
  }

  const sameRects = (a: readonly PageRect[], b: readonly PageRect[]): boolean =>
    a.length === b.length &&
    a.every((r, i) => r.x === b[i].x && r.y === b[i].y && r.w === b[i].w && r.h === b[i].h)

  function setRedactions(key: string, rects: readonly PageRect[] | null): void {
    const next = rects && rects.length > 0 ? rects.map(normalizeRect) : null
    const prev = redactions.get(key)
    if (!next) {
      if (!prev) return
      redactions.delete(key)
    } else {
      if (prev && sameRects(prev, next)) return
      redactions.set(key, next)
    }
    invalidate(key)
    onChange()
  }

  const settle = (key: string, promise: Promise<PageText>, counted: boolean): void => {
    outstanding.set(key, (outstanding.get(key) ?? 0) + 1)
    void promise.then((result) => {
      if (counted) inFlight--
      const n = (outstanding.get(key) ?? 1) - 1
      if (n > 0) outstanding.set(key, n)
      else outstanding.delete(key)
      store(key, result)
      pump()
      onChange()
    })
  }

  const enqueue = (key: string): void => {
    if (texts.has(key) || queued.has(key) || outstanding.has(key)) return
    queue.push(key)
    queued.add(key)
  }

  function pump(): void {
    let changed = false
    while (inFlight < concurrency && queue.length > 0) {
      const key = queue.shift()!
      queued.delete(key)
      const entry = live.get(key)
      if (!entry) continue
      const { pdf, pageIndex } = entry
      if (!pdf || typeof pdf !== 'object') {
        changed = store(key, EMPTY_PAGE_TEXT) || changed
        continue
      }
      let perProxy = byProxy.get(pdf)
      if (!perProxy) byProxy.set(pdf, (perProxy = new Map()))
      const known = perProxy.get(pageIndex)
      if (known && !(known instanceof Promise)) {
        changed = store(key, known) || changed
        continue
      }
      if (known) {
        settle(key, known, false)
        continue
      }
      inFlight++
      let started: Promise<PageText>
      try {
        started = Promise.resolve(extract(pdf, pageIndex))
      } catch (err) {
        started = Promise.reject(err)
      }
      const promise = started.catch((err: unknown) => {
        if (!warned.has(key)) {
          warned.add(key)
          console.warn(`Find: could not read the text of page ${pageIndex + 1}`, err)
        }
        return EMPTY_PAGE_TEXT
      })
      const slot = perProxy
      slot.set(pageIndex, promise)
      void promise.then((result) => {
        if (slot.get(pageIndex) === promise) slot.set(pageIndex, result)
      })
      settle(key, promise, true)
    }
    if (changed) onChange()
  }

  function prioritize(key: string): void {
    const at = liveOrder.get(key)
    if (at === undefined || queue.length < 2) return
    const pos = (k: string): number => liveOrder.get(k) ?? Number.MAX_SAFE_INTEGER
    queue.sort((a, b) => pos(a) - pos(b))
    const i = queue.findIndex((k) => pos(k) >= at)
    if (i > 0) queue.push(...queue.splice(0, i))
  }

  function reconcile(docs: readonly DocEntry[]): void {
    const next = new Map<string, { pdf: PdfSource['pdf']; pageIndex: number }>()
    const order = new Map<string, number>()
    const proxies = new Set<object>()
    for (const d of docs) {
      for (const p of d.pages) {
        const key = makePageKey(p.source.id, p.pageIndex)
        if (next.has(key)) continue
        order.set(key, order.size)
        next.set(key, { pdf: p.source.pdf, pageIndex: p.pageIndex })
        if (p.source.pdf && typeof p.source.pdf === 'object') proxies.add(p.source.pdf)
      }
    }
    live = next
    liveOrder = order
    // An in-flight extraction of a released proxy still settles its own keys (store() drops them
    // if they are no longer live); only the shared slot goes.
    for (const proxy of [...byProxy.keys()]) if (!proxies.has(proxy)) byProxy.delete(proxy)
    let dropped = false
    for (const key of [...texts.keys()]) {
      if (!live.has(key)) {
        texts.delete(key)
        invalidate(key)
        dropped = true
      }
    }
    // A removed page's recognised text goes with it (the supplier re-supplies it if it returns).
    // Its redactions stay until cleared (see setRedactions).
    for (const key of [...supplements.keys()]) {
      if (!live.has(key)) {
        supplements.delete(key)
        invalidate(key)
      }
    }
    if (cache) {
      for (const key of [...cache.perKey.keys()]) if (!live.has(key)) cache.perKey.delete(key)
    }
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!live.has(queue[i])) {
        queued.delete(queue[i])
        queue.splice(i, 1)
        dropped = true
      }
    }
    if (active) for (const key of live.keys()) enqueue(key)
    pump()
    if (dropped) onChange()
  }

  function setOverlays(overlays: readonly Overlay[]): void {
    if (overlays === lastOverlays) return
    lastOverlays = overlays
    const refs = new Map<string, Overlay[]>()
    const nextTexts = new Map<string, OverlayText[]>()
    const nextById = new Map<string, OverlayText>()
    const redactionsOf = new Map<string, Overlay[]>()
    for (const o of overlays) {
      if (o.type !== 'redaction') continue
      const list = redactionsOf.get(o.pageKey)
      if (list) list.push(o)
      else redactionsOf.set(o.pageKey, [o])
    }
    for (const o of overlays) {
      const raw = overlaySearchText(o)
      if (raw === null) continue
      // An overlay a redaction drawn above it covers is dropped from every export (mirror.ts's
      // stripRedactedOverlays, the very rule used here), so Find does not report it either.
      const reds = redactionsOf.get(o.pageKey)
      if (reds && stripRedactedOverlays([...reds, o]).length === 0) continue
      let norm = overlayNorm.get(o)
      if (norm === undefined) {
        norm = normalizeQuery(raw)
        overlayNorm.set(o, norm)
      }
      if (!norm) continue
      const entry: OverlayText = { overlayId: o.id, pageKey: o.pageKey, norm, geom: o.geom }
      const list = refs.get(o.pageKey)
      if (list) list.push(o)
      else refs.set(o.pageKey, [o])
      const tl = nextTexts.get(o.pageKey)
      if (tl) tl.push(entry)
      else nextTexts.set(o.pageKey, [entry])
      nextById.set(o.id, entry)
    }
    let changed = false
    for (const key of new Set([...refs.keys(), ...overlayRefs.keys()])) {
      const a = refs.get(key)
      const b = overlayRefs.get(key)
      if (!a || !b || a.length !== b.length || a.some((o, i) => o !== b[i])) {
        invalidate(key)
        changed = true
      }
    }
    overlayRefs = refs
    overlayTexts = nextTexts
    overlayById = nextById
    if (changed) onChange()
  }

  function computeKey(key: string, re: RegExp): PageMatches | null {
    const pt = pageText(key)
    // One past the limit, so hitting it can be told apart from having exactly that many.
    let text = pt && pt.norm ? match(pt.norm, re, perPageLimit + 1) : EMPTY_PAIRS
    let capped = false
    if (text.length / 2 > perPageLimit) {
      text = text.slice(0, 2 * perPageLimit)
      capped = true
    }
    const overlays: PageMatches['overlays'] = []
    for (const ov of overlayTexts.get(key) ?? []) {
      const room = perPageLimit - text.length / 2 - overlays.length
      if (room <= 0) {
        capped = true
        break
      }
      const pairs = match(ov.norm, re, room + 1)
      const n = Math.min(room, pairs.length / 2)
      if (pairs.length / 2 > room) capped = true
      for (let i = 0; i < n; i++) {
        overlays.push({ overlayId: ov.overlayId, start: pairs[2 * i], end: pairs[2 * i + 1] })
      }
    }
    return text.length > 0 || overlays.length > 0 ? { text, overlays, capped } : null
  }

  function search(norm: string, re: RegExp): ReadonlyMap<string, PageMatches | null> {
    if (!cache || cache.query !== norm) cache = { query: norm, perKey: new Map() }
    const perKey = cache.perKey
    for (const key of live.keys()) {
      if (!perKey.has(key)) perKey.set(key, computeKey(key, re))
    }
    return perKey
  }

  return {
    activate(first) {
      if (active) return
      active = true
      for (const key of live.keys()) enqueue(key)
      if (first) prioritize(first)
      pump()
    },
    prioritize,
    reconcile,
    setOverlays,
    setSupplement,
    setRedactions,
    search,
    progress() {
      let indexed = 0
      for (const key of live.keys()) if (texts.has(key)) indexed++
      return { indexed, total: live.size }
    },
    getPageText: pageText,
    getOverlay: (id) => overlayById.get(id)
  }
}
