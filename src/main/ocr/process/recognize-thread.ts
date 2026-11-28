// A recognize worker_thread (DESIGN.md §3.3.1, §3.4.5–§3.4.6). It receives, once, the
// coordinator's compiled core (a WebAssembly.Module, SHA-checked there), the glue's directory and
// the verified .traineddata.gz files (SharedArrayBuffers), then one transferred grey bitmap per
// page. Per page: the PR6 pipeline (recognize-core.ts: preprocessing, orientation, deskew, the pass
// plan and retries over tess-core → hOCR → strict parse → RawOcr), posted back as small JSON with
// the copy's affine; the coordinator maps it to a packed OcrPage (map.ts). The watchdog, cancel-by-terminate, recycling
// (50 pages / any page > 12 MP) and the failure policy live in the coordinator.
//
// Engines are built per language set: a page whose job wants other languages ends the current
// engine and builds a new one (gunzip + Init, ~0.1–0.25 s; PR0). After an abort, a quit or a WASM
// OOM the module is never trusted again: the error goes back and the coordinator retires the thread.
//
// The tripwire import must stay first: each thread is its own realm (§3.3.1).
import { tripwireCount, tripwireSelfCheck } from './no-network'
import { parentPort } from 'node:worker_threads'
import { createTess, type Tess, type TessFactory } from '../../../shared/ocr/engine/tess-core'
import { gunzipTraineddata, loadGlue } from './engine-node'
import {
  describeRecognizeError,
  recognizePage,
  recognizePageAsync,
  recognizeRawPass1
} from './recognize-core'
import type { EngineAssets, FromRecognize, ToRecognize } from './thread-messages'

const port = parentPort
if (!port) throw new Error('recognize-thread must run in a worker_thread')

let assets: EngineAssets | null = null
/** `add-data` that arrived before `init` (the coordinator queues it behind init; belt and braces). */
const early: Record<string, SharedArrayBuffer> = {}
let factory: TessFactory | null = null
let tess: Tess | null = null
let tessKey = ''

function post(msg: FromRecognize, transfer?: ArrayBuffer[]): void {
  port!.postMessage(msg, transfer)
}

/** PROTOTYPE: page tasks waiting for their units. */
const waitingUnits = new Map<number, (hocr: string[]) => void>()

async function engineFor(langs: readonly string[]): Promise<Tess> {
  if (!assets || !factory) throw new Error('engine not initialised')
  const key = langs.join('+')
  if (tess && !tess.broken && tessKey === key) return tess
  tess?.end()
  tess = null
  const traineddata: Record<string, Uint8Array> = {}
  for (const l of langs) {
    const gz = Object.hasOwn(assets.data, l) ? assets.data[l] : undefined
    if (!gz) throw new Error(`language ${l} is not available`)
    traineddata[l] = gunzipTraineddata(l, new Uint8Array(gz))
  }
  tess = await createTess({ factory, wasmModule: assets.module, traineddata }, langs)
  tessKey = key
  return tess
}

async function handle(msg: ToRecognize): Promise<void> {
  if (msg.type === 'add-data') {
    // Checked by the coordinator; checked again (gz and raw) when an engine is built from it.
    if (assets) assets = { ...assets, data: { ...assets.data, ...msg.data } }
    else Object.assign(early, msg.data)
    return
  }
  if (msg.type === 'init') {
    assets = { ...msg.engine, data: { ...msg.engine.data, ...early } }
    // SHA-checked here, in the realm that runs it, immediately before the require.
    factory = loadGlue(assets.coreDir)
    post({ type: 'ready', tripwire: tripwireCount(), selfCheckFailed: tripwireSelfCheck().failed })
    return
  }
  if (msg.type === 'units-done') {
    waitingUnits.get(msg.taskId)?.(msg.hocr)
    waitingUnits.delete(msg.taskId)
    return
  }
  if (msg.type === 'unit') {
    try {
      const engine = await engineFor(msg.langs)
      const img = { width: msg.width, height: msg.height, data: new Uint8Array(msg.data) }
      const { hocr } = engine.recognize(img, msg.params)
      post({ type: 'unit-result', taskId: msg.taskId, hocr, tripwire: tripwireCount() })
    } catch (e) {
      post({
        type: 'error',
        taskId: msg.taskId,
        ...describeRecognizeError(e),
        tripwire: tripwireCount()
      })
    }
    return
  }
  try {
    const data = new Uint8Array(msg.data)
    if (data.length !== msg.width * msg.height) throw new RangeError('bitmap size mismatch')
    const engine = await engineFor(msg.langs)
    let stderrLines = 0
    const counted = {
      recognize: (
        img: Parameters<Tess['recognize']>[0],
        params: Parameters<Tess['recognize']>[1]
      ) => {
        const r = engine.recognize(img, params)
        stderrLines += r.stderrLines
        return r
      },
      layout: (img: Parameters<Tess['layout']>[0], params: Parameters<Tess['layout']>[1]) =>
        engine.layout(img, params),
      recognizeLaidOut: () => {
        const r = engine.recognizeLaidOut()
        stderrLines += r.stderrLines
        return r
      }
    }
    const img = { width: msg.width, height: msg.height, data }
    const result = msg.rawPass1
      ? recognizeRawPass1(counted, img, msg.dpi, msg.returnHocr === true)
      : msg.delegateUnits
        ? await recognizePageAsync(counted, img, msg.dpi, {
            returnHocr: msg.returnHocr === true,
            reuse: msg.reuse,
            adaptive: msg.adaptive,
            prior: msg.editRotation,
            calibration: msg.calibration,
            units: (jobs) =>
              new Promise<string[]>((resolve) => {
                waitingUnits.set(msg.taskId, resolve)
                const out = jobs.map((j) => {
                  const d = j.image.data.slice()
                  return {
                    width: j.image.width,
                    height: j.image.height,
                    data: d.buffer,
                    params: j.params
                  }
                })
                post(
                  { type: 'units', taskId: msg.taskId, jobs: out, tripwire: tripwireCount() },
                  out.map((o) => o.data)
                )
              })
          })
        : recognizePage(counted, img, msg.dpi, {
            returnHocr: msg.returnHocr === true,
            reuse: msg.reuse,
            adaptive: msg.adaptive,
            prior: msg.editRotation,
            calibration: msg.calibration
          })
    post({
      type: 'result',
      taskId: msg.taskId,
      result,
      heap: engine.heapBytes(),
      stderrLines,
      tripwire: tripwireCount()
    })
  } catch (e) {
    post({
      type: 'error',
      taskId: msg.taskId,
      ...describeRecognizeError(e),
      tripwire: tripwireCount()
    })
  }
}

port.on('message', (msg: ToRecognize) => {
  handle(msg).catch((e: unknown) => {
    // Only init can get here (recognize catches its own errors). Rethrow outside the promise so the
    // thread dies with an 'error' event and the coordinator respawns it.
    setImmediate(() => {
      throw e
    })
  })
})
