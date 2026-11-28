// Test-only: one PDF page through the whole PR6 pipeline the way the coordinator runs it (DESIGN.md
// §3.4): PDFium triage (d_eff, class, bits per pixel) → the triage DPI and render flags → the
// PDFium raster (in this realm, raster-core.ts) → the REAL recognize thread (preprocess,
// orientation, deskew, passes, retries) → the adaptive re-render when asked for → the kept result
// mapped into the overlay frame. The decisions are page-plan.ts's, the same functions the
// coordinator calls, so this harness and the app cannot drift apart.

import { TESS_CALIBRATION } from '../../../shared/ocr/calibration'
import { ENGINE_ID, PIPELINE_VERSION } from '../../../shared/ocr/engine/tess-core'
import type { CalibrationTable, GrayImage } from '../../../shared/ocr/engine/types'
import { mapRawOcrPage, type MapContext, type SizeFactors } from '../../../shared/ocr/map'
import type { TriagePage } from '../../../shared/ocr/triage'
import type { OcrPage } from '../../../shared/ocr/types'
import { ENGINE_DATA } from '../process/engine-manifest'
import {
  DEFAULT_RENDER_DPI,
  adaptiveRender,
  keepAdaptive,
  overlayAffine,
  renderFlagsFor
} from '../process/page-plan'
import { DEFAULT_RASTER_LIMITS, RasterEngine } from '../process/raster-core'
import type { RecognitionRecord } from '../process/recognize-core'
import type { EngineThread, RecognizeReply } from './engine-harness'
import { loadTestPdfium } from './pdfium-node'

export interface PageRunOptions {
  langs: string[]
  /** Render DPI override (the request's `renderDpi`); default: triage's. */
  dpi?: number
  /** The NO_SMOOTHIMAGE A/B: force the 1-bit rule on or off (default: page-plan's constant). */
  noSmooth1Bit?: boolean
  /** Ask for the adaptive pass (default true). */
  adaptive?: boolean
  /** Return every recognition's hOCR and input record (the replay recorder). */
  record?: boolean
  /** The page's edit rotation (the request's `editRotation`; tried first). */
  editRotation?: 0 | 90 | 180 | 270
  /**
   * The table the pipeline's gates read (default: the shipped one). The calibration run passes a
   * fixed table so the fit is not fed by the table it replaces; the mapping's confCal always uses
   * the shipped table.
   */
  calibration?: CalibrationTable
}

export interface RecordedRecognition extends RecognitionRecord {
  phase: 'first' | 'adaptive'
  hocr: string
}

export interface PageRun {
  page: OcrPage
  triage: TriagePage
  first: RecognizeReply
  second: RecognizeReply | null
  kept: 'first' | 'adaptive'
  /** The kept result's raster. */
  raster: { width: number; height: number; dpi: number }
  /** The first render (its pixels too, for the cache key and the codec gate). */
  firstRaster: GrayImage & { dpi: number }
  flags: number
  ms: { total: number; recognize: number }
  recognitions: RecordedRecognition[]
  /** The kept result mapped again with other size factors (the calibration run's refit). */
  remap(f: SizeFactors): OcrPage
}

export interface PageHarness {
  run(
    pdf: Uint8Array,
    frame: { width: number; height: number },
    o: PageRunOptions
  ): Promise<PageRun>
}

let seq = 0

/**
 * What runs the recognitions: the real recognize thread (`EngineThread`, tier 1) or an in-realm
 * replay of recorded hOCR (`replayRecognizer`, tier 0).
 */
export type Recognizer = Pick<EngineThread, 'recognize'>

