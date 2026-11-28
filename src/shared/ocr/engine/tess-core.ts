// Our own loader for the tesseract.js-core 7.0.0 simd-lstm build (DESIGN.md §3.2.2). Host-agnostic
// (DOM-free, Electron-free, no node: imports): the caller hands in the Emscripten glue's factory,
// the WebAssembly.Module it compiled ONCE from the SHA-checked .wasm, and the gunzipped, SHA-checked
// traineddata. Nothing here builds a URL, reads a file or touches the network.
//
// What PR0/PR0b measured and this file relies on:
// - The glue honours `instantiateWasm` on the main thread and in worker_threads (also in the packaged
//   utility process); on that path it never calls `locateFile`, so the stub below is a tripwire for
//   the fetch/wasmBinary path only.
// - P5 PGM input gives byte-identical hOCR to PNG; Leptonica's other readers never see a byte.
// - `debug_file=/dev/null` after Init alone silences tprintf; it is set before AND after Init (the
//   sequence PR0 measured silent). `print` is dropped; `printErr` only sees runtime text (abort
//   lines, Leptonica allocation errors), which goes to a bounded ring and is used to classify
//   failures, never logged.
// - The glue's exit path sets `process.exitCode` (and throws ExitStatus, a plain object): after any
//   glue call that quits, the exit code is reset so the thread does not exit with it.
// - A WASM OOM is not an abort: `Recognize` returns −1 and hOCR is empty, with Leptonica
//   "…malloc fail…" lines on printErr. That is an OOM-shaped failure (respawn, re-queue, halve n).
//   So is an abort whose message or printErr lines name an allocation failure, and a failed
//   instantiate of the posted Module that is one (V8 "Out of memory: Cannot allocate Wasm memory").
//   An instantiate failure rejects `createTess` (the glue alone would wait forever).
// - simd and relaxed-simd give byte-identical hOCR; only simd-lstm ships.

import type { GrayImage } from './types'

/** Written into every OcrPage, the .pdfx provenance and the replay CACHE_INFO.json (§3.2.1). */
export const ENGINE_ID = 'tess-lstm/core-7.0.0/simd/fork-2a9c1c4'

/**
 * The recognition pipeline's version: bump it whenever preprocessing, the pass plan, the hOCR
 * parse, the filter or the mapping changes what a page yields (it is part of configHash).
 * 2: PR6 (preprocessing, orientation, deskew, retries, the adaptive pass, the refit size factor,
 * the missed-space split).
 */
export const PIPELINE_VERSION = 2

/** OEM_LSTM_ONLY: the simd-lstm build has no legacy engine. */
export const OEM_LSTM_ONLY = 1

/** The Tesseract variables a recognition pass sets (§3.2.3). */
export interface TessParams {
  /** 3 = PSM_AUTO (columns); 11 = sparse text (PR6 retry). The API default 6 merges columns. */
  tessedit_pageseg_mode: number
  /** Raster input carries no DPI and Tesseract assumes 70: always the render/physical estimate. */
  user_defined_dpi: number
  preserve_interword_spaces: 0 | 1
  /** `ocrx_cinfo x_bboxes`, so partial-word Find highlights are exact. */
  hocr_char_boxes: 0 | 1
  /** 0 = Otsu; 2 = Sauvola (PR6 retry). */
  thresholding_method: number
}

/** Pass 1 of §3.4.5: PSM 3, Otsu, at `dpi`. */
export function fullPageParams(dpi: number): TessParams {
  return {
    tessedit_pageseg_mode: 3,
    user_defined_dpi: Math.round(dpi),
    preserve_interword_spaces: 1,
    hocr_char_boxes: 1,
    thresholding_method: 0
  }
}

/**
 * The canonical text configHash is the SHA-256 of (§3.2.1): engine id, core hash, sorted
 * `lang:dataSha256`, pipeline version and the pass parameters (DPI excluded: it varies per page and
 * is recorded in each OcrPage). The caller hashes it (node:crypto or crypto.subtle).
 */
