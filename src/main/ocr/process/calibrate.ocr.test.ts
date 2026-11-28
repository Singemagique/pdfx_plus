// The calibration run (DESIGN.md §3.4.6, tier 2): `node scripts/ocr-calibrate.mjs` sets
// PDFX_OCR_CALIBRATE=1 and runs this file; ordinary tier-1 runs skip it. It sweeps seeds × presets
// × fonts through the whole pipeline (page-harness.ts, several real recognize threads at once),
// labels every recognised word correct or not against the ground truth (matched one-to-one by box,
// correct = exactly the GT text), fits the isotonic P(word correct | raw conf) and writes the
// 21-point table to src/shared/ocr/calibration/tess-simd.json. It also sweeps the font-size
// factor (§3.4.6: x-height → em) over the same pages and reports the median word-box IoU of each.
// The pipeline's own gate (Retry A) reads a fixed table during the sweep (DECISION_TABLE), never
// the committed one, so the fit is a deterministic function of the code and the seeds:
// `node scripts/ocr-calibrate.mjs --seeds 1,2,3,4,5 --threads 4 --check` reproduces it byte for
// byte.
//
// The maintainers' real corpus (§3.9.1: 10–20 own scans and photos) does not exist yet. When it
// does, `bench/ocr-real/manifest.json` lists `{ pdf, gt, kind }` entries (PDF path, a synth-style
// gt.json path, 'scan' | 'photo'); this run then adds their words with weight
// PDFX_OCR_CAL_REAL_WEIGHT (default 5) so the fit does not overfit synthetic degradations.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { availableParallelism } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  calibrate,
  TESS_CALIBRATION_PLACEHOLDER,
  thresholdsFor
} from '../../../shared/ocr/calibration'
import {
  expectedCalibrationError,
  fitCalibration,
  type LabelledConf
} from '../../../shared/ocr/calibration-fit'
import { ENGINE_ID } from '../../../shared/ocr/engine/tess-core'
import { CJK_CHAR_EM, XHEIGHT_EM } from '../../../shared/ocr/map'
import { boxScores, iou, type Box } from '../../../shared/ocr/test-utils/metrics'
import { loadNodeSynthDeps } from '../../../shared/ocr/test-utils/node-deps'
import { emBox } from '../../../shared/ocr/test-utils/ocr-eval'
import '../../../shared/ocr/test-utils/quality-presets'
import {
  synthesize,
  type FontId,
  type SynthDeps,
  type SynthGt
} from '../../../shared/ocr/test-utils/synth'
import type { OcrPage } from '../../../shared/ocr/types'
import {
  REPO_ROOT,
  disposeBundles,
  startEngineThread,
  type EngineThread
} from '../test-utils/engine-harness'
import { pageHarness, type PageHarness } from '../test-utils/page-harness'

const RUN = process.env.PDFX_OCR_CALIBRATE === '1'
/** Where the table goes (the script's --check writes elsewhere and compares). */
const OUT =
  process.env.PDFX_OCR_CAL_OUT ?? join(REPO_ROOT, 'src/shared/ocr/calibration/tess-simd.json')

/**
 * The table the pipeline's own gate (Retry A, `thresholdsFor(table).retry`) reads during the
 * sweep: fixed, never the committed fit. With the committed table there the sweep depended on the
 * table it was replacing, so each refit moved which pages took Retry A and a rerun did not
 * reproduce the committed JSON [measured, PR6 review: points[90] 0.8413 → 0.84 on a rerun]. The
 * placeholder's retry gate (p = raw/100 below 0.70) is the design's "≈ raw 70" itself; the app keeps
 * reading the shipped table, whose retry threshold is read off the curve at that same raw 70.
 */
const DECISION_TABLE = TESS_CALIBRATION_PLACEHOLDER
const REAL = join(REPO_ROOT, 'bench/ocr-real/manifest.json')

const list = (v: string | undefined, d: string[]): string[] =>
  v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : d