export async function pageHarness(thread: Recognizer): Promise<PageHarness> {
  const raster = new RasterEngine(await loadTestPdfium())
  return {
    async run(pdf, frame, o) {
      const t0 = performance.now()
      const src = `p${++seq}`
      raster.attach(src, pdf)
      try {
        const tri = raster.triage(src, [0])
        if (!Array.isArray(tri)) throw new Error(`triage failed: ${tri.pdfiumError}`)
        const triage = tri[0]
        const caps = {
          maxLongSide: DEFAULT_RASTER_LIMITS.maxLongSide,
          maxPixels: DEFAULT_RASTER_LIMITS.maxPixels
        }
        const render = (dpi: number): GrayImage & { dpi: number; flags: number } => {
          const flags = renderFlagsFor(triage, dpi, o.noSmooth1Bit)
          const r = raster.render({
            src,
            index: 0,
            dpi,
            userUnit: 1,
            frame,
            flags,
            maskText: triage.pageClass === 'near-scanned'
          })
          if (r.kind !== 'ok') throw new Error(`render failed: ${JSON.stringify(r)}`)
          return { width: r.width, height: r.height, data: r.data, dpi: r.dpi, flags }
        }
        const dpi0 = o.dpi ?? triage.renderDpi ?? DEFAULT_RENDER_DPI
        const r1 = render(dpi0)
        let recMs = 0
        const t1 = performance.now()
        const first = await thread.recognize(r1, r1.dpi, o.langs, o.record === true, {
          adaptive: o.adaptive,
          ...(o.editRotation ? { editRotation: o.editRotation } : {}),
          ...(o.calibration ? { calibration: o.calibration } : {})
        })
        recMs += performance.now() - t1
        const recognitions: RecordedRecognition[] = []
        const collect = (reply: RecognizeReply, phase: 'first' | 'adaptive'): void => {
          const hocr = reply.outcome.hocr ?? []
          ;(reply.outcome.recognitions ?? []).forEach((rec, i) =>
            recognitions.push({ ...rec, phase, hocr: hocr[i] })
          )
        }
        collect(first, 'first')
        let second: RecognizeReply | null = null
        let kept: 'first' | 'adaptive' = 'first'
        let keptRaster = { width: r1.width, height: r1.height, dpi: r1.dpi }
        const next = first.outcome.adaptive
          ? adaptiveRender(first.outcome.adaptive, r1.dpi, frame, triage, caps)
          : null
        if (next) {
          const r2 = render(next.dpi)
          const t2 = performance.now()
          second = await thread.recognize(r2, r2.dpi, o.langs, o.record === true, {
            reuse: { plan: first.outcome.plan, recipe: first.outcome.recipe },
            ...(o.calibration ? { calibration: o.calibration } : {})
          })
          recMs += performance.now() - t2
          collect(second, 'adaptive')
          if (keepAdaptive(first.outcome, second.outcome)) {
            kept = 'adaptive'
            keptRaster = { width: r2.width, height: r2.height, dpi: r2.dpi }
          }
        }
        const outcome = kept === 'adaptive' ? second!.outcome : first.outcome
        const ctx: MapContext = {
          page: frame,
          raster: keptRaster,
          renderDpi: keptRaster.dpi,
          physDpi: triage.effectiveDpi ?? keptRaster.dpi,
          engineId: ENGINE_ID,
          dataHashes: Object.fromEntries(o.langs.map((l) => [l, ENGINE_DATA[l].sha256])),
          langs: o.langs,
          pipelineVersion: PIPELINE_VERSION,
          pageClass: triage.pageClass ?? 'scanned',
          calibration: TESS_CALIBRATION,
          orientation: outcome.orientation,
          skewDeg: outcome.plan.skewDeg,
          toOverlay: overlayAffine(outcome, frame, keptRaster),
          native: triage.pageClass === 'near-scanned' ? triage.nativeWords : undefined
        }
        const page = mapRawOcrPage(outcome.raw, ctx)
        return {
          page,
          triage,
          first,
          second,
          kept,
          raster: keptRaster,
          firstRaster: { width: r1.width, height: r1.height, data: r1.data, dpi: r1.dpi },
          flags: r1.flags,
          ms: { total: performance.now() - t0, recognize: recMs },
          recognitions,
          remap: (f) => mapRawOcrPage(outcome.raw, { ...ctx, sizeFactors: f })
        }
      } finally {
        raster.close(src)
      }
    }
  }
}
