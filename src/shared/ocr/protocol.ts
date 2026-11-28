// The OCR port protocol (DESIGN.md §3.3.1): every message that crosses a process boundary on the
// way to or from the "pdfx-ocr" utility process, plus the strict runtime validators each receiving
// side runs before it acts on one.
//
// Three links, three directions each way:
// - renderer ⇄ coordinator, over a MessagePort handed out by main (`ToOcr` / `FromOcr`);
// - main ⇄ coordinator, over the utility process's parentPort (`MainToOcr` / `OcrToMain`).
// Messages are single-key objects (`{ open: {...} }`), so a validator dispatches on the key and a
// typo can never alias another message.
//
// Rules this file enforces (each is a test in protocol.node.test.ts):
// - The unit of identity is the SOURCE TOKEN (`src`), never a document: a DocEntry can hold pages
//   from many sources and one source can feed many DocEntrys, so `close` is per source.
// - Unknown keys, wrong types, non-plain objects and out-of-range numbers are rejected at every
//   level. Error messages name the failing path only and never echo a value (values can be page
//   content or user data).
// - The renderer protocol never accepts a file path. Its only free-form strings are tokens and
//   language codes, both restricted to characters that cannot spell a path (no `/`, `\`, `.`, `:`).
//   File locations come from main in `init`, which is the trusted side.
// - Nothing here needs a transfer list. `MessagePortMain.postMessage(msg, [buf])` throws in the
//   utility process, and a renderer-side transfer delivers `null` (PR0). Bytes go by structured
//   copy, so typed arrays are plain values to these validators.
//
// DOM-free and Electron-free (src/shared), so the preload, main, the utility process and vitest
// Node all import the same file.

import type { JpxRefusal, NativeWord, TriageFailure, TriagePage } from './triage'
import type { OcrStatus, PackedOcrPage, PageClass } from './types'

export const OCR_PROTOCOL_VERSION = 1

// ---------------------------------------------------------------------------------------------
// Shared vocabulary. The page class and status types belong to the result model (types.ts, §3.5.1);
// this file re-exports them and adds the runtime list its validator needs.

export type { NativeWord, OcrStatus, PageClass, TriagePage }

/** Every PageClass, for the validator (complete: checked against the type below). */
export const PAGE_CLASSES = [
  'scanned',
  'near-scanned',
  'ocr-ours',
  'ocr-foreign',
  'broken-text',
  'mixed',
  'text',
  'blank',
  'protected'
] as const satisfies readonly PageClass[]
const _allClasses: Exclude<PageClass, (typeof PAGE_CLASSES)[number]> extends never ? true : never =
  true
void _allClasses

/** Every JPX pre-check refusal (§3.4.1). */
export const JPX_REFUSALS = [
  'jpx-malformed',
  'jpx-subsampled',
  'jpx-components',
  'jpx-no-colour-space',
  'too-complex'
] as const satisfies readonly JpxRefusal[]
const _allRefusals: Exclude<JpxRefusal, (typeof JPX_REFUSALS)[number]> extends never
  ? true
  : never = true
void _allRefusals

/** Every `TriagePage.failure`. */
export const TRIAGE_FAILURES = [
  'page-missing',
  'render',
  'too-large',
  'raster-crash'
] as const satisfies readonly TriageFailure[]
const _allFailures: Exclude<TriageFailure, (typeof TRIAGE_FAILURES)[number]> extends never
  ? true
  : never = true
void _allFailures

/** Every `OcrStatus`, for the validator. Checked against the type both ways (below). */
export const OCR_STATUSES = [
  'ok',
  'low-confidence',
  'no-text',
  'timeout',
  'failed',
  'too-large',
  'skipped-has-text',
  'skipped-protected',
  'needs-language'
] as const satisfies readonly OcrStatus[]
// A status added to types.ts but not here fails to compile (the list must be complete).
const _allStatuses: Exclude<OcrStatus, (typeof OCR_STATUSES)[number]> extends never ? true : never =
  true
void _allStatuses

/** Why a page ended `failed`, `too-large` or `timeout` (machine-readable; the UI picks the copy). */
export const PAGE_REASONS = [
  'frame-mismatch', // PDFium's page frame differs from the pdf.js PageEntry frame (§3.4.2)
  'user-unit', // /UserUnit ≠ 1 (unsupported in 1.1.4)
  'page-missing', // index beyond the page count
  'render', // PDFium could not load or render the page
  'heap', // the raster heap had no room for the page, even in a fresh thread (§3.3.3)
  'raster-crash', // the raster thread trapped or timed out twice on this page (§3.3.4)
  'recognize-crash', // a recognize thread trapped twice on this page
  'watchdog', // the per-page recognize watchdog fired
  'source-too-large', // the source is over the 1.5 GB ceiling
  'image-format', // triage's JPX pre-check refused an image on the page (§3.4.1)
  'page-too-large' // triage found the pixel caps leave the page under 1 DPI (§3.3.3, §3.4.3)
] as const
export type PageReason = (typeof PAGE_REASONS)[number]