export function configHashInput(opts: {
  engineId: string
  coreSha256: string
  dataSha256: Readonly<Record<string, string>>
  pipelineVersion: number
  params: Readonly<Record<string, number>>
}): string {
  const data = Object.keys(opts.dataSha256)
    .sort()
    .map((l) => `${l}:${opts.dataSha256[l]}`)
    .join(',')
  const params = Object.keys(opts.params)
    .filter((k) => k !== 'user_defined_dpi')
    .sort()
    .map((k) => `${k}=${opts.params[k]}`)
    .join(',')
  return [opts.engineId, opts.coreSha256, data, `pipeline=${opts.pipelineVersion}`, params].join(
    '\n'
  )
}

// ---------------------------------------------------------------------------------------------
// The glue's surface (WebIDL-bound in this build; the names tesseract.js's own worker uses).

export interface EmscriptenOpts {
  instantiateWasm(
    imports: WebAssembly.Imports,
    done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
  ): Record<string, never>
  locateFile(path: string): string
  print(line: string): void
  printErr(line: string): void
  onExit?(code: number): void
  onAbort?(what: unknown): void
}

export interface TessApi {
  SetVariable(name: string, value: string): boolean
  Init(datapath: string, langs: string, oem: number): number
  SetImageFile(exifOrientation: number, angle: number): void
  Recognize(monitor: null): number
  GetHOCRText(page: number): string
  End(): void
}

export interface TessModule {
  FS: {
    mkdir(path: string): void
    writeFile(path: string, data: Uint8Array): void
    unlink(path: string): void
  }
  TessBaseAPI: new () => TessApi
}

export type TessFactory = (opts: EmscriptenOpts) => Promise<TessModule>

export interface TessCoreDeps {
  /** The CJS Emscripten glue's default export (require()d by the host from the checked file). */
  factory: TessFactory
  /** Compiled once by the coordinator from the SHA-checked .wasm and posted to each thread. */
  wasmModule: WebAssembly.Module
  /** Gunzipped traineddata per language, SHA-256 checked by the caller. */
  traineddata: Readonly<Record<string, Uint8Array>>
  /** Optional observer of every printErr line (after the ring has it). Never console. */
  stderr?: (line: string) => void
  /** Reset the host's exit code after a glue quit (default: `process.exitCode = 0` if present). */
  resetExitCode?: () => void
}

/** Why the engine failed; the host maps these to the coordinator's failure policy (§3.3.4). */
export type TessErrorKind = 'init' | 'oom' | 'abort' | 'exit' | 'params' | 'empty'

export class TessError extends Error {
  readonly kind: TessErrorKind
  constructor(kind: TessErrorKind, message: string) {
    super(message)
    this.name = kind === 'oom' ? 'OcrOutOfMemory' : 'TessError'
    this.kind = kind
  }
}

/**
 * Text (a printErr line or an error message) that means an allocation failed: Leptonica's
 * "…malloc fail…" lines, V8's "Out of memory: Cannot allocate Wasm memory…" and "Array buffer
 * allocation failed". "Cannot enlarge memory" never occurs in this core's glue (no ASSERTIONS; PR5
 * review: 0 occurrences); it stays as defence for another core build.
 */
export const ALLOC_FAILURE_RE =
  /malloc fail|alloc(?:ation)? fail|failed to allocate|(?:could not|cannot) allocate|Cannot enlarge memory|out of memory/i

/** Is this error (from the glue or WebAssembly) an allocation failure? */
function isAllocFailure(e: unknown): boolean {
  if (e instanceof RangeError) return !/Maximum call stack size exceeded/i.test(e.message)
  const message = e instanceof Error ? e.message : ''
  return ALLOC_FAILURE_RE.test(message)
}

/** A bounded ring of the last `max` lines (each cut to 200 chars). */
export class LineRing {
  private readonly lines: string[] = []
  private seq = 0
  constructor(private readonly max = 64) {}
  push(line: string): void {
    this.lines.push(line.length > 200 ? line.slice(0, 200) : line)
    if (this.lines.length > this.max) this.lines.shift()
    this.seq++
  }
  /** A marker; `since(marker)` returns the lines pushed after it that are still in the ring. */
  mark(): number {
    return this.seq
  }
  since(marker: number): string[] {
    const n = Math.min(this.seq - marker, this.lines.length)
    return n > 0 ? this.lines.slice(-n) : []
  }
  get count(): number {
    return this.seq
  }
}

