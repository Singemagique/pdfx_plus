// Tier 2 (DESIGN.md §3.9.3): the nightly OCR bench, `.github/workflows/ocr-bench.yml`. Skipped
// unless PDFX_OCR_BENCH names its sections (comma-separated, or `all`):
//
//   sweep      seeds × presets × fonts through the WHOLE pipeline (page-harness.ts: PDFium triage
//              and raster, the real recognize threads), scored against the ground truth; per-page
//              time and the recognize threads' WASM heap; plus the committed real corpus when
//              bench/ocr-real/manifest.json exists (it does not yet, §3.9.1).
//   timing     the §3.9.4 time row's page (letter10pt, a full Letter page of 10 pt text at 300 DPI)
//              end to end at n = 1 and n = 2 concurrent threads, and smallprint6pt (reported).
//              Blocking on the Windows runner only: median ≤ 6 s at both n.
//   scale      a 1,000-page synthetic scan (PDFX_OCR_SCALE_PAGES) opened, triaged and recognised in
//              ONE job through the real coordinator, raster thread and recognize threads; this Node
//              process plays the utility process (its RSS is the budget: ≤ 2.5 GB) and the receiving
//              port plays the renderer, whose growth is estimated as the retained bytes of every
//              packed result (≤ 50 MB). A real renderer measurement needs PR7b's ocr-store.
//   too-large  a sparse source one byte over the 1.5 GiB ceiling must be refused `too-large`, and one
//              exactly at it must be posted and answered, with the coordinator alive afterwards.
//
// Every section writes `<PDFX_OCR_BENCH_OUT>/<section>.json` (scores and numbers only: synthetic
// pages, nothing else). scripts/ocr-bench-compare.mjs compares the sweep's scores with
// bench/ocr-real-baseline.json when that file exists.

import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { availableParallelism, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { PDFDocument } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { OCR_LIMITS, type FromOcr, type Heartbeat } from '../../../shared/ocr/protocol'
import { copyFidelity } from '../../../shared/ocr/test-utils/metrics'
import { loadNodeSynthDeps } from '../../../shared/ocr/test-utils/node-deps'
import { copyText, scorePage } from '../../../shared/ocr/test-utils/ocr-eval'
import '../../../shared/ocr/test-utils/quality-presets'
import {
  synthesize,
  type FontId,
  type SynthDeps,
  type SynthGt
} from '../../../shared/ocr/test-utils/synth'
import { bundleEntry, type Bundled } from '../test-utils/bundle'
import {
  REPO_ROOT,
  disposeBundles,
  nodeModulesEnginePaths,
  startEngineThread,
  type EngineThread
} from '../test-utils/engine-harness'
import { FakeParent, INIT } from '../test-utils/fake-threads'
import { pageHarness, type PageHarness, type PageRun } from '../test-utils/page-harness'
import { PDFIUM_WASM_PATH } from '../test-utils/pdfium-node'
import { portPair } from '../test-utils/port-pair'
import { perWorkerBudget, threadOptions } from './budget'
import { Coordinator } from './coordinator'
import { loadEngine } from './engine-node'

const SECTIONS = new Set(
  (process.env.PDFX_OCR_BENCH ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
)
const on = (s: string): boolean => SECTIONS.has(s) || SECTIONS.has('all')
const OUT = process.env.PDFX_OCR_BENCH_OUT ?? join(tmpdir(), 'pdfx-ocr-bench')

const list = (v: string | undefined, d: string[]): string[] =>
  v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : d
const range = (n: number): string[] => Array.from({ length: n }, (_, i) => String(i + 1))

/** Every preset tier 1 runs through the pipeline (pipeline.ocr.test.ts), by preset name. */
const PRESETS = list(process.env.PDFX_OCR_BENCH_PRESETS, [
  'clean300',
  'skew2',
  'twocol',
  'fax200',
  'rot90page',
  'rot180page',
  'rot270page',
  'skew5',
  'border-scan',
  'bilevel300',
  'bilevel240',
  'blur1',
  'noise',
  'jpeg35',
  'low150',
  'latin-diacritics',
  'numbers-table',
  'photoLike',
  'smallprint6pt',
  'smallprint6pt-fax',
  'margin-label'
])
const SEEDS = list(process.env.PDFX_OCR_BENCH_SEEDS, range(20)).map(Number)
const FONTS = list(process.env.PDFX_OCR_BENCH_FONTS, [
  'helvetica',
  'times',
  'courier',
  'dejavu-serif'
]) as FontId[]
const THREADS = Number(
  process.env.PDFX_OCR_BENCH_THREADS ?? Math.max(1, Math.min(4, availableParallelism() >> 1))
)
const REPS = Number(process.env.PDFX_OCR_BENCH_REPS ?? 5)
const SCALE_PAGES = Number(process.env.PDFX_OCR_SCALE_PAGES ?? 1000)

/** §3.9.3 tier 2 budgets for the scale test. */
export const SCALE_BUDGET = { utilityRssBytes: 2.5e9, rendererGrowthBytes: 50e6 } as const
/** §3.9.4 R3/R4: the time row, blocking on the Windows runner. */
export const TIME_GATE_MS = 6_000

const langsOf = (preset: string): string[] =>
  preset === 'latin-diacritics' ? ['deu', 'fra', 'spa'] : ['eng']

function quantile(v: number[], q: number): number | null {
  if (v.length === 0) return null
  const s = [...v].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}
const mean = (v: number[]): number | null =>
  v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
const round = (v: number | null, d = 4): number | null =>
  v === null ? null : Math.round(v * 10 ** d) / 10 ** d

function write(section: string, data: unknown): void {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, `${section}.json`), JSON.stringify(data, null, 2) + '\n')
}