export const OCR_ERROR_CODES = [
  'network', // the no-network tripwire fired (never expected; a privacy bug if seen)
  'bad-message', // a message failed validation
  'not-open', // a request named a source that is not (or no longer) open
  'duplicate', // a source token or job id was reused while still live
  'open-failed', // PDFium could not open the source
  'too-large', // the source is over the ceiling
  'unsupported', // the request is valid but not implemented yet
  'init', // the process or an engine failed to start
  'internal' // a bug; the message carries no content
] as const
export type OcrErrorCode = (typeof OCR_ERROR_CODES)[number]

/** The error every OCR module throws. `code` is the contract; `message` is for logs. */
export class OcrError extends Error {
  readonly code: OcrErrorCode
  constructor(code: OcrErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'OcrError'
    this.code = code
  }
}

/** Ceilings shared by every side (§3.3.3). */
export const OCR_LIMITS = {
  /** A source above this is refused with `too-large`; never a crash loop. */
  maxSourceBytes: 1.5 * 2 ** 30,
  /** Pages per recognize request. */
  maxPagesPerJob: 100_000,
  /** Page indices. */
  maxPageIndex: 1_000_000,
  /** Languages per job (§3.2.5: "at most 3 are selected"). */
  maxLangs: 3,
  /** Page frame sides in pt (PDF caps user space at 14,400 units; leave room for rotation). */
  maxPageSidePt: 100_000,
  /** Render DPI overrides the renderer may send (triage chooses each page's DPI otherwise). */
  minRenderDpi: 36,
  maxRenderDpi: 1200
} as const

/** Opaque ids minted by the renderer (`ocr-store`'s per-Uint8Array counter, job counters). */
export const TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/
/** Tesseract language codes: `eng`, `chi_sim`, `deu_latf`. */
export const LANG_RE = /^[a-z]{3}(?:_[a-z]{3,4})?$/

// ---------------------------------------------------------------------------------------------
// Renderer → coordinator.

export interface PageRequest {
  /** 0-based page index in the source. */
  index: number
  /** pdf.js `PDFPageProxy.userUnit` (FPDF_GetPageUserUnit is not exported; §3.4.2). */
  userUnit: number
  /** The pdf.js PageEntry frame in pt (`getViewport({ scale: 1 })`); the raster must match it. */
  width: number
  height: number
  /**
   * The edit rotation the page shows (clockwise degrees, §3.4.5): the result's `rotateBy` is the
   * detected orientation less this. Absent = 0.
   */
  editRotation?: 0 | 90 | 180 | 270
}

export interface RecognizeOpts {
  langs: string[]
  /**
   * Render DPI override. Without it each page renders at the DPI triage chose from its dominant
   * image (§3.4.3), or 300 for a page triage has not answered.
   */
  renderDpi?: number
}

export interface RecognizeRequest {
  jobId: string
  src: string
  pages: PageRequest[]
  opts: RecognizeOpts
}

export type ToOcr =
  | { open: { src: string; bytes: Uint8Array } }
  | { triage: { src: string; pages?: number[] } }
  | { recognize: RecognizeRequest }
  | { cancel: string }
  | { close: string }
  /** The page in view: work order is this page, then the rest of its source, then the rest. */
  | { focus: { src: string; index: number } }

// ---------------------------------------------------------------------------------------------
// Coordinator → renderer.

export interface PageResult {
  status: OcrStatus
  reason?: PageReason
  /** The DPI the page was rasterised at (after the pixel caps), or null if it never rendered. */
  renderDpi: number | null
  /** Raster size in px, or null if it never rendered. */
  raster: { width: number; height: number } | null
  /** The recognised page, packed (§3.5.1), or null when the page never recognised. */
  recognition: PackedOcrPage | null
  /**
   * The extra clockwise turn the page needs on screen, `Δ = (orientation − editRotation) mod 360`
   * (§3.4.5), when it is not 0: the "looks sideways — Rotate?" offer. Recognition already used
   * the detected orientation either way.
   */
  rotateBy?: 90 | 180 | 270
}

