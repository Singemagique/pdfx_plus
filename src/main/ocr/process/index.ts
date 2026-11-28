// The "pdfx-ocr" utilityProcess entry (DESIGN.md §3.3.1). The supervisor forks this file's
// `?modulePath` bundle; it starts the raster and recognize worker_threads from their own
// `?modulePath` bundles (PR0 proved both load from inside app.asar with no asarUnpack).
//
// Nothing here imports `electron`: `process.parentPort` is a global in a utility process. The
// tripwire import must stay first so it runs before any other module of this realm.
import { electronNetStubbed, tripwireCount, tripwireIntact } from './no-network'
import { readFile } from 'node:fs/promises'
import { availableParallelism, totalmem } from 'node:os'
import { Worker } from 'node:worker_threads'
import rasterThreadPath from './raster-thread?modulePath'
import recognizeThreadPath from './recognize-thread?modulePath'
import { Coordinator, type ParentLike, type WorkerLike } from './coordinator'
import { STUB_ENGINE_WASM } from './stub-engine'

const parent = (process as unknown as { parentPort?: ParentLike }).parentPort
if (!parent) throw new Error('the OCR coordinator must run in an Electron utility process')

// The Emscripten glue's quit() sets process.exitCode; nothing in this process may leave a stale
// one behind, so a clean shutdown always exits 0 (§3.2.2).
process.exitCode = 0

function spawn(path: string): WorkerLike {
  // stdout/stderr of the threads go to this process's pipes, which the supervisor drains.
  return new Worker(path)
}

const availableMemory = (): number => {
  const p = process as unknown as { availableMemory?: () => number }
  return typeof p.availableMemory === 'function' ? p.availableMemory() : totalmem() / 2
}

new Coordinator({
  parent,
  spawnRaster: () => spawn(rasterThreadPath),
  spawnRecognize: () => spawn(recognizeThreadPath),
  loadPdfium: async (path) => WebAssembly.compile(await readFile(path)),
  loadEngine: async () => WebAssembly.compile(STUB_ENGINE_WASM),
  system: () => ({
    totalmem: totalmem(),
    availableMemory: availableMemory(),
    cpus: availableParallelism()
  }),
  tripwire: tripwireCount,
  tripwireIntact,
  electronNet: electronNetStubbed,
  rss: () => process.memoryUsage.rss(),
  exit: (code) => process.exit(code)
})