/** What one recognised page scores (no text, no boxes: numbers only). */
interface PageRow {
  preset: string
  seed: number
  font: string
  recall: number
  hitOnTarget: number
  medianIou: number | null
  cer: number
  wer: number
  hmean: number
  joins: number
  doubleNewlines: number
  orientation: number
  ms: number
  recognizeMs: number
  /** The recognize thread's WASM heap after the page (bytes; it only grows). */
  heap: number
  pixels: number
}

async function scoreRun(
  run: PageRun,
  gt: SynthGt
): Promise<Omit<PageRow, 'preset' | 'seed' | 'font'>> {
  const sc = await scorePage(run.page, gt)
  const fid = copyFidelity(
    gt.lines.map((l) => l.text.split(' ')),
    copyText(run.page)
  )
  return {
    recall: sc.recall,
    hitOnTarget: sc.hitOnTarget,
    medianIou: sc.medianIou,
    cer: sc.cer,
    wer: sc.wer,
    hmean: sc.hmean,
    joins: fid.joins,
    doubleNewlines: fid.doubleNewlinesWithinLine,
    orientation: run.page.orientation,
    ms: Math.round(run.ms.total),
    recognizeMs: Math.round(run.ms.recognize),
    heap: Math.max(run.first.heap, run.second?.heap ?? 0),
    pixels: run.raster.width * run.raster.height
  }
}