export interface ProgressInfo {
  jobId: string
  doneOrFailed: number
  total: number
  /** Estimated progress of the pages in flight, 0..1 of one page each, summed. */
  inflightFrac: number
  /**
   * The page indices rendering or recognising right now (at most `MAX_INFLIGHT_REPORT`). The
   * renderer keeps the last set it saw: when the process dies, those are the pages implicated in
   * the crash (§3.3.2: a page implicated in two crashes is `failed`). Absent = none.
   */
  inflight?: number[]
}

/** At most this many in-flight page indices ride on one progress message. */
export const MAX_INFLIGHT_REPORT = 64

export type FromOcr =
  | { opened: { src: string; pageCount: number } }
  /** The byte-budgeted LRU dropped this source; `open` it again before the next request. */
  | { evicted: { src: string } }
  | { result: { jobId: string; src: string; index: number; page: PageResult } }
  /**
   * Triage results for some of the requested pages, in request order (§3.4.1). A request is answered
   * in one or more of these; the last has `done: true`.
   */
  | { triaged: { src: string; pages: TriagePage[]; done: boolean } }
  | { progress: ProgressInfo }
  | { jobDone: { jobId: string; done: number; failed: number; cancelled: boolean } }
  | { error: { code: OcrErrorCode; message: string; src?: string; jobId?: string } }

// ---------------------------------------------------------------------------------------------
// The IPC around the port (main ⇄ preload). The port itself never crosses contextBridge: the
// preload keeps it and bridges only `ocr.connect()`, `ocr.post()` and `ocr.onMessage()`.

/** Renderer → main: "I need OCR now" (spawns the utility process lazily; a fresh port each time). */
export const OCR_CONNECT_CHANNEL = 'pdfx:ocr-connect'
/** Main → preload: the renderer's end of a fresh MessageChannelMain, in `event.ports[0]`. */
export const OCR_PORT_CHANNEL = 'ocr:port'
/** Main → preload: the utility process went away; the port is dead. */
export const OCR_DISCONNECTED_CHANNEL = 'ocr:disconnected'

export const OCR_DISCONNECT_REASONS = [
  'idle', // killed after 3 idle minutes; connect() again when needed
  'crashed', // exited unexpectedly; main respawns it and sends a new port (Resume, §3.3.2)
  'crash-loop', // more than 3 crashes in 60 s; no automatic respawn
  'fatal', // launch failed or an engine could not start; OCR is off for this session
  'closed' // the port closed for another reason (preload-side)
] as const
export type OcrDisconnectReason = (typeof OCR_DISCONNECT_REASONS)[number]

/** What the preload adds to the message stream about the link itself (never from the port). */
export type OcrLinkEvent =
  | { link: { state: 'connected' } }
  | { link: { state: 'disconnected'; reason: OcrDisconnectReason } }

// ---------------------------------------------------------------------------------------------
// Main ⇄ coordinator (parentPort).

export type ThermalState = 'unknown' | 'nominal' | 'fair' | 'serious' | 'critical'

export interface OcrHostLimits {
  onBattery: boolean
  thermal: ThermalState
  /** CPU speed limit in percent (100 = unthrottled). */
  speedLimit: number
  /** Session-wide concurrency divisor: doubles on every `oom` / `memory-eviction` exit (§3.3.2). */
  divisor: number
}

export interface OcrPaths {
  pdfiumWasm: string
  /** The directory holding tesseract-core-simd-lstm.{js,wasm} (resources/ocr when packaged). */
  ocrCore: string
  /** Each bundled language's `<lang>.traineddata.gz` (resources/ocr/tessdata when packaged). */
  tessdata: Record<string, string>
}

export interface OcrInit {
  limits: OcrHostLimits
  /** Absolute paths main resolved (the trusted side; the renderer protocol never carries one). */
  paths: OcrPaths
}

export type MainToOcr =
  | { init: OcrInit }
  /** The new renderer port is `ports[0]` of the same event. Replaces any previous port. */
  | { port: Record<string, never> }
  | { limits: OcrHostLimits }
  /** Ask for an immediate heartbeat. */
  | { heartbeat: Record<string, never> }
  | { shutdown: Record<string, never> }

/** No-network tripwire hits, per process and summed over every thread it ever ran (§3.3.1). */
export interface TripwireCounts {
  process: number
  raster: number
  recognize: number
}

/**
 * The coordinator posts a heartbeat this often, busy or idle, from the moment it starts. Main's
 * liveness check counts on it: a child that says nothing for several of these is hung (§3.3.2).
 */
