// A recognize worker_thread (DESIGN.md §3.3.1, §3.4.5–§3.4.6). It receives, once, the
// coordinator's compiled core (a WebAssembly.Module, SHA-checked there), the glue's directory and
// the verified .traineddata.gz files (SharedArrayBuffers), then one transferred grey bitmap per
// page. Per page: tess-core → hOCR → strict parse → RawOcr, posted back as small JSON; the
// coordinator maps it to a packed OcrPage (map.ts). The watchdog, cancel-by-terminate, recycling
// (50 pages / any page > 12 MP) and the failure policy live in the coordinator.
//
// Engines are built per language set: a page whose job wants other languages ends the current
// engine and builds a new one (gunzip + Init, ~0.1–0.25 s; PR0). After an abort, a quit or a WASM
// OOM the module is never trusted again: the error goes back and the coordinator retires the thread.
//
// The tripwire import must stay first: each thread is its own realm (§3.3.1).
import { tripwireCount, tripwireSelfCheck } from './no-network'
import { parentPort } from 'node:worker_threads'
import {
  createTess,
  TessError,
  type Tess,
  type TessFactory
} from '../../../shared/ocr/engine/tess-core'
import { gunzipTraineddata, loadGlue } from './engine-node'
import { recognizePage } from './recognize-core'
import type { EngineAssets, FromRecognize, ToRecognize } from './thread-messages'

const port = parentPort
if (!port) throw new Error('recognize-thread must run in a worker_thread')

let assets: EngineAssets | null = null
let factory: TessFactory | null = null
let tess: Tess | null = null
let tessKey = ''

function post(msg: FromRecognize): void {
  port!.postMessage(msg)
}

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

/** Name and message for the coordinator's failure policy; never page content. */
function describe(e: unknown): { name: string; message: string } {
  if (e instanceof TessError) {
    // The coordinator treats these as OOM-shaped (respawn, re-queue once, halve n).
    if (e.kind === 'oom') return { name: 'OcrOutOfMemory', message: `out of memory: ${e.message}` }
    return { name: e.kind === 'abort' ? 'RuntimeError' : 'TessError', message: e.message }
  }
  const err = e instanceof Error ? e : new Error('non-Error throw')
  return { name: err.name, message: err.message.slice(0, 300) }
}

async function handle(msg: ToRecognize): Promise<void> {
  if (msg.type === 'init') {
    assets = msg.engine
    // SHA-checked here, in the realm that runs it, immediately before the require.
    factory = loadGlue(assets.coreDir)
    post({ type: 'ready', tripwire: tripwireCount(), selfCheckFailed: tripwireSelfCheck().failed })
    return
  }
  try {
    const data = new Uint8Array(msg.data)
    if (data.length !== msg.width * msg.height) throw new RangeError('bitmap size mismatch')
    const engine = await engineFor(msg.langs)
    let stderrLines = 0
    const result = recognizePage(
      {
        recognize: (img, params) => {
          const r = engine.recognize(img, params)
          stderrLines += r.stderrLines
          return r
        }
      },
      { width: msg.width, height: msg.height, data },
      msg.dpi,
      { returnHocr: msg.returnHocr === true }
    )
    post({
      type: 'result',
      taskId: msg.taskId,
      result,
      heap: engine.heapBytes(),
      stderrLines,
      tripwire: tripwireCount()
    })
  } catch (e) {
    post({ type: 'error', taskId: msg.taskId, ...describe(e), tripwire: tripwireCount() })
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