/** P5 PGM: "P5\n<w> <h>\n255\n" + raw 8-bit rows, no padding (PR0: what Leptonica reads cleanly). */
export function encodePgm(img: GrayImage): Uint8Array {
  const { width: w, height: h } = img
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0)
    throw new RangeError('bad image size')
  const stride = img.stride ?? w
  if (stride < w || img.data.length < stride * (h - 1) + w)
    throw new RangeError('image data too short')
  const header = `P5\n${w} ${h}\n255\n`
  const out = new Uint8Array(header.length + w * h)
  for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i)
  if (stride === w) out.set(img.data.subarray(0, w * h), header.length)
  else
    for (let y = 0; y < h; y++)
      out.set(img.data.subarray(y * stride, y * stride + w), header.length + y * w)
  return out
}

export interface TessRecognition {
  hocr: string
  /** printErr lines seen during this call (bounded; for diagnostics counts only). */
  stderrLines: number
}

export interface Tess {
  readonly langs: readonly string[]
  /** Run one recognition pass over `img` and return its hOCR. Throws TessError. */
  recognize(img: GrayImage, params: TessParams): TessRecognition
  /** Bytes of WASM linear memory (it only ever grows). */
  heapBytes(): number
  /** After an abort or a quit the module is never trusted again (§3.3.4). */
  readonly broken: boolean
  /** printErr lines so far (the ring keeps the last 64). */
  readonly stderrCount: number
  end(): void
}

function defaultResetExitCode(): void {
  const proc = (globalThis as { process?: { exitCode?: number | string | null } }).process
  if (proc && proc.exitCode !== undefined && proc.exitCode !== 0) proc.exitCode = 0
}

function isExitStatus(e: unknown): e is { name: string; status: number } {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: unknown }).name === 'ExitStatus' &&
    typeof (e as { status?: unknown }).status === 'number'
  )
}

