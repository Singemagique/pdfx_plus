// The raster worker_thread (DESIGN.md §3.3.1): one per utility process, PDFium WASM inside. Started
// by the coordinator from its own `?modulePath` bundle. The message loop only; the PDFium logic is
// raster-core.ts.
//
// The tripwire import must stay first: each thread is its own realm (§3.3.1).
import { tripwireCount, tripwireSelfCheck } from './no-network'
import { parentPort } from 'node:worker_threads'
import { init } from '@embedpdf/pdfium'
import { RasterEngine, makePrintErr, type PdfiumRaster } from './raster-core'
import type { FromRaster, ToRaster } from './thread-messages'

const port = parentPort
if (!port) throw new Error('raster-thread must run in a worker_thread')

let engine: RasterEngine | null = null
/** Set after any throw out of PDFium: the module is never trusted again (§3.3.4). */
let poisoned = false

function post(msg: FromRaster, transfer?: ArrayBuffer[]): void {
  port!.postMessage(msg, transfer)
}

function errText(e: unknown): string {
  // Error names and PDFium's abort text only; never document data.
  return e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : 'non-Error throw'
}

async function start(msg: Extract<ToRaster, { type: 'init' }>): Promise<void> {
  let pending: RasterEngine | null = null
  const lines: string[] = []
  const mod = (await init({
    // The coordinator compiled pdfium.wasm once and posted the Module: no file read or fetch path
    // in the Emscripten glue is ever reached.
    instantiateWasm: (
      imports: WebAssembly.Imports,
      done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
    ) => {
      void WebAssembly.instantiate(msg.pdfium, imports).then((instance) =>
        done(instance, msg.pdfium)
      )
      return {}
    },
    print: () => {},
    // Captured, never silenced: "Cannot enlarge memory" during a render is the silent-blank signal.
    printErr: makePrintErr(() => pending, lines)
  } as unknown as Parameters<typeof init>[0])) as unknown as PdfiumRaster & {
    PDFiumExt_Init(): void
  }
  mod.PDFiumExt_Init()
  pending = new RasterEngine(mod, msg.limits)
  for (const l of lines) pending.noteStderr(l)
  engine = pending
  post({ type: 'ready', tripwire: tripwireCount(), selfCheckFailed: tripwireSelfCheck().failed })
}

function handle(msg: ToRaster): void {
  if (msg.type === 'init') {
    start(msg).catch((e) => {
      poisoned = true
      post({ type: 'fatal', taskId: null, error: errText(e), tripwire: tripwireCount() })
    })
    return
  }
  if (poisoned || !engine) {
    if (msg.type === 'render' || msg.type === 'open')
      post({
        type: 'fatal',
        taskId: msg.type === 'render' ? msg.taskId : null,
        error: poisoned ? 'raster module poisoned' : 'raster not initialised',
        tripwire: tripwireCount()
      })
    return
  }
  const taskId = msg.type === 'render' ? msg.taskId : null
  try {
    if (msg.type === 'open') {
      engine.attach(msg.src, new Uint8Array(msg.data))
      if (!msg.count) return
      const r = engine.pageCount(msg.src)
      if ('pageCount' in r)
        post({ type: 'opened', src: msg.src, pageCount: r.pageCount, tripwire: tripwireCount() })
      else
        post({
          type: 'open-failed',
          src: msg.src,
          pdfiumError: r.pdfiumError,
          tripwire: tripwireCount()
        })
    } else if (msg.type === 'close') {
      engine.close(msg.src)
    } else if (msg.type === 'render') {
      const out = engine.render(msg)
      const heap = engine.heapBytes()
      if (out.kind === 'ok') {
        const data = out.data.buffer as ArrayBuffer
        post(
          {
            type: 'rendered',
            taskId: msg.taskId,
            width: out.width,
            height: out.height,
            dpi: out.dpi,
            data,
            heap,
            tripwire: tripwireCount()
          },
          [data]
        )
      } else if (out.kind === 'heap-exhausted') {
        post({ type: 'heap-exhausted', taskId: msg.taskId, heap, tripwire: tripwireCount() })
      } else {
        post({
          type: 'render-failed',
          taskId: msg.taskId,
          status: out.status,
          reason: out.reason,
          heap,
          tripwire: tripwireCount()
        })
      }
    }
  } catch (e) {
    // A WebAssembly.RuntimeError (trap, or `Aborted(...)` after "Cannot enlarge memory") or any
    // other throw. After an abort the module still answers calls (PR0), so never reuse it.
    poisoned = true
    post({ type: 'fatal', taskId, error: errText(e), tripwire: tripwireCount() })
  }
}

port.on('message', (msg: ToRaster) => handle(msg))
