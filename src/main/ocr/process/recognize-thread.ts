// A recognize worker_thread (DESIGN.md §3.3.1). PR4a SKELETON: it receives the coordinator's
// compiled WebAssembly.Module once (the same posting path the Tesseract core will use: one artifact,
// SHA-checked once in the coordinator; §3.2.2) and a transferred grey bitmap per page, instantiates
// the module to prove it arrived usable, and returns a stub result describing the bitmap. PR5
// replaces the body of `recognize` with tess-core + preprocess + hOCR parse + map; the watchdog,
// terminate-on-cancel and recycling plumbing already lives in the coordinator.
//
// The tripwire import must stay first: each thread is its own realm (§3.3.1).
import { tripwireCount, tripwireSelfCheck } from './no-network'
import { parentPort } from 'node:worker_threads'
import type { StubRecognition } from '../../../shared/ocr/protocol'
import type { FromRecognize, ToRecognize } from './thread-messages'

const port = parentPort
if (!port) throw new Error('recognize-thread must run in a worker_thread')

let instance: WebAssembly.Instance | null = null

function post(msg: FromRecognize): void {
  port!.postMessage(msg)
}

/** What the stub "recognises": the bitmap's mean grey and ink fraction (proves the pixels arrived). */
function describeBitmap(width: number, height: number, data: Uint8Array): StubRecognition {
  let sum = 0
  let ink = 0
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    sum += v
    if (v < 128) ink++
  }
  const n = Math.max(1, data.length)
  return { stub: true, width, height, meanGrey: sum / n, inkFrac: ink / n }
}

async function handle(msg: ToRecognize): Promise<void> {
  if (msg.type === 'init') {
    instance = await WebAssembly.instantiate(msg.engine, {})
    post({ type: 'ready', tripwire: tripwireCount(), selfCheckFailed: tripwireSelfCheck().failed })
    return
  }
  try {
    if (!instance) throw new Error('engine not initialised')
    const data = new Uint8Array(msg.data)
    if (data.length !== msg.width * msg.height) throw new RangeError('bitmap size mismatch')
    post({
      type: 'result',
      taskId: msg.taskId,
      result: describeBitmap(msg.width, msg.height, data),
      tripwire: tripwireCount()
    })
  } catch (e) {
    const err = e instanceof Error ? e : new Error('non-Error throw')
    post({
      type: 'error',
      taskId: msg.taskId,
      name: err.name,
      message: err.message.slice(0, 300),
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