describe.runIf(on('sweep') || on('timing'))('tier 2: sweep and timing', () => {
  let deps: SynthDeps
  const threads: EngineThread[] = []
  const harnesses: PageHarness[] = []

  beforeAll(async () => {
    deps = await loadNodeSynthDeps()
    for (let i = 0; i < Math.max(2, THREADS); i++) {
      const t = await startEngineThread(threads[0]?.engine)
      threads.push(t)
      harnesses.push(await pageHarness(t))
    }
  }, 600_000)

  afterAll(async () => {
    for (const t of threads) await t.dispose()
    disposeBundles()
  })

  it.runIf(on('sweep'))(
    'sweeps seeds × presets × fonts',
    async () => {
      const jobs: { preset: string; seed: number; font: FontId }[] = []
      for (const preset of PRESETS)
        for (const font of FONTS) for (const seed of SEEDS) jobs.push({ preset, seed, font })
      const rows: PageRow[] = []
      let skipped = 0
      let next = 0
      const t0 = performance.now()
      const rssBefore = process.memoryUsage.rss()
      let rssPeak = rssBefore
      const sampler = setInterval(() => {
        rssPeak = Math.max(rssPeak, process.memoryUsage.rss())
      }, 500)
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
          const run = await h.run(r.pdfBytes, r.gt.page, { langs: langsOf(job.preset) })
          rows.push({ ...job, ...(await scoreRun(run, r.gt)) })
        }
      }
      await Promise.all(harnesses.slice(0, THREADS).map((h) => worker(h)))
      clearInterval(sampler)

      // The committed real corpus (§3.9.1), when the maintainers have made it.
      const realManifest = join(REPO_ROOT, 'bench/ocr-real/manifest.json')
      const real: Record<string, unknown> = {}
      let realNote = 'absent: bench/ocr-real/manifest.json does not exist yet'
      try {
        const entries = JSON.parse(readFileSync(realManifest, 'utf8')) as {
          pdf: string
          gt: string
          kind: string
        }[]
        for (const e of entries) {
          const gt = JSON.parse(readFileSync(join(REPO_ROOT, e.gt), 'utf8')) as SynthGt
          const pdf = new Uint8Array(readFileSync(join(REPO_ROOT, e.pdf)))
          const run = await harnesses[0].run(pdf, gt.page, { langs: ['eng'] })
          real[e.pdf] = { kind: e.kind, ...(await scoreRun(run, gt)) }
        }
        realNote = `${entries.length} page(s)`
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }

      const presets: Record<string, unknown> = {}
      for (const p of PRESETS) {
        const pr = rows.filter((r) => r.preset === p)
        if (pr.length === 0) continue
        const col = (k: keyof PageRow): number[] =>
          pr.map((r) => r[k]).filter((v): v is number => typeof v === 'number')
        presets[p] = {
          pages: pr.length,
          recall: { mean: round(mean(col('recall'))), min: round(Math.min(...col('recall'))) },
          hitOnTarget: {
            mean: round(mean(col('hitOnTarget'))),
            min: round(Math.min(...col('hitOnTarget')))
          },
          medianIou: { mean: round(mean(col('medianIou'))) },
          hmean: { mean: round(mean(col('hmean'))) },
          cer: { mean: round(mean(col('cer'))), max: round(Math.max(...col('cer'))) },
          wer: { mean: round(mean(col('wer'))) },
          joins: col('joins').reduce((a, b) => a + b, 0),
          doubleNewlines: col('doubleNewlines').reduce((a, b) => a + b, 0),
          ms: { median: quantile(col('ms'), 0.5), p95: quantile(col('ms'), 0.95) },
          heapP95: quantile(col('heap'), 0.95),
          pixelsMax: Math.max(...col('pixels'))
        }
      }
      const heapSmall = rows.filter((r) => r.pixels <= 12e6).map((r) => r.heap)
      const report = {
        engineThreads: THREADS,
        seeds: SEEDS,
        fonts: FONTS,
        pages: rows.length,
        skipped,
        ms: Math.round(performance.now() - t0),
        memory: {
          // Per recognize thread: the WASM heap (what PER_WORKER budgets); the process figures are
          // for every thread together, this Node process playing the utility process.
          heapP95: quantile(heapSmall, 0.95),
          heapP95Over12MP: quantile(
            rows.filter((r) => r.pixels > 12e6).map((r) => r.heap),
            0.95
          ),
          perWorkerBudget: perWorkerBudget(process.platform),
          processRssBefore: rssBefore,
          processRssPeak: rssPeak,
          processRssDeltaPerThread: Math.round((rssPeak - rssBefore) / THREADS)
        },
        presets,
        real: { note: realNote, pages: real }
      }
      write('sweep', report)
      expect(rows.length).toBeGreaterThan(0)
      // §3.9.4 R3/R4: ≤ 500 MB per thread, whatever the preset.
      expect.soft(report.memory.heapP95 ?? 0).toBeLessThanOrEqual(500e6)
    },
    6 * 3_600_000
  )

  it.runIf(on('timing'))(
    'times the §3.9.4 page end to end at n = 1 and n = 2',
    async () => {
      const out: Record<string, unknown> = { platform: process.platform, reps: REPS }
      for (const preset of ['letter10pt', 'smallprint6pt']) {
        const r = await synthesize({ preset, seed: 1 }, deps)
        const runOnce = (h: PageHarness): Promise<PageRun> =>
          h.run(r.pdfBytes, r.gt.page, { langs: ['eng'] })
        await runOnce(harnesses[0]) // warm-up (engine init, first-use costs)
        const byN: Record<string, unknown> = {}
        for (const n of [1, 2]) {
          const ms: number[] = []
          const rec: number[] = []
          for (let i = 0; i < REPS; i++) {
            const runs = await Promise.all(harnesses.slice(0, n).map((h) => runOnce(h)))
            for (const x of runs) {
              ms.push(x.ms.total)
              rec.push(x.ms.recognize)
            }
          }
          byN[`n${n}`] = {
            median: Math.round(quantile(ms, 0.5)!),
            p95: Math.round(quantile(ms, 0.95)!),
            recognizeMedian: Math.round(quantile(rec, 0.5)!)
          }
        }
        out[preset] = { pixels: r.raster.width * r.raster.height, ...byN }
      }
      write(`timing-${process.platform}`, out)
      if (process.platform === 'win32')
        for (const n of ['n1', 'n2'])
          expect
            .soft(
              (out.letter10pt as Record<string, { median: number }>)[n].median,
              `letter10pt ${n}`
            )
            .toBeLessThanOrEqual(TIME_GATE_MS)
    },
    3_600_000
  )
})

