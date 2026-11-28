// Tier 1 (DESIGN.md §3.9.3): every PR1 synth preset through the REAL loader, glue, core and
// bundled data — the same bytes electron-builder copies to resources/ocr, checked against the
// manifest here — inside the REAL recognize thread (its own network tripwire installed), then the
// hOCR parse and the overlay mapping, scored against the ground truth and gated against
// bench/ocr-baseline.json:
//   CER / WER / bag-of-words error ≤ baseline × 1.15 + 0.2 pp; Find recall / box hmean ≥
//   baseline − 2 pp (expect.soft, so one run reports every miss).
// Live hOCR must equal the replay cache on clean300 (on every preset with PDFX_OCR_CACHE_STRICT=1).
// `yarn ocr:record` (PDFX_OCR_RECORD=1) regenerates the cache, CACHE_INFO.json and, with
// PDFX_OCR_WRITE_BASELINE=1, the baseline.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TESS_CORE7 } from '../../../shared/ocr/calibration'
import { ENGINE_ID, PIPELINE_VERSION } from '../../../shared/ocr/engine/tess-core'
import type { GrayImage } from '../../../shared/ocr/engine/types'
import { mapRawOcrPage } from '../../../shared/ocr/map'
import { hocrPage } from '../../../shared/ocr/test-utils/hocr-pages'
import { loadNodeSynthDeps } from '../../../shared/ocr/test-utils/node-deps'
import { scorePage, type PageScores } from '../../../shared/ocr/test-utils/ocr-eval'
import { synthesize, type SynthDeps, type SynthGt } from '../../../shared/ocr/test-utils/synth'
import {
  REPO_ROOT,
  disposeBundles,
  startEngineThread,
  type EngineThread
} from '../test-utils/engine-harness'
import {
  ALL_SPECS,
  RECORD,
  STRICT,
  TIER1_SPECS,
  currentCacheInfo,
  readCacheInfo,
  readEntry,
  writeCacheInfo,
  writeEntry,
  type CacheSpec
} from '../test-utils/ocr-cache'
import { ENGINE_CORE, ENGINE_DATA } from './engine-manifest'
import { verifyBytes } from './engine-node'

const BASELINE_FILE = join(REPO_ROOT, 'bench/ocr-baseline.json')
type Metric = 'cer' | 'wer' | 'bwe' | 'recall' | 'hmean'
interface Baseline {
  note: string
  engineId: string
  presets: Record<string, Record<Metric, number>>
}

let thread: EngineThread
let deps: SynthDeps
const measured: Record<string, PageScores & { ms: number }> = {}
const replayMismatches: string[] = []

beforeAll(async () => {
  deps = await loadNodeSynthDeps()
  thread = await startEngineThread()
})

afterAll(async () => {
  await thread?.dispose()
  disposeBundles()
  if (RECORD) writeCacheInfo()
  if (RECORD && (process.env.PDFX_OCR_WRITE_BASELINE === '1' || !existsSync(BASELINE_FILE))) {
    const presets: Baseline['presets'] = {}
    for (const [id, s] of Object.entries(measured))
      presets[id] = { cer: s.cer, wer: s.wer, bwe: s.bwe, recall: s.recall, hmean: s.hmean }
    const b: Baseline = {
      note:
        'Tier-1 OCR accuracy baseline (DESIGN.md §3.9.3), measured by `yarn ocr:record` with ' +
        'PDFX_OCR_WRITE_BASELINE=1; ratchet by hand. Fractions, not percent.',
      engineId: ENGINE_ID,
      presets
    }
    writeFileSync(BASELINE_FILE, JSON.stringify(b, null, 2) + '\n')
  }
  const report = process.env.PDFX_OCR_REPORT
  if (report) writeFileSync(report, JSON.stringify({ measured, replayMismatches }, null, 2))
  // Outside strict mode drift is not a failure (the tier-0 suites keep replaying the recording),
  // but it is never silent: name every spec whose live hOCR no longer equals its entry. A stale
  // INPUT (synth changed) fails tier 0 outright (ocr-cache.node.test.ts).
  if (!RECORD && replayMismatches.length > 0)
    console.warn(
      `OCR replay cache drift (live hOCR differs from the recording; re-run \`yarn ocr:record\`, ` +
        `PDFX_OCR_CACHE_STRICT=1 makes this fail): ${replayMismatches.join(', ')}`
    )
}, 120_000)