const SEEDS = list(process.env.PDFX_OCR_CAL_SEEDS, ['1', '2', '3']).map(Number)
const PRESETS = list(process.env.PDFX_OCR_CAL_PRESETS, [
  'clean300',
  'skew2',
  'blur1',
  'noise',
  'jpeg35',
  'fax200',
  'low150',
  'rot180page',
  'photoLike',
  'twocol',
  'smallprint6pt',
  'smallprint6pt-fax',
  'numbers-table',
  'skew5',
  'border-scan'
])
const FONTS = list(process.env.PDFX_OCR_CAL_FONTS, [
  'helvetica',
  'times',
  'courier',
  'dejavu-serif'
]) as FontId[]
const THREADS = Number(
  process.env.PDFX_OCR_CAL_THREADS ?? Math.max(1, Math.min(4, availableParallelism() >> 2))
)
const FACTORS = Array.from({ length: 21 }, (_, i) => Math.round((0.45 + i * 0.01) * 100) / 100)

/** Greedy one-to-one match of OCR words to GT words by em-box IoU; correct = same NFC text. */
function label(page: OcrPage, gt: SynthGt): { samples: LabelledConf[]; matched: number } {
  const hyp: { t: string; box: Box; conf: number | null }[] = []
  for (const l of page.lines)
    for (const w of l.words) hyp.push({ t: w.t, box: emBox(w, l), conf: w.conf })
  const pairs: { i: number; j: number; v: number }[] = []
  for (let i = 0; i < hyp.length; i++)
    for (let j = 0; j < gt.words.length; j++) {
      const v = iou(hyp[i].box, gt.words[j].box)
      if (v > 0.3) pairs.push({ i, j, v })
    }
  pairs.sort((a, b) => b.v - a.v)
  const usedH = new Set<number>()
  const usedG = new Set<number>()
  const match = new Map<number, number>()
  for (const p of pairs) {
    if (usedH.has(p.i) || usedG.has(p.j)) continue
    usedH.add(p.i)
    usedG.add(p.j)
    match.set(p.i, p.j)
  }
  const samples: LabelledConf[] = []
  hyp.forEach((h, i) => {
    if (h.conf === null || h.conf < 0) return
    const j = match.get(i)
    const correct = j !== undefined && gt.words[j].t.normalize('NFC') === h.t.normalize('NFC')
    samples.push({ conf: h.conf, correct })
  })
  return { samples, matched: match.size }
}

interface Job {
  preset: string
  seed: number
  font: FontId
}

