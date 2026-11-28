// Recognised text → Find (DESIGN.md §3.6.1, §3.7.3 rule 3): keeps search/engine.ts's per-page-key
// supplement in step with the OCR store, the edit history's Replace / Remove choices and the
// redactions, so Find, Copy Page Text and (PR10) the overlay see exactly the words an export would
// bake.
//
// Per live page key:
// - scanned / near-scanned: `append` the selected result's words (ocr/to-page-text.ts, in the page's
//   own pdf.js user space: it needs the page's viewport transform, so the key's native text is read
//   first, through Find's store);
// - `ocr-ours` (a reopened PDFx export) after Replace / Remove, or with any redaction on it:
//   `replace` with triage's visible native words plus the new words, if any. The redaction pass
//   removes such a page's WHOLE own layer (redact-export.ts `dropOcrText`), so Find must not keep
//   finding it;
// - a page with a redaction whose class triage has not given yet (a reopened PDFx export is never
//   sent by Stage 0: its own layer reads as text): the store is asked to triage it (`prepare`),
//   and until it answers its native text is held out of Find and Copy (`replace` with no native
//   words), since the export may drop that text as a PDFx OCR layer. Triage then decides as above.
//   The same hold stands when triage cannot answer at all (OCR unavailable, the source refused):
//   fail-safe;
// - otherwise nothing.
// A key that leaves the collection loses its supplement in the engine's reconcile; it is supplied
// again (with its viewport transform) when it comes back. `setSupplement` says whether the engine
// took it, so a supply sent before the engine knew the key is sent again.
//
// The in-app half of rule 3. Rule 1 (words under a box) is the engine's own filter
// (setRedactions). Rule 2 needs what the redaction pass WILL remove, which only the pass knows
// (a full-page scan is removed whole when pixel redaction does not apply to it, and kept when it
// does): so on every page with recognised words and a redaction, the export's own pass
// (redact-export.ts `buildRedactedSources({ report: true })`) runs in the background, debounced,
// and its removed-object report filters the words through ocr-export.ts `redactOcrPage`, the very
// function the export uses. The pass runs, as in the export, on EVERY redacted page of the source
// (a pixel swap that fails on one page makes the export remove every covered image of the source
// whole), and a report stands for the redactions of the whole source it was computed for: a
// redaction added, moved or removed anywhere on the source sends its pages back to pending.
// FAIL-SAFE: until the report for the source's current redactions is in, or when the pass fails or
// reports nothing for the page, the page's recognised words are left out of Find altogether.

import type { Overlay } from '../edit/model'
import type { EditLayer } from '../pdfx/build'
import { redactOcrPage, type FrameBox, type RemovedReport } from '../pdfx/ocr-export'
import type { PageTextItem } from '../search/extract'
import type { FindTextAccess } from '../search/find-controller'
import { makePageKey } from '../edit/model'
import type { DocEntry, PageEntry } from '../types'
import type { PackedOcrPage } from '../../../shared/ocr/types'
import type { OcrStore } from './ocr-store'
import { nativeWordItems, ocrPageTextItems } from './to-page-text'

/** What the export's redaction pass will remove, per page key (`RedactedSources.removed`). */
export type RemovalPredictor = (layer: EditLayer, docs: DocEntry[]) => Promise<RemovedReport>

/** The export's own pass (loaded on first use: it pulls in PDFium and pdf-lib). */
export const exportRemovalPredictor: RemovalPredictor = async (layer, docs) => {
  const { buildRedactedSources } = await import('../pdfx/redact-export')
  const out = await buildRedactedSources(layer, docs, { report: true })
  return out.removed ?? new Map()
}

export interface OcrFindSupplyOptions {
  store: OcrStore
  text: FindTextAccess
  predict?: RemovalPredictor
  /** Quiet time after a redaction change before the pass runs (ms). */
  debounceMs?: number
}

export interface OcrFindSupply {
  /** The collection and edit layer as of now (App calls it on every change). */
  sync(docs: readonly DocEntry[], editLayer: EditLayer): void
  /** Supply one page now (its native text read, its removal report computed): Copy Page Text. */
  ensure(pageKey: string): Promise<void>
  /**
   * The recognised words of a page as Find / Copy / the overlay use them: selected, redaction-
   * filtered (rules 1–3), or null when there are none or the fail-safe holds them back.
   */
  filteredPage(pageKey: string): PackedOcrPage | null
  /**
   * What the export's redaction pass does to a redacted page's scan, as far as its last removal
   * report says (the scan-redaction note, §3.8): 'whole' when it removes an object covering at least
   * half the page (the whole scan image: pixel redaction did not apply), 'pixels' when the report is
   * in and removes no such object, 'unknown' before that (or with no report: no recognised words,
   * no redaction, or a pass that failed).
   */
  redactionOutcome(pageKey: string): 'unknown' | 'pixels' | 'whole'
  /** A removal report came in (redactionOutcome may have changed). */
  onChange(listener: () => void): () => void
  dispose(): void
}

