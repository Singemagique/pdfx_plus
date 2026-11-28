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
// function the export uses. FAIL-SAFE: until the report for the page's current redactions is in,
// or when the pass fails or reports nothing for the page, the page's recognised words are left out
// of Find altogether.

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
  dispose(): void
}

const redactionsOf = (overlays: readonly Overlay[] | undefined): Overlay[] =>
  overlays?.filter((o) => o.type === 'redaction') ?? []

/** A page's redactions as a comparable string (what a removal report was computed for). */
const redactionSig = (reds: readonly Overlay[]): string =>
  JSON.stringify(reds.map((o) => [o.id, o.geom.x, o.geom.y, o.geom.w, o.geom.h, o.geom.rotation]))

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

  /** The page's words after the rules, and whether its own layer is replaced (see the header). */
  function effective(key: string): {
    page: PackedOcrPage | null
    replaceNative: boolean
    native?: readonly { t: string; x0: number; y0: number; x1: number; y1: number }[]
  } | null {
    const sup = store.pageSupply(key)
    if (!sup) return null
    const reds = redactionsOf(editLayer.overlays.get(key))
    const replaceNative = sup.pageClass === 'ocr-ours' && (sup.dropsOwnLayer || reds.length > 0)
    let page: PackedOcrPage | null = sup.page ?? null
    if (page && reds.length > 0) {
      const pred = predictions.get(key)
      page =
        pred && pred.sig === redactionSig(reds) && pred.gone
          ? redactOcrPage(page, editLayer, key, new Map([[key, pred.gone]]))
          : null
    } else if (page) page = redactOcrPage(page, editLayer, key, undefined)
    return { page, replaceNative, native: sup.nativeWords }
  }

  /** Pages whose recognised words wait for a removal report of their current redactions. */
  function needsPrediction(key: string): boolean {
    const sup = store.pageSupply(key)
    if (!sup?.page) return false
    const reds = redactionsOf(editLayer.overlays.get(key))
    if (reds.length === 0) return false
    const pred = predictions.get(key)
    return !pred || pred.sig !== redactionSig(reds)
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
    const keys = [...pages.keys()].filter(needsPrediction)
    if (keys.length === 0) return Promise.resolve()
    const sigs = new Map(
      keys.map((k) => [k, redactionSig(redactionsOf(editLayer.overlays.get(k)))])
    )
    const layer: EditLayer = {
      ...editLayer,
      overlays: new Map(keys.map((k) => [k, editLayer.overlays.get(k) ?? []]))
    }
    const forDocs = [...docs]
    predicting = (async () => {
      let report: RemovedReport | null = null
      try {
        report = await predict(layer, forDocs)
      } catch (err) {
        console.warn('ocr: could not predict what the redaction pass removes', err)
      }
      if (disposed) return
      for (const [key, sig] of sigs) predictions.set(key, { sig, gone: report?.get(key) ?? null })
      for (const key of keys) syncKey(key)
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
    dispose() {
      disposed = true
      unsubscribe()
      if (predictTimer) clearTimeout(predictTimer)
    }
  }
}