// ---------------------------------------------------------------------------------------------
// The coordinator with its real threads, this process playing the utility process (as
// selftest.ocr.test.ts runs it).

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

describe.runIf(on('scale') || on('too-large'))('tier 2: scale', () => {
  let raster: Bundled
  let recognize: Bundled
  let parent: FakeParent
  let c: Coordinator

  beforeAll(async () => {
    raster = await bundleEntry(here('./raster-thread.ts'), {
      alias: {
        '@embedpdf/pdfium': here('../../../../node_modules/@embedpdf/pdfium/dist/index.cjs')
      }
    })
    recognize = await bundleEntry(here('./recognize-thread.ts'))
    parent = new FakeParent()
    c = new Coordinator({
      parent,
      spawnRaster: () => new Worker(raster.file, threadOptions()),
      spawnRecognize: () => new Worker(recognize.file, threadOptions()),
      loadPdfium: async () => WebAssembly.compile(await readFile(PDFIUM_WASM_PATH)),
      loadEngine,
      system: () => ({
        totalmem: totalmem(),
        availableMemory: totalmem() / 2,
        cpus: availableParallelism()
      }),
      tripwire: () => 0,
      tripwireIntact: () => true,
      electronNet: () => [],
      selfCheck: () => ({ checked: [], failed: [] }),
      rss: () => process.memoryUsage.rss(),
      exit: () => {}
    })
    parent.send({ init: { ...INIT.init, paths: nodeModulesEnginePaths() } })
  }, 120_000)

  afterAll(() => {
    c?.dispose()
    raster?.dispose()
    recognize?.dispose()
  })

  async function heartbeat(): Promise<Heartbeat> {
    const n = parent.sent.length
    parent.send({ heartbeat: {} })
    for (let i = 0; i < 1000; i++) {
      const hb = parent.sent.slice(n).find((m) => 'heartbeat' in (m as object))
      if (hb) return (hb as { heartbeat: Heartbeat }).heartbeat
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('no heartbeat')
  }

  function connect(): { got: FromOcr[]; post: (m: unknown) => void; close: () => void } {
    const [coordinatorEnd, mainEnd] = portPair()
    parent.send({ port: {} }, [coordinatorEnd])
    const got: FromOcr[] = []
    mainEnd.on('message', (e: { data: unknown }) => got.push(e.data as FromOcr))
    return { got, post: (m) => mainEnd.postMessage(m), close: () => mainEnd.close() }
  }

  async function until(pred: () => boolean, ms: number): Promise<void> {
    const end = Date.now() + ms
    while (!pred()) {
      if (Date.now() > end) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  it.runIf(on('scale'))(
    `recognises a ${SCALE_PAGES}-page scan within the memory budgets`,
    async () => {
      const deps = await loadNodeSynthDeps()
      // Distinct pages: 20 seeds of clean300, each copied anew (its own image stream) per page.
      const seeds = await Promise.all(
        range(20).map((s) => synthesize({ preset: 'clean300', seed: Number(s) }, deps))
      )
      const srcDocs = await Promise.all(seeds.map((s) => PDFDocument.load(s.pdfBytes)))
      const doc = await PDFDocument.create()
      for (let i = 0; i < SCALE_PAGES; i++) {
        const [p] = await doc.copyPages(srcDocs[i % srcDocs.length], [0])
        doc.addPage(p)
      }
      const bytes = await doc.save({ useObjectStreams: false })
      const frame = seeds[0].gt.page

      const rssBefore = process.memoryUsage.rss()
      let rssPeak = rssBefore
      const sampler = setInterval(() => {
        rssPeak = Math.max(rssPeak, process.memoryUsage.rss())
      }, 1000)
      const t0 = performance.now()
      const port = connect()
      port.post({ open: { src: 'scale', bytes } })
      await until(() => port.got.some((m) => 'opened' in m || 'error' in m), 120_000)
      const pages = Array.from({ length: SCALE_PAGES }, (_, i) => i)
      port.post({ triage: { src: 'scale', pages } })
      await until(() => port.got.some((m) => 'triaged' in m && m.triaged.done), 3_600_000)
      const triageMs = performance.now() - t0
      port.post({
        recognize: {
          jobId: 'scale',
          src: 'scale',
          pages: pages.map((index) => ({ index, userUnit: 1, ...frame })),
          opts: { langs: ['eng'] }
        }
      })
      await until(() => port.got.some((m) => 'jobDone' in m), 5 * 3_600_000)
      clearInterval(sampler)
      const ms = performance.now() - t0
      const hb = await heartbeat()

      const statuses: Record<string, number> = {}
      let retained = 0
      for (const m of port.got) {
        if (!('result' in m)) continue
        const p = m.result.page
        statuses[p.status] = (statuses[p.status] ?? 0) + 1
        const rec = p.recognition
        if (!rec) continue
        // What the renderer's store keeps per page: the packed arrays and the text.
        retained += rec.text.length * 2
        for (const a of [
          rec.wordOff,
          rec.wordGeom,
          rec.wordLine,
          rec.lineGeom,
          rec.charOff,
          rec.charEdges
        ])
          retained += a?.byteLength ?? 0
      }
      const done = port.got.find((m) => 'jobDone' in m) as {
        jobDone: { done: number; failed: number }
      }
      port.post({ close: 'scale' })
      port.close()
      const report = {
        pages: SCALE_PAGES,
        sourceBytes: bytes.byteLength,
        ms: Math.round(ms),
        triageMs: Math.round(triageMs),
        msPerPage: Math.round(ms / SCALE_PAGES),
        concurrency: hb.concurrency,
        statuses,
        jobDone: done.jobDone,
        utilityRss: { before: rssBefore, peak: rssPeak, budget: SCALE_BUDGET.utilityRssBytes },
        rendererGrowthEstimate: {
          retainedPackedBytes: retained,
          budget: SCALE_BUDGET.rendererGrowthBytes,
          note: 'retained bytes of every packed result (the ocr-store holds these); not a measured renderer'
        },
        tripwire: hb.tripwire
      }
      write('scale', report)
      expect(done.jobDone.done).toBe(SCALE_PAGES)
      expect(statuses.ok).toBe(SCALE_PAGES)
      expect(rssPeak).toBeLessThanOrEqual(SCALE_BUDGET.utilityRssBytes)
      expect(retained).toBeLessThanOrEqual(SCALE_BUDGET.rendererGrowthBytes)
      expect(hb.tripwire).toEqual({ process: 0, raster: 0, recognize: 0 })
    },
    6 * 3_600_000
  )

  it.runIf(on('too-large'))(
    'refuses a source over 1.5 GiB and survives one at it',
    async () => {
      const dir = join(OUT, 'sparse')
      mkdirSync(dir, { recursive: true })
      const sparse = (name: string, size: number): Uint8Array => {
        const f = join(dir, name)
        const fd = openSync(f, 'w')
        ftruncateSync(fd, size) // sparse where the filesystem supports it
        closeSync(fd)
        const b = readFileSync(f)
        rmSync(f)
        return b
      }
      const results: Record<string, unknown> = {}
      for (const [src, size] of [
        ['over', OCR_LIMITS.maxSourceBytes + 1],
        ['at', OCR_LIMITS.maxSourceBytes]
      ] as const) {
        const port = connect()
        const t0 = performance.now()
        let bytes: Uint8Array | null = sparse(`${src}.bin`, size)
        port.post({ open: { src, bytes } })
        bytes = null
        await until(
          () =>
            port.got.some(
              (m) => ('opened' in m || 'error' in m) && JSON.stringify(m).includes(`"${src}"`)
            ),
          600_000
        )
        const answer = port.got.find((m) => 'opened' in m || 'error' in m)!
        const hb = await heartbeat()
        results[src] = {
          bytes: size,
          answer: 'error' in answer ? { error: answer.error.code } : { opened: true },
          ms: Math.round(performance.now() - t0),
          aliveAfter: !!hb,
          rss: process.memoryUsage.rss()
        }
        port.post({ close: src })
        port.close()
        if (src === 'over') expect('error' in answer && answer.error.code).toBe('too-large')
      }
      rmSync(dir, { recursive: true, force: true })
      write('too-large', { ceiling: OCR_LIMITS.maxSourceBytes, results })
    },
    1_800_000
  )
})