async function input(
  spec: CacheSpec
): Promise<{ img: GrayImage; dpi: number; gt: SynthGt | null }> {
  if (spec.kind === 'synth') {
    const r = await synthesize({ preset: spec.preset, seed: spec.seed, font: spec.font }, deps)
    return { img: r.raster, dpi: r.gt.dpi, gt: r.gt }
  }
  const p = await hocrPage(spec.id, deps.rasterize)
  return { img: p.raster, dpi: p.dpi, gt: null }
}

describe('tier 1: the real engine on the synth presets', () => {
  it('runs the exact bytes the app ships (node_modules = manifest = resources/ocr)', () => {
    for (const f of [ENGINE_CORE.js, ENGINE_CORE.wasm, ...Object.values(ENGINE_DATA)])
      verifyBytes(new Uint8Array(readFileSync(join(REPO_ROOT, f.source))), f, f.file)
  })

  it('was recorded with this engine configuration (CACHE_INFO.json)', () => {
    if (RECORD) return
    const info = readCacheInfo()
    if (STRICT) expect(info).toEqual(currentCacheInfo())
    else if (JSON.stringify(info) !== JSON.stringify(currentCacheInfo()))
      replayMismatches.push('CACHE_INFO.json')
  })

  const baseline: Baseline | null = existsSync(BASELINE_FILE)
    ? (JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as Baseline)
    : null

  for (const spec of RECORD ? ALL_SPECS : TIER1_SPECS) {
    it(spec.id, async () => {
      const { img, dpi, gt } = await input(spec)
      const t0 = performance.now()
      // Pass 1 on the synth raster as given: this file pins the ENGINE (loader, glue, core, data,
      // parse); the PR6 pipeline over the same presets is pipeline.ocr.test.ts.
      const reply = await thread.recognize(img, dpi, spec.langs, true, { rawPass1: true })
      const ms = performance.now() - t0
      // Privacy and silence: the thread's tripwire never fired, the engine printed nothing.
      expect(reply.tripwire).toBe(0)
      expect(reply.stderrLines).toBe(0)
      const hocr = reply.outcome.hocr?.[0]
      expect(typeof hocr).toBe('string')

      if (RECORD) writeEntry(spec, img, dpi, hocr!)
      else {
        const cached = readEntry(spec, img, dpi)
        if (spec.id === 'clean300' || STRICT) {
          expect(cached, `${spec.id}: no replay entry for this input`).not.toBeNull()
          expect(hocr === cached!.hocr, `${spec.id}: live hOCR differs from the replay`).toBe(true)
        } else if (!cached || cached.hocr !== hocr) replayMismatches.push(spec.id)
      }
      if (!gt) return

      const page = mapRawOcrPage(reply.outcome.raw, {
        page: gt.page,
        raster: gt.raster,
        renderDpi: dpi,
        engineId: ENGINE_ID,
        dataHashes: Object.fromEntries(spec.langs.map((l) => [l, ENGINE_DATA[l].sha256])),
        langs: spec.langs,
        pipelineVersion: PIPELINE_VERSION,
        pageClass: 'scanned',
        calibration: TESS_CORE7
      })
      const s = await scorePage(page, gt)
      measured[spec.id] = { ...s, ms: Math.round(ms) }
      const base = baseline?.presets[spec.id]
      if (RECORD || !base) return
      for (const m of ['cer', 'wer', 'bwe'] as const)
        expect.soft(s[m], `${spec.id} ${m}`).toBeLessThanOrEqual(base[m] * 1.15 + 0.002 + 1e-9)
      for (const m of ['recall', 'hmean'] as const)
        expect.soft(s[m], `${spec.id} ${m}`).toBeGreaterThanOrEqual(base[m] - 0.02 - 1e-9)
    })
  }

  it('every preset has a baseline row', () => {
    if (RECORD) return
    expect(baseline, 'bench/ocr-baseline.json is missing (yarn ocr:record)').not.toBeNull()
    for (const s of TIER1_SPECS) expect(baseline!.presets[s.id], s.id).toBeDefined()
  })

  it("leaves the thread's network tripwire at 0 and its real stdout/stderr empty", () => {
    expect(thread.tripwire).toBe(0)
    expect(thread.stdioBytes).toBe(0)
  })
})