export const OCR_HEARTBEAT_INTERVAL_MS = 5_000

export interface Heartbeat {
  tripwire: TripwireCounts
  /**
   * Every API the coordinator's tripwire replaced still holds the stub, and every thread's
   * in-realm self-check passed.
   */
  tripwireIntact: boolean
  rss: number
  /** Live threads. */
  threads: { raster: number; recognize: number }
  /** Pages queued or in flight. */
  pending: number
  /** Effective recognize concurrency. */
  concurrency: number
}

/** The `require('electron').net` members the coordinator's tripwire replaced (§3.0 #3). */
export const ELECTRON_NET_MEMBERS = ['fetch', 'request', 'resolveHost', 'isOnline'] as const

/**
 * The coordinator realm's tripwire self-check (no-network.ts `tripwireSelfCheck`): the escape
 * hatches it called, and the ones that did not trip. API names only.
 */
export interface TripwireSelfCheck {
  checked: string[]
  failed: string[]
}

export interface OcrActivity {
  busy: boolean
  done: number
  total: number
  triage?: boolean
}

export type OcrToMain =
  | {
      ready: {
        tripwire: number
        electronNet: Array<(typeof ELECTRON_NET_MEMBERS)[number]>
        selfCheck: TripwireSelfCheck
      }
    }
  /**
   * Batch state for the power blocker and the taskbar progress (≤ 10 Hz). `triage` says triage
   * requests are open: background work that holds off the idle kill but takes no power blocker and
   * shows no progress (absent = false).
   */
  | { activity: OcrActivity }
  | { heartbeat: Heartbeat }
  | { fatal: { code: OcrErrorCode; message: string } }

// ---------------------------------------------------------------------------------------------
// Validators.

type Check<T> = (x: unknown, path: string) => T

function fail(path: string, what: string): never {
  throw new OcrError('bad-message', `${path}: ${what}`)
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false
  const proto = Object.getPrototypeOf(x)
  return proto === Object.prototype || proto === null
}

// `{} extends Pick<T, K>` is the standard "is this key optional" probe.
type OptionalKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? K : never }[keyof T]
type RequiredKeys<T> = Exclude<keyof T, OptionalKeys<T>>

/** `{ k: v }` with exactly these keys (optional ones may be absent, never `undefined`-valued). */
function object<T>(
  required: { [K in RequiredKeys<T>]: Check<T[K]> },
  optional: { [K in OptionalKeys<T>]?: Check<Exclude<T[K], undefined>> } = {} as {
    [K in OptionalKeys<T>]?: Check<Exclude<T[K], undefined>>
  }
): Check<T> {
  return (x, path) => {
    if (!isPlainObject(x)) fail(path, 'expected an object')
    const out: Record<string, unknown> = {}
    const req = required as Record<string, Check<unknown>>
    const opt = optional as Record<string, Check<unknown> | undefined>
    // Own keys only: `in` would also find Object.prototype members (constructor, toString,
    // __proto__, ...) and let a key with such a name through unchecked.
    for (const k of Object.keys(x)) {
      if (
        !Object.prototype.hasOwnProperty.call(req, k) &&
        !Object.prototype.hasOwnProperty.call(opt, k)
      )
        fail(path, `unknown key ${JSON.stringify(k.slice(0, 32))}`)
    }
    for (const [k, check] of Object.entries(req)) {
      if (!Object.prototype.hasOwnProperty.call(x, k)) fail(path, `missing ${k}`)
      out[k] = check(x[k], `${path}.${k}`)
    }
    for (const [k, check] of Object.entries(opt)) {
      if (!check || !Object.prototype.hasOwnProperty.call(x, k)) continue
      out[k] = check(x[k], `${path}.${k}`)
    }
    return out as T
  }
}

const empty: Check<Record<string, never>> = (x, path) => {
  if (!isPlainObject(x) || Object.keys(x).length > 0) fail(path, 'expected {}')
  return {}
}

const bool: Check<boolean> = (x, path) => {
  if (typeof x !== 'boolean') fail(path, 'expected a boolean')
  return x
}

function int(min: number, max: number): Check<number> {
  return (x, path) => {
    if (typeof x !== 'number' || !Number.isInteger(x) || x < min || x > max)
      fail(path, `expected an integer in [${min}, ${max}]`)
    return x
  }
}

function num(min: number, max: number, { minExclusive = false } = {}): Check<number> {
  return (x, path) => {
    if (
      typeof x !== 'number' ||
      !Number.isFinite(x) ||
      x > max ||
      x < min ||
      (minExclusive && x === min)
    )
      fail(path, `expected a number in ${minExclusive ? '(' : '['}${min}, ${max}]`)
    return x
  }
}

