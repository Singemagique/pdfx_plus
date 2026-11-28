// Tier 1: the packaged self-test's session (`pdfx --ocr-selftest`) against the REAL coordinator,
// raster thread, recognize thread and engine, on the clean300 page it ships. This is also where its
// expected result is recorded (`yarn ocr:record` writes selftest-clean300.json): the packaged app
// must then reproduce the same digest under Electron's Node, and every thread's tripwire stays 0.
// It is the end-to-end check of PR5's coordinator path: render → recognize → RawOcr → map → pack,
// assembled by page index and posted with no transfer list.

import { readFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { availableParallelism, totalmem } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { FromOcr, Heartbeat, PageResult } from '../../shared/ocr/protocol'
import { loadNodeSynthDeps } from '../../shared/ocr/test-utils/node-deps'
import { synthesize } from '../../shared/ocr/test-utils/synth'
import { threadOptions } from './process/budget'
import { Coordinator } from './process/coordinator'
import { loadEngine } from './process/engine-node'
import {
  packedCopyText,
  packedDigest,
  selftestSession,
  SELFTEST_DPI,
  SELFTEST_PAGE_CLASS
} from './selftest'
import { SELFTEST, selftestPdf, type SelftestFixture } from './selftest-fixture'
import { bundleEntry, type Bundled } from './test-utils/bundle'
import { nodeModulesEnginePaths } from './test-utils/engine-harness'
import { FakeParent, INIT } from './test-utils/fake-threads'
import { RECORD } from './test-utils/ocr-cache'
import { PDFIUM_WASM_PATH } from './test-utils/pdfium-node'
import { portPair } from './test-utils/port-pair'

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

let raster: Bundled
let recognize: Bundled
let parent: FakeParent
let c: Coordinator

beforeAll(async () => {
  raster = await bundleEntry(here('./process/raster-thread.ts'), {
    alias: { '@embedpdf/pdfium': here('../../../node_modules/@embedpdf/pdfium/dist/index.cjs') }
  })
  recognize = await bundleEntry(here('./process/recognize-thread.ts'))
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
}, 60_000)

afterAll(() => {
  c?.dispose()
  raster?.dispose()
  recognize?.dispose()
})

async function heartbeat(): Promise<Heartbeat> {
  const n = parent.sent.length
  parent.send({ heartbeat: {} })
  for (let i = 0; i < 200; i++) {
    const hb = parent.sent.slice(n).find((m) => 'heartbeat' in (m as object))
    if (hb) return (hb as { heartbeat: Heartbeat }).heartbeat
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('no heartbeat')
}

/** Record mode: run the page once through the coordinator and write the fixture. */
async function record(pdf: Uint8Array, page: { width: number; height: number }): Promise<void> {
  const [coordinatorEnd, mainEnd] = portPair()
  parent.send({ port: {} }, [coordinatorEnd])
  const got: FromOcr[] = []
  mainEnd.on('message', (e: { data: unknown }) => got.push(e.data as FromOcr))
  mainEnd.postMessage({ open: { src: 'rec', bytes: pdf } })
  // As the session does: triage first, so the recorded page carries triage's class.
  mainEnd.postMessage({ triage: { src: 'rec', pages: [0] } })
  for (let i = 0; i < 6000 && !got.some((m) => 'triaged' in m && m.triaged.done); i++)
    await new Promise((r) => setTimeout(r, 10))
  mainEnd.postMessage({
    recognize: {
      jobId: 'rec',
      src: 'rec',
      pages: [{ index: 0, userUnit: 1, ...page }],
      opts: { langs: ['eng'], renderDpi: SELFTEST_DPI }
    }
  })
  for (let i = 0; i < 6000 && !got.some((m) => 'jobDone' in m); i++)
    await new Promise((r) => setTimeout(r, 10))
  const r = got.find((m) => 'result' in m) as { result: { page: PageResult } } | undefined
  const rec = r?.result.page.recognition
  if (!rec) throw new Error('record: no recognition')
  const fixture: SelftestFixture = {
    preset: 'clean300',
    seed: 1,
    pdfBase64: Buffer.from(pdf).toString('base64'),
    page,
    dpi: SELFTEST_DPI,
    langs: ['eng'],
    expected: {
      status: r.result.page.status,
      words: rec.wordOff.length - 1,
      digest: packedDigest(rec),
      text: packedCopyText(rec)
    }
  }
  writeFileSync(here('./selftest-clean300.json'), JSON.stringify(fixture, null, 2) + '\n')
  mainEnd.close()
}

describe('the packaged self-test session, real engine', () => {
  it('ships the clean300 page the synth harness makes today', async () => {
    const { pdfBytes, gt } = await synthesize(
      { preset: 'clean300', seed: 1 },
      await loadNodeSynthDeps()
    )
    if (RECORD) {
      await record(pdfBytes, gt.page)
      return
    }
    expect(SELFTEST.page).toEqual(gt.page)
    expect(Buffer.from(selftestPdf()).equals(Buffer.from(pdfBytes))).toBe(true)
  })

  it('recognises it exactly as recorded, every tripwire at 0', async () => {
    if (RECORD) return
    const [coordinatorEnd, mainEnd] = portPair()
    parent.send({ port: {} }, [coordinatorEnd])
    const report = await selftestSession(mainEnd, heartbeat)
    expect(report.failures).toEqual([])
    expect(report.ok).toBe(true)
    // Triage ran first in the real raster thread and its class reached the packed page.
    expect(report.triage).toMatchObject({ pageClass: SELFTEST_PAGE_CLASS, renderDpi: 300 })
    expect(report.page).toMatchObject({
      status: 'ok',
      renderDpi: 300,
      raster: { width: 1800, height: 750 },
      digestMatches: true,
      textMatches: true,
      pageClass: SELFTEST_PAGE_CLASS
    })
    expect(report.page!.words).toBeGreaterThan(100)
    expect(report.heartbeat?.tripwire).toEqual({ process: 0, raster: 0, recognize: 0 })
    expect(report.messagesValid).toBe(true)
  })
})