/** An object covering at least this share of the page is "the whole scan". */
const WHOLE_SCAN_SHARE = 0.5

const redactionsOf = (overlays: readonly Overlay[] | undefined): Overlay[] =>
  overlays?.filter((o) => o.type === 'redaction') ?? []

/** A page's redactions as a comparable string (what a removal report was computed for). */
const redactionSig = (reds: readonly Overlay[]): string =>
  JSON.stringify(reds.map((o) => [o.id, o.geom.x, o.geom.y, o.geom.w, o.geom.h, o.geom.rotation]))

/** The native words of a page held back (one identity, so an unchanged hold is not re-sent). */
const NO_WORDS: readonly never[] = []

interface Supplied {
  mode: 'append' | 'replace'
  page: PackedOcrPage | null
  native: unknown
  vt: readonly number[]
  height: number
}

export function createOcrFindSupply(opts: OcrFindSupplyOptions): OcrFindSupply {
  const { store, text } = opts
  const predict = opts.predict ?? exportRemovalPredictor
  const debounceMs = opts.debounceMs ?? 300

  let docs: readonly DocEntry[] = []
  let editLayer: EditLayer = { overlays: new Map(), attachments: new Map() }
  let pages = new Map<string, PageEntry>()
  /** What the engine holds per key (forgotten when the key leaves: the engine drops it then). */
  const supplied = new Map<string, Supplied>()
  /** Native viewport transforms (immutable per key). */
  const vts = new Map<string, readonly number[]>()
  const reading = new Set<string>()
  /** Removal reports: per key, for which redactions, and the removed boxes (null: fail-safe). */
  const predictions = new Map<string, { sig: string; gone: readonly FrameBox[] | null }>()
  let predictTimer: ReturnType<typeof setTimeout> | null = null
  let predicting: Promise<void> | null = null
  let rerun = false
  let disposed = false
  let syncQueued = false
  const changeListeners = new Set<() => void>()

  /**
   * The redactions of every live page of one source (by source id: what one redaction pass sees),
   * as a comparable string: the key a removal report is valid for.
   */
  function sourceSig(sourceId: string): string {
    const parts: string[] = []
    for (const [k, p] of pages) {
      if (p.source.id !== sourceId) continue
      const reds = redactionsOf(editLayer.overlays.get(k))
      if (reds.length) parts.push(`${k}:${redactionSig(reds)}`)
    }
    return parts.sort().join('|')
  }

  const sigOf = (key: string): string => {
    const p = pages.get(key)
    return p ? sourceSig(p.source.id) : ''
  }

  /** Keys asked for triage because a redaction landed on them before their class was known. */
  const prepared = new Set<string>()

  /** The page's words after the rules, and whether its own layer is replaced (see the header). */
  function effective(key: string): {
    page: PackedOcrPage | null
    replaceNative: boolean
    native?: readonly { t: string; x0: number; y0: number; x1: number; y1: number }[]
  } | null {
    const sup = store.pageSupply(key)
    const reds = redactionsOf(editLayer.overlays.get(key))
    // A redacted page whose class is not known yet may carry a PDFx OCR layer that the export
    // drops whole: hold its native text back until triage says (see the header).
    const unknown = reds.length > 0 && (!sup || (!sup.triaged && !sup.imageOrigin))
    if (unknown) {
      if (sup && !prepared.has(key)) {
        prepared.add(key)
        store.prepare([key])
      }
      if (!sup) return { page: null, replaceNative: true, native: NO_WORDS }
    }
    if (!sup) return null
    const replaceNative =
      unknown || (sup.pageClass === 'ocr-ours' && (sup.dropsOwnLayer || reds.length > 0))
    let page: PackedOcrPage | null = sup.page ?? null
    if (page && reds.length > 0) {
      const pred = predictions.get(key)
      page =
        pred && pred.sig === sigOf(key) && pred.gone
          ? redactOcrPage(page, editLayer, key, new Map([[key, pred.gone]]))
          : null
    } else if (page) page = redactOcrPage(page, editLayer, key, undefined)
    return { page, replaceNative, native: unknown ? NO_WORDS : sup.nativeWords }
  }

  /** Pages whose recognised words wait for a removal report of their source's redactions. */
  function needsPrediction(key: string): boolean {
    const sup = store.pageSupply(key)
    if (!sup?.page) return false
    const reds = redactionsOf(editLayer.overlays.get(key))
    if (reds.length === 0) return false
    const pred = predictions.get(key)
    return !pred || pred.sig !== sigOf(key)
  }

  function syncKey(key: string): void {
    const entry = pages.get(key)
    if (!entry) return
    const eff = effective(key)
    if (!eff || (!eff.page && !eff.replaceNative)) {
      if (supplied.has(key)) {
        text.setSupplement(key, null)
        supplied.delete(key)
      }
      return
    }
    const vt = vts.get(key)
    if (!vt) {
      if (reading.has(key)) return
      reading.add(key)
      void text.readNative(key).then((t) => {
        reading.delete(key)
        if (disposed || !t) return
        vts.set(key, t.vt)
        syncKey(key)
      })
      return
    }
    const mode = eff.replaceNative ? 'replace' : 'append'
    const prev = supplied.get(key)
    if (
      prev &&
      prev.mode === mode &&
      prev.page === eff.page &&
      prev.native === (eff.replaceNative ? eff.native : null) &&
      prev.vt === vt &&
      prev.height === entry.height
    )
      return
    const items: PageTextItem[] = []
    if (eff.replaceNative && eff.native)
      items.push(...nativeWordItems(eff.native, vt, entry.height))
    if (eff.page) items.push(...ocrPageTextItems(eff.page, vt, entry.height))
    if (text.setSupplement(key, { mode, items }))
      supplied.set(key, {
        mode,
        page: eff.page,
        native: eff.replaceNative ? eff.native : null,
        vt,
        height: entry.height
      })
    else supplied.delete(key)
  }

  function syncAll(): void {
    for (const key of [...supplied.keys()]) if (!pages.has(key)) supplied.delete(key)
    for (const key of pages.keys()) syncKey(key)
    schedulePrediction(false)
  }

  function queueSync(): void {
    if (syncQueued || disposed) return
    syncQueued = true
    queueMicrotask(() => {
      syncQueued = false
      if (!disposed) syncAll()
    })
  }

  function schedulePrediction(now: boolean): void {
    if (disposed) return
    const wanted = [...pages.keys()].some(needsPrediction)
    if (!wanted) return
    if (predicting) {
      rerun = true
      return
    }
    if (predictTimer) clearTimeout(predictTimer)
    predictTimer = setTimeout(
      () => {
        predictTimer = null
        void runPrediction()
      },
      now ? 0 : debounceMs
    )
  }

  function runPrediction(): Promise<void> {
    if (predicting) {
      rerun = true
      return predicting
    }
    const wanted = [...pages.keys()].filter(needsPrediction)
    if (wanted.length === 0) return Promise.resolve()
    // The pass over every redacted page of each source involved, as the export runs it: one
    // page's failed pixel swap changes what is removed on the others.
    const srcIds = new Set(wanted.map((k) => pages.get(k)!.source.id))
    const keys = [...pages.keys()].filter(
      (k) =>
        srcIds.has(pages.get(k)!.source.id) && redactionsOf(editLayer.overlays.get(k)).length > 0
    )
    const sigs = new Map([...srcIds].map((id) => [id, sourceSig(id)]))
    const layer: EditLayer = {
      ...editLayer,
      overlays: new Map(keys.map((k) => [k, editLayer.overlays.get(k) ?? []]))
    }
    const forDocs = [...docs]
    const forPages = pages
    predicting = (async () => {
      let report: RemovedReport | null = null
      try {
        report = await predict(layer, forDocs)
      } catch (err) {
        console.warn('ocr: could not predict what the redaction pass removes', err)
      }
      if (disposed) return
      for (const key of keys) {
        const sig = sigs.get(forPages.get(key)!.source.id)!
        predictions.set(key, { sig, gone: report?.get(key) ?? null })
      }
      for (const key of keys) syncKey(key)
      for (const l of [...changeListeners]) l()
    })().finally(() => {
      predicting = null
      if (rerun) {
        rerun = false
        schedulePrediction(false)
      }
    })
    return predicting
  }

  const unsubscribe = store.onResults(queueSync)

  return {
    sync(nextDocs, nextLayer) {
      docs = nextDocs
      editLayer = nextLayer
      const next = new Map<string, PageEntry>()
      for (const d of nextDocs)
        for (const p of d.pages) {
          const key = makePageKey(p.source.id, p.pageIndex)
          if (!next.has(key)) next.set(key, p)
        }
      pages = next
      syncAll()
    },
    async ensure(pageKey) {
      if (!pages.has(pageKey)) return
      const t = await text.readNative(pageKey)
      if (!t || disposed) return
      vts.set(pageKey, t.vt)
      if (needsPrediction(pageKey)) {
        if (predictTimer) {
          clearTimeout(predictTimer)
          predictTimer = null
        }
        await runPrediction()
        // A run that was already in flight covered other redactions: one more for this page.
        if (needsPrediction(pageKey)) await runPrediction()
      }
      syncKey(pageKey)
    },
    filteredPage(pageKey) {
      return effective(pageKey)?.page ?? null
    },
    redactionOutcome(pageKey) {
      const pred = predictions.get(pageKey)
      const entry = pages.get(pageKey)
      if (!pred || !pred.gone || !entry || pred.sig !== sigOf(pageKey)) return 'unknown'
      const area = entry.width * entry.height
      const whole = pred.gone.some((b) => area > 0 && (b.w * b.h) / area >= WHOLE_SCAN_SHARE)
      return whole ? 'whole' : 'pixels'
    },
    onChange(listener) {
      changeListeners.add(listener)
      return () => {
        changeListeners.delete(listener)
      }
    },
    dispose() {
      disposed = true
      unsubscribe()
      if (predictTimer) clearTimeout(predictTimer)
    }
  }
}