function pattern(re: RegExp, what: string): Check<string> {
  return (x, path) => {
    if (typeof x !== 'string' || !re.test(x)) fail(path, `expected ${what}`)
    return x
  }
}

function oneOf<T extends string>(values: readonly T[]): Check<T> {
  const set = new Set<string>(values)
  return (x, path) => {
    if (typeof x !== 'string' || !set.has(x)) fail(path, 'unexpected value')
    return x as T
  }
}

function array<T>(item: Check<T>, maxLength: number, { minLength = 0 } = {}): Check<T[]> {
  return (x, path) => {
    if (!Array.isArray(x)) fail(path, 'expected an array')
    if (x.length < minLength || x.length > maxLength)
      fail(path, `expected ${minLength}..${maxLength} items`)
    return x.map((v, i) => item(v, `${path}[${i}]`))
  }
}

/** A short human-readable text (error messages only); never parsed for meaning. */
function text(maxLength: number): Check<string> {
  return (x, path) => {
    if (typeof x !== 'string' || x.length > maxLength) fail(path, 'expected a short string')
    return x
  }
}

/** Cross-realm safe `instanceof Uint8Array`. */
function isUint8Array(x: unknown): x is Uint8Array {
  return Object.prototype.toString.call(x) === '[object Uint8Array]'
}

const sourceBytes: Check<Uint8Array> = (x, path) => {
  if (!isUint8Array(x)) fail(path, 'expected a Uint8Array')
  if (x.byteLength === 0) fail(path, 'empty source')
  // Over the ceiling is not malformed; the coordinator answers `too-large` for it (§3.3.3).
  return x
}

/** The single key of a `{ key: payload }` message, dispatched to its payload check. */
function message<T>(variants: Record<string, Check<unknown>>, path: string): Check<T> {
  return (x) => {
    if (!isPlainObject(x)) fail(path, 'expected a message object')
    const keys = Object.keys(x)
    if (keys.length !== 1) fail(path, 'expected exactly one key')
    const key = keys[0]
    const check = Object.prototype.hasOwnProperty.call(variants, key) ? variants[key] : undefined
    if (!check) fail(path, `unknown message ${JSON.stringify(key.slice(0, 32))}`)
    return { [key]: check(x[key], `${path}.${key}`) } as T
  }
}

const token = pattern(TOKEN_RE, 'a token')
const lang = pattern(LANG_RE, 'a language code')
const pageIndex = int(0, OCR_LIMITS.maxPageIndex)
const side = num(0, OCR_LIMITS.maxPageSidePt, { minExclusive: true })
const count = int(0, Number.MAX_SAFE_INTEGER)

const quarter =
  <T extends number>(allowed: readonly T[]): Check<T> =>
  (v, p) => {
    if (!allowed.includes(v as T)) fail(p, `expected one of ${allowed.join('/')}`)
    return v as T
  }

const pageRequest = object<PageRequest>(
  {
    index: pageIndex,
    userUnit: num(0, 1000, { minExclusive: true }),
    width: side,
    height: side
  },
  { editRotation: quarter([0, 90, 180, 270] as const) }
)

const recognizeOpts = object<RecognizeOpts>(
  {
    langs: (x, path) => {
      const langs = array(lang, OCR_LIMITS.maxLangs, { minLength: 1 })(x, path)
      if (new Set(langs).size !== langs.length) fail(path, 'duplicate language')
      return langs
    }
  },
  { renderDpi: int(OCR_LIMITS.minRenderDpi, OCR_LIMITS.maxRenderDpi) }
)

const recognizeRequest = object<RecognizeRequest>({
  jobId: token,
  src: token,
  pages: (x, path) => {
    const pages = array(pageRequest, OCR_LIMITS.maxPagesPerJob, { minLength: 1 })(x, path)
    const seen = new Set<number>()
    for (const p of pages) {
      if (seen.has(p.index)) fail(path, 'duplicate page index')
      seen.add(p.index)
    }
    return pages
  },
  opts: recognizeOpts
})

const toOcr = message<ToOcr>(
  {
    open: object<{ src: string; bytes: Uint8Array }>({ src: token, bytes: sourceBytes }),
    triage: object<{ src: string; pages?: number[] }>(
      { src: token },
      { pages: array(pageIndex, OCR_LIMITS.maxPagesPerJob) }
    ),
    recognize: recognizeRequest,
    cancel: token,
    close: token,
    focus: object<{ src: string; index: number }>({ src: token, index: pageIndex })
  },
  'ToOcr'
)