describe.runIf(RUN)('calibration run (tier 2)', () => {
  let deps: SynthDeps
  const threads: EngineThread[] = []
  const harnesses: PageHarness[] = []

  beforeAll(async () => {
    deps = await loadNodeSynthDeps()
    for (let i = 0; i < THREADS; i++) {
      const t = await startEngineThread(threads[0]?.engine)
      threads.push(t)
      harnesses.push(await pageHarness(t))
    }
  }, 600_000)

  afterAll(async () => {
    for (const t of threads) await t.dispose()
    disposeBundles()
  })

  it('fits the table and the font-size factor', async () => {
    const jobs: Job[] = []
    for (const preset of PRESETS)
      for (const font of FONTS) for (const seed of SEEDS) jobs.push({ preset, seed, font })
    const samples: LabelledConf[] = []
    const iouByFactor = new Map<number, number[]>(FACTORS.map((f) => [f, []]))
    const perPreset: Record<
      string,
      { words: number; correct: number; orientation: Record<string, number> }
    > = {}
    let skipped = 0
    const pages: unknown[] = []
    let next = 0
    const t0 = performance.now()
    const worker = async (h: PageHarness): Promise<void> => {
      for (;;) {
        const job = jobs[next++]
        if (!job) return
        let r
        try {
          r = await synthesize(job, deps)
        } catch {
          skipped++ // a preset that restricts its fonts
          continue
        }
        const langs = job.preset === 'latin-diacritics' ? ['deu', 'fra', 'spa'] : ['eng']
        const run = await h.run(r.pdfBytes, r.gt.page, { langs, calibration: DECISION_TABLE })
        const l = label(run.page, r.gt)
        samples.push(...l.samples)
        const pp = (perPreset[job.preset] ??= { words: 0, correct: 0, orientation: {} })
        const o = `${job.font}:${run.page.orientation}`
        pp.orientation[o] = (pp.orientation[o] ?? 0) + 1
        pages.push({
          ...job,
          orientation: run.page.orientation,
          band: run.first.outcome.stats.band
        })
        pp.words += l.samples.length
        pp.correct += l.samples.filter((s) => s.correct).length
        const gtBoxes = r.gt.words.map((w) => w.box)
        for (const f of FACTORS) {
          const page = run.remap({ xHeightEm: f, cjkCharEm: CJK_CHAR_EM })
          const boxes: Box[] = []
          for (const ln of page.lines) for (const w of ln.words) boxes.push(emBox(w, ln))
          for (const m of boxScores(gtBoxes, boxes).matches) iouByFactor.get(f)!.push(m.iou)
        }
      }
    }
    await Promise.all(harnesses.map((h) => worker(h)))

    // The real corpus, when the maintainers have committed it.
    const realWeight = Number(process.env.PDFX_OCR_CAL_REAL_WEIGHT ?? 5)
    let real = 'absent: bench/ocr-real/manifest.json does not exist yet'
    if (existsSync(REAL)) {
      const entries = JSON.parse(readFileSync(REAL, 'utf8')) as {
        pdf: string
        gt: string
        kind: string
      }[]
      let n = 0
      for (const e of entries) {
        const gt = JSON.parse(readFileSync(join(REPO_ROOT, e.gt), 'utf8')) as SynthGt
        const pdf = new Uint8Array(readFileSync(join(REPO_ROOT, e.pdf)))
        const run = await harnesses[0].run(pdf, gt.page, {
          langs: ['eng'],
          calibration: DECISION_TABLE
        })
        for (const s of label(run.page, gt).samples) {
          samples.push({ ...s, weight: realWeight })
          n++
        }
      }
      real = `${entries.length} pages, ${n} words, weight ${realWeight}`
    }

    const points = fitCalibration(samples)
    const table = { engineId: ENGINE_ID, placeholder: false, points }
    const median = (v: number[]): number => {
      const s = [...v].sort((a, b) => a - b)
      return s.length ? s[s.length >> 1] : 0
    }
    const factorIou = FACTORS.map((f) => ({ f, medianIou: median(iouByFactor.get(f)!) }))
    const best = factorIou.reduce((a, b) => (b.medianIou > a.medianIou ? b : a))
    const correct = samples.filter((s) => s.correct).length
    const ece = {
      placeholder: expectedCalibrationError(
        samples,
        (r) => calibrate(TESS_CALIBRATION_PLACEHOLDER, r)!
      ),
      fitted: expectedCalibrationError(samples, (r) => calibrate(table, r)!)
    }
    const fit = {
      seeds: SEEDS,
      presets: PRESETS,
      fonts: FONTS,
      pages: jobs.length - skipped,
      words: samples.length,
      correct,
      real,
      ece: { placeholder: round4(ece.placeholder), fitted: round4(ece.fitted) },
      thresholds: thresholdsFor(table),
      sizeFactor: {
        current: XHEIGHT_EM,
        best: best.f,
        medianIou: Object.fromEntries(factorIou.map((x) => [x.f.toFixed(2), round4(x.medianIou)]))
      },
      perPreset
    }
    // PDFX_OCR_CAL_DRY=1: report only (a sweep of a few presets must not replace the table).
    if (process.env.PDFX_OCR_CAL_DRY !== '1')
      writeFileSync(OUT, JSON.stringify({ ...table, fit }, null, 2) + '\n')
    const report = process.env.PDFX_OCR_REPORT
    // Timing and the per-page list go to the report only: the committed table stays deterministic.
    const ms = Math.round(performance.now() - t0)
    if (report) writeFileSync(report, JSON.stringify({ ...fit, ms, pages }, null, 2))
    if (process.env.PDFX_OCR_CAL_DRY !== '1') expect(samples.length).toBeGreaterThan(1000)
  }, 3_600_000)
})

function round4(v: number): number {
  return Math.round(v * 10000) / 10000
}
