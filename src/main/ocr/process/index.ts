// The "pdfx-ocr" utilityProcess entry (DESIGN.md §3.3.1). The supervisor forks this file's
// `?modulePath` bundle; it starts the raster and recognize worker_threads from their own
// `?modulePath` bundles (PR0 proved both load from inside app.asar with no asarUnpack).
//
// Nothing here imports `electron`: `process.parentPort` is a global in a utility process. The
// tripwire import must stay first so it runs before any other module of this realm.
import {
  allowThreadEntries,
  electronNetStubbed,
  tripwireCount,
  tripwireIntact,
  tripwireSelfCheck
} from './no-network'
import { readFile } from 'node:fs/promises'
import { availableParallelism, totalmem } from 'node:os'
import { Worker } from 'node:worker_threads'
import rasterThreadPath from './raster-thread?modulePath'
import recognizeThreadPath from './recognize-thread?modulePath'
import { threadOptions } from './budget'
import { Coordinator, type ParentLike, type WorkerLike } from './coordinator'
import { loadEngine, loadLanguage } from './engine-node'

// The only files a worker_thread may be started from in this realm (no-network.ts guards Worker).
allowThreadEntries([rasterThreadPath, recognizeThreadPath])
// Proven here, in the realm itself, before anything else runs; reported to main in `ready`.
const selfCheck = tripwireSelfCheck()

const parent = (process as unknown as { parentPort?: ParentLike }).parentPort
if (!parent) throw new Error('the OCR coordinator must run in an Electron utility process')

// The Emscripten glue's quit() sets process.exitCode; nothing in this process may leave a stale
// one behind, so a clean shutdown always exits 0 (§3.2.2).
process.exitCode = 0

function spawn(path: string): WorkerLike {
  // stdout/stderr of the threads go to this process's pipes, which the supervisor drains. The heap
  // caps turn most of a thread's V8 OOMs into ERR_WORKER_OUT_OF_MEMORY instead of a dead or hung
  // process; one big allocation past the cap still aborts the process (budget.ts).
  return new Worker(path, threadOptions())
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
  loadEngine,
  loadLanguage,
  system: () => ({
    totalmem: totalmem(),
    availableMemory: availableMemory(),
    cpus: availableParallelism()
  }),
  tripwire: tripwireCount,
  tripwireIntact,
  electronNet: electronNetStubbed,
  selfCheck: () => selfCheck,
  rss: () => process.memoryUsage.rss(),
  exit: (code) => process.exit(code)
})