/** Validate a renderer → coordinator message. Throws `OcrError('bad-message')`. */
export function parseToOcr(x: unknown): ToOcr {
  return toOcr(x, 'ToOcr')
}

// ---- PackedOcrPage (§3.5.1): the renderer stores it and the layer writer bakes it into PDFs, so
// every array length, offset and number is checked here, not trusted.

/** Words and characters per page beyond any real page (a dense A4 at 6 pt is ~1,200 words). */
const MAX_WORDS = 200_000
const MAX_TEXT = 4_000_000

function typedArray<T>(tag: string): Check<T> {
  return (x, path) => {
    if (Object.prototype.toString.call(x) !== `[object ${tag}]`) fail(path, `expected a ${tag}`)
    return x as T
  }
}
const u32 = typedArray<Uint32Array>('Uint32Array')
const f32 = typedArray<Float32Array>('Float32Array')

/** Offsets: `n + 1` entries, non-decreasing, from 0 to `end`. */
function offsets(a: Uint32Array, n: number, end: number, path: string): void {
  if (a.length !== n + 1) fail(path, 'wrong length')
  if (a[0] !== 0 || a[n] !== end) fail(path, 'bad bounds')
  for (let i = 1; i <= n; i++) if (a[i] < a[i - 1]) fail(path, 'not monotone')
}

const sha256Hex = pattern(/^[0-9a-f]{64}$/, 'a SHA-256')

const packedOcrPage: Check<PackedOcrPage> = (x, path) => {
  const meta = object<
    Omit<
      PackedOcrPage,
      | 'text'
      | 'wordOff'
      | 'wordGeom'
      | 'wordLine'
      | 'lineGeom'
      | 'lineLang'
      | 'charEdges'
      | 'charOff'
    > & {
      text: string
      wordOff: Uint32Array
      wordGeom: Float32Array
      wordLine: Uint32Array
      lineGeom: Float32Array
      lineLang?: (string | null)[]
      charEdges?: Float32Array
      charOff?: Uint32Array
    }
  >(
    {
      v: (v, p) => (v === 1 ? 1 : fail(p, 'expected 1')),
      engineId: pattern(/^[A-Za-z0-9._/-]{1,128}$/, 'an engine id'),
      dataHashes: (v, p) => {
        if (!isPlainObject(v)) fail(p, 'expected an object')
        const keys = Object.keys(v)
        if (keys.length > 16) fail(p, 'too many languages')
        const out: Record<string, string> = {}
        for (const k of keys) {
          lang(k, `${p}.key`)
          out[k] = sha256Hex(v[k], `${p}.${k}`)
        }
        return out
      },
      langs: array(lang, 16),
      pipelineVersion: int(0, 1_000_000),
      pageClass: oneOf(PAGE_CLASSES),
      renderDpi: num(0, 10_000, { minExclusive: true }),
      physDpi: num(0, 10_000, { minExclusive: true }),
      orientation: (v, p) => {
        if (v !== 0 && v !== 90 && v !== 180 && v !== 270) fail(p, 'expected 0/90/180/270')
        return v
      },
      skewDeg: num(-45, 45),
      meanConfCal: (v, p) => (v === null ? null : num(0, 1)(v, p)),
      confSource: oneOf(['word', 'line', 'none'] as const),
      status: oneOf(OCR_STATUSES),
      text: text(MAX_TEXT),
      wordOff: u32,
      wordGeom: f32,
      wordLine: u32,
      lineGeom: f32
    },
    {
      lineLang: array((v, p) => (v === null ? null : lang(v, p)), MAX_WORDS),
      charEdges: f32,
      charOff: u32
    }
  )(x, path)
  const nWords = meta.wordOff.length - 1
  if (nWords < 0 || nWords > MAX_WORDS) fail(`${path}.wordOff`, 'wrong length')
  offsets(meta.wordOff, nWords, meta.text.length, `${path}.wordOff`)
  const nLines = meta.wordLine.length - 1
  if (nLines < 0 || nLines > MAX_WORDS) fail(`${path}.wordLine`, 'wrong length')
  offsets(meta.wordLine, nLines, nWords, `${path}.wordLine`)
  if (meta.wordGeom.length !== nWords * 5) fail(`${path}.wordGeom`, 'wrong length')
  for (let i = 0; i < nWords; i++) {
    const g = i * 5
    for (let k = 0; k < 3; k++)
      if (!Number.isFinite(meta.wordGeom[g + k])) fail(`${path}.wordGeom`, 'non-finite geometry')
    const conf = meta.wordGeom[g + 3]
    const cal = meta.wordGeom[g + 4]
    if (!Number.isNaN(conf) && !(conf >= 0 && conf <= 100)) fail(`${path}.wordGeom`, 'bad conf')
    if (!Number.isNaN(cal) && !(cal >= 0 && cal <= 1)) fail(`${path}.wordGeom`, 'bad confCal')
  }
  if (meta.lineGeom.length !== nLines * 2) fail(`${path}.lineGeom`, 'wrong length')
  for (let i = 0; i < meta.lineGeom.length; i++)
    if (!Number.isFinite(meta.lineGeom[i])) fail(`${path}.lineGeom`, 'non-finite geometry')
  if (meta.lineLang && meta.lineLang.length !== nLines) fail(`${path}.lineLang`, 'wrong length')
  if ((meta.charEdges === undefined) !== (meta.charOff === undefined))
    fail(path, 'charEdges and charOff go together')
  if (meta.charEdges && meta.charOff) {
    offsets(meta.charOff, nWords, meta.charEdges.length, `${path}.charOff`)
    for (let i = 0; i < meta.charEdges.length; i++)
      if (!Number.isFinite(meta.charEdges[i])) fail(`${path}.charEdges`, 'non-finite geometry')
  }
  return meta as PackedOcrPage
}

