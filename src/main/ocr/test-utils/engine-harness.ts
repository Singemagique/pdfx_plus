// Test-only: the REAL Tesseract engine from node_modules (the same bytes electron-builder copies to
// resources/ocr, checked against the manifest) inside the REAL recognize thread, bundled the way
// `?modulePath` bundles it, so tier-1 tests run the production loader, glue, data checks, pass plan
// and hOCR parse with the thread's own network tripwire installed.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'

import type { OcrPaths } from '../../../shared/ocr/protocol'
import type { GrayImage } from '../../../shared/ocr/engine/types'
import { threadOptions } from '../process/budget'
import { ENGINE_CORE, ENGINE_DATA } from '../process/engine-manifest'
import { loadEngine } from '../process/engine-node'
import type { LoadedEngine } from '../process/coordinator'
import type { RecognizeOutcome } from '../process/recognize-core'
import type { FromRecognize, ToRecognize } from '../process/thread-messages'
import { bundleEntry, type Bundled } from './bundle'
import { PDFIUM_WASM_PATH } from './pdfium-node'

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** The engine paths main would pass in dev: node_modules, exactly the extraResources sources. */
export function nodeModulesEnginePaths(): OcrPaths {
  return {
    pdfiumWasm: PDFIUM_WASM_PATH,
    ocrCore: dirname(join(REPO_ROOT, ENGINE_CORE.wasm.source)),
    tessdata: Object.fromEntries(
      Object.entries(ENGINE_DATA).map(([lang, f]) => [lang, join(REPO_ROOT, f.source)])
    )
  }
}

export interface RecognizeReply {
  outcome: RecognizeOutcome
  heap: number
  stderrLines: number
  tripwire: number
}

export interface EngineThread {
  engine: LoadedEngine
  recognize(
    img: GrayImage,
    dpi: number,
    langs: string[],
    returnHocr?: boolean
  ): Promise<RecognizeReply>
  /** The thread's tripwire counter as of its last message. */
  readonly tripwire: number
  /** Bytes the thread wrote to its real stdout and stderr. */
  readonly stdioBytes: number
  dispose(): Promise<void>
}

let bundled: Promise<Bundled> | null = null
const bundles: Bundled[] = []

/** Bundle the recognize thread once per test file. */
function recognizeBundle(): Promise<Bundled> {
  bundled ??= bundleEntry(
    fileURLToPath(new URL('../process/recognize-thread.ts', import.meta.url))
  ).then((b) => {
    bundles.push(b)
    return b
  })
  return bundled
}

/** Remove the bundles this file created. */
export function disposeBundles(): void {
  for (const b of bundles.splice(0)) b.dispose()
  bundled = null
}

/** Start one real recognize thread with the node_modules engine. */
export async function startEngineThread(engine?: LoadedEngine): Promise<EngineThread> {
  const loaded = engine ?? (await loadEngine(nodeModulesEnginePaths()))
  const b = await recognizeBundle()
  // The production heap caps, plus the thread's own stdout/stderr captured (not inherited), so a test
  // can assert the engine printed nothing at all (§3.9.4: 0 bytes).
  const worker = new Worker(b.file, { ...threadOptions(), stdout: true, stderr: true })
  let stdioBytes = 0
  worker.stdout.on('data', (d: Buffer) => (stdioBytes += d.length))
  worker.stderr.on('data', (d: Buffer) => (stdioBytes += d.length))
  let tripwire = 0
  let seq = 0
  const waiting = new Map<number, { resolve(r: RecognizeReply): void; reject(e: Error): void }>()
  let ready!: () => void
  let failed: Error | null = null
  const readyP = new Promise<void>((r) => (ready = r))
  worker.on('message', (m: FromRecognize) => {
    tripwire = m.tripwire
    if (m.type === 'ready') ready()
    else if (m.type === 'result')
      waiting.get(m.taskId)?.resolve({
        outcome: m.result,
        heap: m.heap,
        stderrLines: m.stderrLines,
        tripwire: m.tripwire
      })
    else waiting.get(m.taskId)?.reject(new Error(`${m.name}: ${m.message}`))
    if (m.type !== 'ready') waiting.delete(m.taskId)
  })
  worker.on('error', (e) => {
    failed = e
    for (const w of waiting.values()) w.reject(e)
    waiting.clear()
  })
  worker.postMessage({ type: 'init', engine: loaded.assets } satisfies ToRecognize)
  await readyP
  return {
    engine: loaded,
    get stdioBytes() {
      return stdioBytes
    },
    get tripwire() {
      return tripwire
    },
    recognize(img, dpi, langs, returnHocr = false) {
      if (failed) return Promise.reject(failed)
      const taskId = ++seq
      const copy = new Uint8Array(img.width * img.height)
      copy.set(img.data.subarray(0, copy.length))
      return new Promise<RecognizeReply>((resolve, reject) => {
        waiting.set(taskId, { resolve, reject })
        const msg: ToRecognize = {
          type: 'recognize',
          taskId,
          width: img.width,
          height: img.height,
          dpi,
          data: copy.buffer,
          langs,
          returnHocr
        }
        worker.postMessage(msg, [copy.buffer])
      })
    },
    async dispose() {
      await worker.terminate()
    }
  }
}
