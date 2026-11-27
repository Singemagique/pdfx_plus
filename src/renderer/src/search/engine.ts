// The text index behind Find: per-page extracted text (cached by page key — sources are
// immutable, so a page keeps its text across reorders and moves), the user's own text overlays,
// and a per-query match cache. Extraction is lazy (nothing runs before activate()), incremental
// (onChange fires as pages land) and bounded (a few pages at a time, because every document shares
// one pdf.js worker with thumbnail rendering).

import type { Geom, Overlay } from '../edit/model'
import { makePageKey } from '../edit/model'
import type { DocEntry, PdfSource } from '../types'
import { EMPTY_PAGE_TEXT, extractPageText, type PageText } from './extract'
import { findAll, normalizeQuery } from './normalize'

/** Matches on one page key: text pairs into PageText.norm, and overlay hits. */
export interface PageMatches {
  /** [start, end) pairs into the page's normalized text. */
  text: Int32Array
  overlays: { overlayId: string; start: number; end: number }[]
}

export interface OverlayText {
  overlayId: string
  pageKey: string
  norm: string
  geom: Geom
}

export interface FindEngine {
  /** Start indexing (idempotent). Before this, nothing is ever extracted. */
  activate(): void
  /** Track the live pages: drop removed ones, queue new ones (once active). */
  reconcile(docs: readonly DocEntry[]): void
  /** Track the searchable overlay texts (a no-op for the same array). */
  setOverlays(overlays: readonly Overlay[]): void
  /** Matches per live page key for a normalized query and its compiled regex. */
  search(norm: string, re: RegExp): ReadonlyMap<string, PageMatches | null>
  progress(): { indexed: number; total: number }
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
  const texts = new Map<string, PageText>()
  /** Extraction dedupe across page keys that share a proxy (duplicated pages). */
  const byProxy = new WeakMap<object, Map<number, PageText | Promise<PageText>>>()
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

  let cache: { query: string; perKey: Map<string, PageMatches | null> } | null = null

  const invalidate = (key: string): void => {
    cache?.perKey.delete(key)
  }

  const store = (key: string, result: PageText): boolean => {
    // A stale completion for a source that has since been removed must not resurrect it. A key
    // that was removed and re-added meanwhile is fine: sources are immutable, so its text is too.
    if (!live.has(key) || texts.has(key)) return false
    texts.set(key, result)
    invalidate(key)
    return true
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

  function reconcile(docs: readonly DocEntry[]): void {
    const next = new Map<string, { pdf: PdfSource['pdf']; pageIndex: number }>()
    for (const d of docs) {
      for (const p of d.pages) {
        const key = makePageKey(p.source.id, p.pageIndex)
        if (!next.has(key)) next.set(key, { pdf: p.source.pdf, pageIndex: p.pageIndex })
      }
    }
    live = next
    let dropped = false
    for (const key of [...texts.keys()]) {
      if (!live.has(key)) {
        texts.delete(key)
        invalidate(key)
        dropped = true
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
    for (const o of overlays) {
      const raw = overlaySearchText(o)
      if (raw === null) continue
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
    const pt = texts.get(key)
    const text = pt && pt.norm ? match(pt.norm, re, perPageLimit) : EMPTY_PAIRS
    const overlays: PageMatches['overlays'] = []
    for (const ov of overlayTexts.get(key) ?? []) {
      const pairs = match(ov.norm, re, perPageLimit)
      for (let i = 0; i < pairs.length; i += 2) {
        overlays.push({ overlayId: ov.overlayId, start: pairs[i], end: pairs[i + 1] })
      }
    }
    return text.length > 0 || overlays.length > 0 ? { text, overlays } : null
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
    activate() {
      if (active) return
      active = true
      for (const key of live.keys()) enqueue(key)
      pump()
    },
    reconcile,
    setOverlays,
    search,
    progress() {
      let indexed = 0
      for (const key of live.keys()) if (texts.has(key)) indexed++
      return { indexed, total: live.size }
    },
    getPageText: (key) => texts.get(key),
    getOverlay: (id) => overlayById.get(id)
  }
}