const pageResult = object<PageResult>(
  {
    status: oneOf(OCR_STATUSES),
    renderDpi: (x, path) => (x === null ? null : num(0, 10_000, { minExclusive: true })(x, path)),
    raster: (x, path) =>
      x === null
        ? null
        : object<{ width: number; height: number }>({
            width: int(1, 1_000_000),
            height: int(1, 1_000_000)
          })(x, path),
    recognition: (x, path) => (x === null ? null : packedOcrPage(x, path))
  },
  { reason: oneOf(PAGE_REASONS), rotateBy: quarter([90, 180, 270] as const) }
)

/** At most this many native words per page, and characters per word, cross the port. */
export const TRIAGE_WORD_LIMITS = { words: 20_000, length: 256 } as const

const coord = num(-OCR_LIMITS.maxPageSidePt, OCR_LIMITS.maxPageSidePt)

const nativeWord = object<NativeWord>({
  t: (x, path) => {
    if (typeof x !== 'string' || x.length === 0 || x.length > TRIAGE_WORD_LIMITS.length)
      fail(path, 'expected a word')
    return x
  },
  x0: coord,
  y0: coord,
  x1: coord,
  y1: coord
})

const nullable =
  <T>(check: Check<T>): Check<T | null> =>
  (x, path) =>
    x === null ? null : check(x, path)

const triagePage = object<TriagePage>(
  {
    index: pageIndex,
    pageClass: nullable(oneOf(PAGE_CLASSES)),
    renderDpi: nullable(num(0, 10_000, { minExclusive: true })),
    raster: nullable(
      object<{ width: number; height: number }>({
        width: int(1, 1_000_000),
        height: int(1, 1_000_000)
      })
    ),
    effectiveDpi: nullable(num(0, 1e6, { minExclusive: true })),
    bitsPerPixel: nullable(int(1, 1024)),
    imageOrigin: bool
  },
  {
    failure: oneOf(TRIAGE_FAILURES),
    refused: oneOf(JPX_REFUSALS),
    nativeWords: array(nativeWord, TRIAGE_WORD_LIMITS.words)
  }
)

const fromOcr = message<FromOcr>(
  {
    opened: object<{ src: string; pageCount: number }>({
      src: token,
      pageCount: int(0, OCR_LIMITS.maxPageIndex + 1)
    }),
    evicted: object<{ src: string }>({ src: token }),
    result: object<{ jobId: string; src: string; index: number; page: PageResult }>({
      jobId: token,
      src: token,
      index: pageIndex,
      page: pageResult
    }),
    triaged: object<{ src: string; pages: TriagePage[]; done: boolean }>({
      src: token,
      pages: array(triagePage, OCR_LIMITS.maxPagesPerJob),
      done: bool
    }),
    progress: object<ProgressInfo>(
      {
        jobId: token,
        doneOrFailed: count,
        total: count,
        inflightFrac: num(0, OCR_LIMITS.maxPagesPerJob)
      },
      { inflight: array(pageIndex, MAX_INFLIGHT_REPORT) }
    ),
    jobDone: object<{ jobId: string; done: number; failed: number; cancelled: boolean }>({
      jobId: token,
      done: count,
      failed: count,
      cancelled: bool
    }),
    error: object<{ code: OcrErrorCode; message: string; src?: string; jobId?: string }>(
      { code: oneOf(OCR_ERROR_CODES), message: text(500) },
      { src: token, jobId: token }
    )
  },
  'FromOcr'
)