/** Build one engine instance for `langs` (Tesseract `eng+deu` order = the array order). */
export async function createTess(deps: TessCoreDeps, langs: readonly string[]): Promise<Tess> {
  if (langs.length === 0) throw new TessError('init', 'no language')
  for (const l of langs)
    if (!deps.traineddata[l]) throw new TessError('init', `no traineddata for ${l}`)
  const ring = new LineRing()
  const resetExitCode = deps.resetExitCode ?? defaultResetExitCode
  let memory: WebAssembly.Memory | null = null
  let broken = false
  let ended = false

  // The 7.0.0 glue wraps instantiateWasm in a promise with no reject path, so a failed instantiate
  // (a LinkError, or V8's RangeError "Out of memory: Cannot allocate Wasm memory" under memory
  // pressure) would leave the factory pending forever and the thread hung until the watchdog. The
  // failure is raced against the factory instead: OOM-shaped when it is an allocation failure.
  let instantiateFailed!: (e: TessError) => void
  const instantiateFailure = new Promise<never>((_, reject) => {
    instantiateFailed = reject
  })
  const failInit = (e: unknown, what: string): TessError => {
    broken = true
    resetExitCode()
    const name = e instanceof Error ? e.name : 'error'
    return new TessError(isAllocFailure(e) ? 'oom' : 'init', `${what} failed: ${name}`)
  }

  const emOpts: EmscriptenOpts = {
    instantiateWasm: (imports, done) => {
      WebAssembly.instantiate(deps.wasmModule, imports)
        .then((inst) => {
          memory =
            (Object.values(inst.exports).find((x) => x instanceof WebAssembly.Memory) as
              | WebAssembly.Memory
              | undefined) ?? null
          done(inst, deps.wasmModule)
        })
        // A rejected instantiate, or the glue's own receiveInstance throwing.
        .catch((e: unknown) => {
          ring.push(`instantiate failed: ${e instanceof Error ? e.name : 'error'}`)
          instantiateFailed(failInit(e, 'instantiate'))
        })
      return {}
    },
    // Tripwire: only the wasmBinary/fetch path calls it (PR0), and that path must never run.
    locateFile: () => '/nonexistent/no-wasm-fetch',
    print: () => {},
    printErr: (line) => {
      ring.push(String(line))
      deps.stderr?.(String(line))
    },
    onExit: () => {
      broken = true
    },
    onAbort: () => {
      broken = true
    }
  }
  // Called at once (inside the async wrapper, so a synchronous throw becomes a rejection).
  const factoryDone = (async (): Promise<TessModule> => deps.factory(emOpts))()
  void factoryDone.catch(() => {}) // after a loss to `instantiateFailure`, never unhandled
  let m: TessModule
  try {
    m = await Promise.race([factoryDone, instantiateFailure])
  } catch (e) {
    if (e instanceof TessError) throw e
    if (isExitStatus(e)) {
      broken = true
      resetExitCode()
      throw new TessError('exit', `engine quit (${e.status})`)
    }
    throw failInit(e, 'engine start')
  }

  /**
   * Every call into the glue: a quit resets the exit code, an abort poisons the module. An abort is
   * OOM-shaped when its message OR a printErr line since the call began names an allocation
   * failure: in this build (no ASSERTIONS) a failed `operator new` ends in a bare
   * "Aborted(...)" RuntimeError, and only Leptonica's own "…malloc fail…" line says why.
   */
  const call = <T>(fn: () => T): T => {
    if (broken) throw new TessError('abort', 'engine module is no longer trusted')
    const mark = ring.mark()
    try {
      return fn()
    } catch (e) {
      broken = true
      if (isExitStatus(e)) {
        resetExitCode()
        throw new TessError('exit', `engine quit (${e.status})`)
      }
      resetExitCode()
      if (e instanceof WebAssembly.RuntimeError) {
        const oom =
          ALLOC_FAILURE_RE.test(e.message) || ring.since(mark).some((l) => ALLOC_FAILURE_RE.test(l))
        throw new TessError(oom ? 'oom' : 'abort', e.message.slice(0, 200))
      }
      if (e instanceof RangeError)
        throw new TessError(isAllocFailure(e) ? 'oom' : 'abort', e.message.slice(0, 200))
      throw e
    }
  }

  const api = call(() => {
    m.FS.mkdir('/tessdata')
    for (const l of langs) m.FS.writeFile(`/tessdata/${l}.traineddata`, deps.traineddata[l])
    return new m.TessBaseAPI()
  })
  call(() => api.SetVariable('debug_file', '/dev/null'))
  const rc = call(() => api.Init('/tessdata', langs.join('+'), OEM_LSTM_ONLY))
  if (rc !== 0) {
    broken = true
    throw new TessError('init', `Init returned ${rc}`)
  }
  call(() => api.SetVariable('debug_file', '/dev/null'))

  return {
    langs: [...langs],
    get broken() {
      return broken
    },
    get stderrCount() {
      return ring.count
    },
    heapBytes: () => (memory ? memory.buffer.byteLength : 0),
    recognize(img, params) {
      const pgm = encodePgm(img)
      const mark = ring.mark()
      const hocr = call(() => {
        for (const [k, v] of Object.entries(params))
          if (!api.SetVariable(k, String(v))) throw new TessError('params', `${k} rejected`)
        m.FS.writeFile('/input', pgm)
        api.SetImageFile(1, 0)
        const r = api.Recognize(null)
        const out = r === 0 ? api.GetHOCRText(0) : ''
        try {
          m.FS.unlink('/input')
        } catch {
          // already gone
        }
        if (r !== 0) {
          // PR0b: a WASM OOM is rc −1 with empty text; any non-zero rc is treated the same way.
          broken = true
          throw new TessError('oom', `Recognize returned ${r}`)
        }
        return out
      })
      const lines = ring.since(mark)
      if (hocr.length === 0) {
        broken = true
        throw new TessError(
          lines.some((l) => ALLOC_FAILURE_RE.test(l)) ? 'oom' : 'empty',
          'empty hOCR'
        )
      }
      return { hocr, stderrLines: lines.length }
    },
    end() {
      if (ended) return
      ended = true
      if (broken) return
      try {
        api.End()
      } catch (e) {
        if (isExitStatus(e)) resetExitCode()
      }
    }
  }
}