/**
 * Validate one triage result (the coordinator runs this on every page a raster thread returns, so
 * one bad page becomes a failure entry instead of making the renderer reject the whole batch).
 */
export function parseTriagePage(x: unknown, path = 'TriagePage'): TriagePage {
  return triagePage(x, path)
}

/** Validate a coordinator → renderer message (the renderer's ocr-store runs this). */
export function parseFromOcr(x: unknown): FromOcr {
  return fromOcr(x, 'FromOcr')
}

const hostLimits = object<OcrHostLimits>({
  onBattery: bool,
  thermal: oneOf(['unknown', 'nominal', 'fair', 'serious', 'critical'] as const),
  speedLimit: num(0, 100),
  divisor: int(1, 1024)
})

/** An absolute path (POSIX or Windows drive/UNC), no NUL. Only main→coordinator `init` has one. */
const absolutePath: Check<string> = (x, path) => {
  if (
    typeof x !== 'string' ||
    x.length > 4096 ||
    x.includes('\0') ||
    !(x.startsWith('/') || /^[A-Za-z]:[\\/]/.test(x) || x.startsWith('\\\\'))
  )
    fail(path, 'expected an absolute path')
  return x
}

const mainToOcr = message<MainToOcr>(
  {
    init: object<OcrInit>({
      limits: hostLimits,
      paths: object<OcrPaths>({
        pdfiumWasm: (x, path) => {
          const p = absolutePath(x, path)
          if (!/[\\/]pdfium\.wasm$/.test(p)) fail(path, 'expected pdfium.wasm')
          return p
        },
        ocrCore: absolutePath,
        tessdata: (x, path) => {
          if (!isPlainObject(x)) fail(path, 'expected an object')
          const keys = Object.keys(x)
          if (keys.length > 64) fail(path, 'too many languages')
          const out: Record<string, string> = {}
          for (const k of keys) {
            lang(k, `${path}.key`)
            const p = absolutePath(x[k], `${path}.${k}`)
            // Only the file the manifest names for that language.
            if (!p.endsWith(`${k}.traineddata.gz`) || !/[\\/]$/.test(p.slice(0, -k.length - 15)))
              fail(`${path}.${k}`, 'expected <lang>.traineddata.gz')
            out[k] = p
          }
          return out
        }
      })
    }),
    port: empty,
    limits: hostLimits,
    heartbeat: empty,
    shutdown: empty
  },
  'MainToOcr'
)

/** Validate a main → coordinator message. */
export function parseMainToOcr(x: unknown): MainToOcr {
  return mainToOcr(x, 'MainToOcr')
}

/** A tripwire API label such as `process._linkedBinding` or `dns.promises.Resolver`. */
const apiName = pattern(/^[A-Za-z0-9_.()]{1,64}$/, 'an API name')

const tripwireCounts = object<TripwireCounts>({ process: count, raster: count, recognize: count })

const ocrToMain = message<OcrToMain>(
  {
    ready: object<{
      tripwire: number
      electronNet: Array<(typeof ELECTRON_NET_MEMBERS)[number]>
      selfCheck: TripwireSelfCheck
    }>({
      tripwire: count,
      electronNet: array(oneOf(ELECTRON_NET_MEMBERS), ELECTRON_NET_MEMBERS.length),
      selfCheck: object<TripwireSelfCheck>({
        checked: array(apiName, 64),
        failed: array(apiName, 64)
      })
    }),
    activity: object<OcrActivity>({ busy: bool, done: count, total: count }, { triage: bool }),
    heartbeat: object<Heartbeat>({
      tripwire: tripwireCounts,
      tripwireIntact: bool,
      rss: count,
      threads: object<{ raster: number; recognize: number }>({ raster: count, recognize: count }),
      pending: count,
      concurrency: count
    }),
    fatal: object<{ code: OcrErrorCode; message: string }>({
      code: oneOf(OCR_ERROR_CODES),
      message: text(500)
    })
  },
  'OcrToMain'
)

/**
 * Validate a coordinator → main message. Main runs this on everything the utility process says:
 * that process parses untrusted PDFs, so it is the less trusted side.
 */
export function parseOcrToMain(x: unknown): OcrToMain {
  return ocrToMain(x, 'OcrToMain')
}
