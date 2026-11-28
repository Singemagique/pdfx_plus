// The renderer's OCR store (DESIGN.md §3.3.1, §3.3.5–§3.3.6, §3.4.1 Stage 0, §3.5.2, §3.7.1, §3.8):
// everything the app knows about text recognition, kept OUTSIDE React state and Immer history (the
// search/find-controller.ts pattern). Components read it through useSyncExternalStore
// (`subscribe` + `getSnapshot` / `getPageState`); App feeds it the collection (`reconcile`) and the
// edit state it needs (`syncEdits`, `setFocus`).
//
// Results. `WeakMap<Uint8Array /* source.bytes */, SourceOcr>`, pages: Map<pageIndex,
// Map<configHash, PackedOcrPage>>, so duplicated or pasted pages (freshPageCopy keeps the bytes)
// share results, a page moved to another document keeps them, and an entry goes when nothing holds
// the bytes any more. The SELECTED config per page (Replace / Remove) is not here: it is the edit
// history's `ocrSelect` op, read through `syncEdits`.
//
// The port (§3.3.1). One protocol token per Uint8Array (`src`), reference-counted across the live
// page keys in `reconcile`: `close` is posted only when no live page uses a source any more, so
// removing a document after one of its pages moved elsewhere leaves that page's work alone. The
// port is connected lazily, only for a real need: a Stage 0 candidate, an imported-image source
// with auto-recognition on (D4), or an explicit request. A text PDF never connects. Every message
// from the port goes through the protocol parser (`parseFromOcr`); a malformed one is dropped, and
// the job's `jobDone` settles whatever it left unanswered.
//
// Work. A request (a BATCH: auto, user or replace) becomes per-page work items. Each source is
// triaged before any of its pages is recognised (PR6: without a verdict a page renders at 300 DPI
// and a near-scanned page keeps its stamp text), and the verdict decides what is recognised:
// scanned and near-scanned pages; a Replace also re-recognises `ocr-ours` pages. Requests go out
// per (source, config) with the page in view first (§3.3.6), and `focus` tells the coordinator the
// same. Progress is published at most 10 times a second with an EWMA (α = 0.3) ETA once 3 pages
// are done (§3.3.5). The App busy count is never touched. A request for a page already out with
// the same config follows that work (or takes it over from a crash), a source the coordinator
// refused fails its pages at once, and a page triage could not classify counts as recognised
// only when a request named it (or it is an imported image), in the export and in Find alike.
// Work dropped because its page left the collection is not "done"; automatic recognition asks
// again for the pages an undo brings back.
//
// Failures. A crash (the link drops with `crashed`, or `closed` while work is out) holds every
// unfinished page of the affected batches for Resume; finished pages stay. The pages the last
// progress event named as in flight are implicated, and a page implicated in two crashes is failed
// and never retried (§3.3.2). `crash-loop` and `fatal` end OCR for the session.
//
// Export (§3.7.1). `exportSource` is the OcrExportSource useExport takes: the mid-job prompt
// (`flushOrConfirm`, rendered by OcrExportPrompt), the snapshot with the ocrSelect choices applied
// (`applyOcrSelections`, auto only for scanned / near-scanned pages) and the D7 setting.
//
// Persistence: none (D8). Nothing recognised is ever written anywhere by this store.

import {
  OCR_DISCONNECT_REASONS,
  parseFromOcr,
  type FromOcr,
  type OcrDisconnectReason,
  type PageReason,
  type PageRequest,
  type PageResult,
  type ToOcr
} from '../../../shared/ocr/protocol'
import type { NativeWord, TriagePage } from '../../../shared/ocr/triage'
import type { OcrStatus, PackedOcrPage, PageClass } from '../../../shared/ocr/types'
import { defaultSettings, type Settings } from '../../../shared/settings'
import { makePageKey } from '../edit/model'
import type { EditLayer } from '../pdfx/build'
import type { PageText } from '../search/extract'
import type { FindTextAccess } from '../search/find-controller'
import type { DocEntry, PageEntry, PdfSource } from '../types'
import { ocrConfig, type OcrConfig } from './config'
import type { OcrExportSource } from './export-source'
import { applyOcrSelections, type PageResults } from './ocr-select'
import { isCandidatePage, stage0Decision, STAGE0_PAGES } from './stage0'

// ---------------------------------------------------------------------------------------------
// Public types.

/** `window.api.ocr` (preload): the port stays in the preload; only these cross contextBridge. */
export interface OcrPortLike {
  connect(): void
  post(message: ToOcr): boolean
  onMessage(callback: (message: unknown) => void): () => void
}

export type BatchKind = 'auto' | 'user' | 'replace'
export type BatchState = 'running' | 'done' | 'stopped' | 'crashed' | 'failed'

/** One request's progress, as the pill / chip / banner show it (PR8). */
export interface OcrBatchView {
  id: string
  kind: BatchKind
  state: BatchState
  langs: string[]
  /** Pages finished: recognised, skipped or failed. */
  done: number
  /** Pages in the request (finished + still to do); grows or shrinks as triage answers. */
  total: number
  recognized: number
  /** Skipped (protected, already has text, already recognised by PDFx): never "done" silently. */
  skipped: number
  /** Failed, too large, timed out, or needing a language. */
  failed: number
  /** The pages in flight, as a sum of per-page fractions (0..1 each). */
  inflightFrac: number
  /** EWMA estimate of the time left, ms; null until 3 pages are done. */
  etaMs: number | null
}

export type OcrLinkState = 'idle' | 'connecting' | 'connected' | 'unavailable'

export interface OcrSnapshot {
  version: number
  link: OcrLinkState
  /** Why OCR is off for the session (`link === 'unavailable'`). */
  unavailable: 'no-port' | 'crash-loop' | 'fatal' | null
  /** Every batch of the session, oldest first (finished ones stay, so toasts can follow them). */
  batches: readonly OcrBatchView[]
  /** Any batch running (pill, chip). */
  running: boolean
}

/** What the page badge, the summary popover and the dialog read for one page key (PR8). */
export interface OcrPageState {
  /** Triage's class; null before triage answered (or when it could not read the page). */
  pageClass: PageClass | null
  /** 'queued' / 'running' while work is out; else the last outcome, or 'none'. */
  status: 'none' | 'queued' | 'running' | 'held' | OcrStatus
  reason?: PageReason
  /** Why the page was not recognised (D5 copy etc.), when it was skipped by the store. */
  skip?: 'protected' | 'has-text' | 'ours' | 'blank'
  /** The page looks sideways: the extra clockwise turn it needs (§3.4.5). */
  rotateBy?: 90 | 180 | 270
  /** Recognised text this page currently exports / searches (its choice, or its auto result). */
  hasText: boolean
  meanConfCal: number | null
  /**
   * A scan for the OCR surfaces (PR8): scanned / near-scanned, or an imported image triage has not
   * classed yet (it is a photo of a page by construction).
   */
  scan: boolean
  /** Remove Recognized Text chose no text for the page (`ocrSelect … null`). */
  removed: boolean
  /** Triage answered for the page. */
  triaged: boolean
}

/** The mid-job export prompt (§3.8 "Export mid-job"); OcrExportPrompt renders it. */
export type OcrPrompt =
  /** Modal: [Wait and export] [Export now] [Cancel]. */
  | { kind: 'running'; done: number; total: number }
  /** Non-modal while waiting (the toolbar stays usable): [Export now] [Cancel]. */
  | { kind: 'waiting'; done: number; total: number; etaMs: number | null }
  /** Recognition stopped (crash, Stop) while waiting: [Export now] [Cancel]. */
  | { kind: 'stopped'; done: number; total: number }
  /** A Replace whose text is not available: [Export anyway] [Cancel]. */
  | { kind: 'missing'; pages: number }

export type OcrPromptAnswer = 'wait' | 'now' | 'cancel'

/** What the Find supply needs for one live page key (ocr-find-supply.ts). */
export interface OcrPageSupply {
  /** The page's selected recognised text (its choice, else its auto result), if any. */
  page: PackedOcrPage | undefined
  /** append: after the native text (scanned / near-scanned); replace: instead of it (ocr-ours). */
  mode: 'append' | 'replace'
  pageClass: PageClass | null
  /** Triage's visible native words, for the `replace` mode of an `ocr-ours` page. */
  nativeWords?: readonly NativeWord[]
  /** The page's own PDFx OCR layer is gone in an export (a choice, or a redaction on it). */
  dropsOwnLayer: boolean
  /** Triage answered for this page (its `pageClass` is a verdict, even when null). */
  triaged: boolean
  /** PDFx made the page's source from an imported image (it carries no text layer of its own). */
  imageOrigin: boolean
}

export interface OcrStoreOptions {
  /** The preload port (`window.api.ocr`); null: OCR is unavailable. */
  port: OcrPortLike | null
  /** Find's index (Stage 0 reads through it; its extractions are the full-extraction trigger). */
  text: FindTextAccess
  getSettings?: () => Promise<Settings>
  setSettings?: (patch: Partial<Settings>) => Promise<Settings>
  /** Run `fn` at idle priority; returns a canceller. Default: requestIdleCallback / setTimeout. */
  idle?: (fn: () => void) => () => void
  now?: () => number
  /** Minimum ms between two subscriber notifications (≤ 10 Hz: 100). */
  notifyMs?: number
  /** A page's /UserUnit (pdf.js `PDFPageProxy.userUnit`). */
  userUnit?: (pdf: PdfSource['pdf'], pageIndex: number) => Promise<number>
}

// ---------------------------------------------------------------------------------------------
// Internal model.

interface PageRec {
  triage?: TriagePage
  /** configHash → result. */
  results: Map<string, PackedOcrPage>
  /** The config this page's automatic recognition used (absent: none yet). */
  auto?: string
  /**
   * `auto` came from a request that named the page (the dialog, the banner): it counts even when
   * triage could not classify the page, since the user asked for exactly this text.
   */
  autoExplicit?: boolean
  last?: {
    status: OcrStatus
    reason?: PageReason
    rotateBy?: 90 | 180 | 270
    /** The edit rotation the page had when `rotateBy` was measured (the request's). */
    editRotation?: 0 | 90 | 180 | 270
  }
  skip?: OcrPageState['skip']
  /** Crashes this page was in flight for (§3.3.2: two → failed, never retried). */
  crashes: number
}

interface SourceOcr {
  src: string
  pages: Map<number, PageRec>
  /**
   * Stage 0: 'unknown' (not checked yet), 'checking', 'closed' (no candidate: never sent), 'open'
   * (send for triage), 'refused' (the coordinator refused the source: too large, unreadable).
   */
  gate: 'unknown' | 'checking' | 'closed' | 'open' | 'refused'
  /** Why the coordinator refused the source (`gate === 'refused'`): what its pages report. */
  refusal?: { status: OcrStatus; reason: PageReason }
  /** D4 / autoRecognizeOpened already fired for this source. */
  autoDone: boolean
  /**
   * Pages whose automatic recognition was dropped unfinished because they left the collection
   * (a delete, a closed document): asked for again when they come back (an undo).
   */
  autoDropped: Set<number>
  /** Process crashes while this source's triage was outstanding. */
  triageCrashes: number
}

interface LivePage {
  key: string
  entry: PageEntry
}

interface LiveSource {
  so: SourceOcr
  bytes: Uint8Array
  pdf: PdfSource['pdf']
  origin?: PdfSource['origin']
  /** pageIndex → its live page keys (duplicates share a source and an index). */
  pages: Map<number, LivePage[]>
}

type WorkState = 'triage' | 'ready' | 'sent' | 'held'

interface Work {
  id: string
  src: string
  so: SourceOcr
  index: number
  /** The batch that owns the work (its requests, its progress). */
  batch: Batch
  /**
   * Later batches that asked for the same page and config while this work was out: they follow
   * it (count its outcome, wait for it) instead of reporting an empty request as done.
   */
  watchers: Set<Batch>
  state: WorkState
  /** User / replace requests name their pages: a page that is not recognised counts as skipped. */
  explicit: boolean
  job?: CJob
  /** The edit rotation sent with the page's recognize request (what its `rotateBy` is against). */
  sentRotation?: 0 | 90 | 180 | 270
}

interface CJob {
  id: string
  src: string
  batch: Batch
  session: number
  /** Pages still to be answered. */
  pages: Map<number, Work>
  inflight: number[]
  inflightFrac: number
}

interface Batch {
  id: string
  kind: BatchKind
  config: OcrConfig
  state: BatchState
  works: Set<Work>
  recognized: number
  skipped: number
  failed: number
  /** Pages a Stop dropped (a stopped batch's total still counts them: "7 of 12"). */
  cancelled: number
  /** Pages that left the collection before they finished (not in the total: they are gone). */
  dropped: number
  startedAt: number
  lastFinishAt: number
  ewma: number | null
  samples: number
}

const RECOGNISED: ReadonlySet<OcrStatus> = new Set(['ok', 'low-confidence', 'no-text'])
const FAILED: ReadonlySet<OcrStatus> = new Set(['failed', 'timeout', 'too-large', 'needs-language'])
const SCANS: ReadonlySet<PageClass | null> = new Set(['scanned', 'near-scanned'])
/** Retries of one batch's requests for one source after `not-open` / lost-port answers. */
const MAX_RESENDS = 3

const defaultIdle = (fn: () => void): (() => void) => {
  const g = globalThis as {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number
    cancelIdleCallback?: (h: number) => void
  }
  if (g.requestIdleCallback) {
    const h = g.requestIdleCallback(fn, { timeout: 2000 })
    return () => g.cancelIdleCallback?.(h)
  }
  const t = setTimeout(fn, 50)
  return () => clearTimeout(t)
}

async function defaultUserUnit(pdf: PdfSource['pdf'], pageIndex: number): Promise<number> {
  try {
    const page = await pdf.getPage(pageIndex + 1)
    const u = (page as { userUnit?: unknown }).userUnit
    return typeof u === 'number' && Number.isFinite(u) && u > 0 ? u : 1
  } catch {
    return 1
  }
}

const quarter = (deg: number | undefined): 0 | 90 | 180 | 270 => {
  const d = ((Math.round((deg ?? 0) / 90) * 90) % 360) + 360
  return (d % 360) as 0 | 90 | 180 | 270
}

function isLinkEvent(
  m: unknown
): m is { link: { state: 'connected' } | { state: 'disconnected'; reason: OcrDisconnectReason } } {
  if (typeof m !== 'object' || m === null || !('link' in m)) return false
  const link = (m as { link: unknown }).link
  if (typeof link !== 'object' || link === null) return false
  const { state, reason } = link as { state?: unknown; reason?: unknown }
  if (state === 'connected') return true
  return state === 'disconnected' && (OCR_DISCONNECT_REASONS as readonly unknown[]).includes(reason)
}

// ---------------------------------------------------------------------------------------------

export interface OcrStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): OcrSnapshot
  /** Identity-stable until the page's state changes. Null for a key that is not live. */
  getPageState(pageKey: string): OcrPageState | null
  /** Track the live pages: sources by token, reference counts, Stage 0 and D4 for new sources. */
  reconcile(docs: readonly DocEntry[]): void
  /** The edit state the store reads: Replace / Remove choices, rotations, and how to record one. */
  syncEdits(edits: {
    ocrSelect?: ReadonlyMap<string, string | null>
    rotations?: ReadonlyMap<string, number>
    selectOcr?: (pageKey: string, configHash: string | null) => void
  }): void
  /** The page in view (recognised first, §3.3.6), or null. */
  setFocus(pageKey: string | null): void
  /**
   * Recognise `pageKeys` (user request: the dialog, the banner, the Find row). Triage decides per
   * page: scanned / near-scanned pages are recognised, others are skipped with a reason. Returns
   * the batch id, or null when OCR is unavailable or nothing is live.
   */
  recognize(pageKeys: readonly string[], opts?: { langs?: string[] }): string | null
  /**
   * Replace Recognized Text…: record the choice (one undoable `ocrSelect` per page, now) and
   * recognise the pages again with `langs`. Returns the batch id.
   */
  replace(pageKeys: readonly string[], langs: readonly string[]): string | null
  /** Remove Recognized Text: record `ocrSelect … null` (undoable). */
  remove(pageKeys: readonly string[]): void
  /** Stop one batch, or every running batch. Finished pages stay. */
  cancel(batchId?: string): void
  /** Resume batches a crash stopped (all, or one). */
  resume(batchId?: string): void
  /** Ask for triage of these pages' sources (the OCR dialog opened: gate (b) of Stage 0). */
  prepare(pageKeys: readonly string[]): void
  /** Live page keys with unrecognised scanned / near-scanned pages (button / chip visibility). */
  scannedPageKeys(): string[]
  /** The selected recognised text of a page (overlay, PR10), before redaction filtering. */
  pageSupply(pageKey: string): OcrPageSupply | null
  /** Change in results or selections (unthrottled; the Find supply listens). */
  onResults(listener: () => void): () => void
  settings(): Settings
  setSettings(patch: Partial<Settings>): Promise<void>
  /** The OcrExportSource for useExport (§3.7.1). */
  readonly exportSource: OcrExportSource
  getPrompt(): OcrPrompt | null
  answerPrompt(answer: OcrPromptAnswer): void
  dispose(): void
}

export function createOcrStore(opts: OcrStoreOptions): OcrStore {
  const port = opts.port
  const text = opts.text
  const now = opts.now ?? (() => Date.now())
  const idle = opts.idle ?? defaultIdle
  const notifyMs = opts.notifyMs ?? 100
  const userUnitOf = opts.userUnit ?? defaultUserUnit

  // ---- results and sources
  const sources = new WeakMap<Uint8Array, SourceOcr>()
  let live = new Map<string, LiveSource>()
  /** Live page key → its source token and page index. */
  let keyInfo = new Map<string, { src: string; index: number; entry: PageEntry }>()
  let liveDocs: readonly DocEntry[] = []
  let seq = 0
  const mint = (p: string): string => `${p}${(++seq).toString(36)}`

  // ---- edits
  let ocrSelect: ReadonlyMap<string, string | null> = new Map()
  let rotations: ReadonlyMap<string, number> = new Map()
  let selectOcr: ((pageKey: string, configHash: string | null) => void) | undefined
  let focusKey: string | null = null

  // ---- settings
  let currentSettings: Settings = defaultSettings('en')
  const settingsReady: Promise<void> = (async () => {
    try {
      const s = await opts.getSettings?.()
      if (s) {
        currentSettings = s
        // The dialog, the menu checkboxes and the Sign/export defaults follow the stored values.
        changed()
      }
    } catch {
      // Defaults: D4 on, D7 on, English.
    }
  })()

  // ---- link
  let link: OcrLinkState = port ? 'idle' : 'unavailable'
  let unavailable: OcrSnapshot['unavailable'] = port ? null : 'no-port'
  /** Incremented on every `connected`: a fresh coordinator session (sources must be reopened). */
  let session = 0
  /** src → the session its `open` was posted in. */
  const opened = new Map<string, number>()
  /** src → the pages a triage request is outstanding for, and in which session. */
  const triaging = new Map<string, { session: number; pages: Set<number> }>()
  const userUnits = new Map<string, number | Promise<number>>()
  const resends = new Map<string, number>()

  // ---- work
  const works = new Map<string, Work>()
  const jobs = new Map<string, CJob>()
  const batches: Batch[] = []

  // ---- notifications
  const listeners = new Set<() => void>()
  const resultListeners = new Set<() => void>()
  let version = 0
  let snapshot: OcrSnapshot | null = null
  const pageStates = new Map<string, OcrPageState>()
  let notifyTimer: ReturnType<typeof setTimeout> | null = null
  let lastNotify = -Infinity
  let disposed = false

  // ---- Stage 0 queue (one source at a time, idle priority)
  const stage0Queue: Array<{ src: string; so: SourceOcr }> = []
  let stage0Cancel: (() => void) | null = null
  let stage0Running = false

  // ---- prompt
  let prompt: OcrPrompt | null = null
  let promptAnswer: ((a: OcrPromptAnswer) => void) | null = null
  let promptBusy = false

  const workId = (src: string, index: number, hash: string): string => `${src}|${index}|${hash}`

  function rec(so: SourceOcr, index: number): PageRec {
    let r = so.pages.get(index)
    if (!r) so.pages.set(index, (r = { results: new Map(), crashes: 0 }))
    return r
  }

  // -------------------------------------------------------------------------------------------
  // Notifications.

  /** Unthrottled, coalesced to one microtask: what in-store waits (the export prompt) follow. */
  const stateListeners = new Set<() => void>()
  let stateQueued = false

  function changed(): void {
    version++
    snapshot = null
    if (!stateQueued && stateListeners.size > 0 && !disposed) {
      stateQueued = true
      queueMicrotask(() => {
        stateQueued = false
        for (const l of [...stateListeners]) l()
      })
    }
    if (disposed || notifyTimer) return
    const wait = Math.max(0, lastNotify + notifyMs - now())
    notifyTimer = setTimeout(() => {
      notifyTimer = null
      lastNotify = now()
      for (const l of [...listeners]) l()
    }, wait)
  }

  function resultsChanged(): void {
    changed()
    for (const l of [...resultListeners]) {
      try {
        l()
      } catch (err) {
        console.error(err)
      }
    }
  }

  function batchView(b: Batch): OcrBatchView {
    let inflightFrac = 0
    for (const j of jobs.values()) if (j.batch === b) inflightFrac += j.inflightFrac
    const done = b.recognized + b.skipped + b.failed
    const remaining = Math.max(0, b.works.size - inflightFrac)
    return {
      id: b.id,
      kind: b.kind,
      state: b.state,
      langs: b.config.langs,
      done,
      total: done + b.works.size + (b.state === 'stopped' ? b.cancelled : 0),
      recognized: b.recognized,
      skipped: b.skipped,
      failed: b.failed,
      inflightFrac,
      etaMs: b.samples >= 3 && b.ewma !== null && b.state === 'running' ? b.ewma * remaining : null
    }
  }

  function getSnapshot(): OcrSnapshot {
    if (!snapshot) {
      const views = batches.map(batchView)
      snapshot = {
        version,
        link,
        unavailable,
        batches: views,
        running: views.some((b) => b.state === 'running')
      }
    }
    return snapshot
  }

  // -------------------------------------------------------------------------------------------
  // Selection (shared by the export snapshot and the Find supply).

  /** The configHash a page exports and searches with: its choice, else its auto result. */
  function chosenHash(key: string, r: PageRec): string | null | undefined {
    if (ocrSelect.has(key)) return ocrSelect.get(key)
    return autoAllowed(key, r) ? r.auto : undefined
  }

  /**
   * The auto result counts on scanned / near-scanned pages, and on a page triage could not
   * classify when it was asked for by name or comes from an imported image (`autoCounts`).
   */
  function autoAllowed(key: string, r: PageRec): boolean {
    const info = keyInfo.get(key)
    return autoCounts(r, !!info && live.get(info.src)?.origin === 'image')
  }

  /** The one rule for which auto result exports and searches (snapshotFor and Find alike). */
  function autoCounts(r: PageRec, imageOrigin: boolean): boolean {
    const cls = r.triage?.pageClass ?? null
    if (SCANS.has(cls)) return true
    return cls === null && (imageOrigin || !!r.autoExplicit)
  }

  function recOf(key: string): { r: PageRec; src: string; index: number } | null {
    const info = keyInfo.get(key)
    if (!info) return null
    const ls = live.get(info.src)
    if (!ls) return null
    return { r: rec(ls.so, info.index), src: info.src, index: info.index }
  }

  /** `src|index` → the most advanced state of its work, rebuilt once per version. */
  let workByPage: { version: number; map: Map<string, WorkState> } | null = null
  const RANK: Record<WorkState, number> = { held: 0, triage: 1, ready: 2, sent: 3 }

  function workStateOf(src: string, index: number): WorkState | undefined {
    if (!workByPage || workByPage.version !== version) {
      const map = new Map<string, WorkState>()
      for (const w of works.values()) {
        const k = `${w.src}|${w.index}`
        const s = map.get(k)
        if (s === undefined || RANK[w.state] > RANK[s]) map.set(k, w.state)
      }
      workByPage = { version, map }
    }
    return workByPage.map.get(`${src}|${index}`)
  }

  function pageStateOf(key: string): OcrPageState | null {
    const found = recOf(key)
    if (!found) return null
    const { r, src, index } = found
    let status: OcrPageState['status'] = r.last?.status ?? 'none'
    const ws = workStateOf(src, index)
    if (ws) status = ws === 'sent' ? 'running' : ws === 'held' ? 'held' : 'queued'
    const hash = chosenHash(key, r)
    const page = hash ? r.results.get(hash) : undefined
    const cls = r.triage?.pageClass ?? null
    const state: OcrPageState = {
      pageClass: cls,
      status,
      hasText: !!page,
      meanConfCal: page?.meanConfCal ?? null,
      scan: SCANS.has(cls) || (cls === null && !r.triage && live.get(src)?.origin === 'image'),
      removed: hash === null,
      triaged: !!r.triage
    }
    if (r.last?.reason) state.reason = r.last.reason
    // "Sideways — rotate?" is against the rotation the page had when it was recognised: once the
    // user turns it by that much (or any way that makes it upright), the offer goes.
    if (r.last?.rotateBy) {
      const turned = quarter(rotations.get(key)) - (r.last.editRotation ?? 0)
      const left = quarter(r.last.rotateBy - turned)
      if (left) state.rotateBy = left
    }
    if (r.skip) state.skip = r.skip
    return state
  }

  function sameState(a: OcrPageState, b: OcrPageState): boolean {
    return (
      a.pageClass === b.pageClass &&
      a.status === b.status &&
      a.reason === b.reason &&
      a.skip === b.skip &&
      a.rotateBy === b.rotateBy &&
      a.hasText === b.hasText &&
      a.meanConfCal === b.meanConfCal &&
      a.scan === b.scan &&
      a.removed === b.removed &&
      a.triaged === b.triaged
    )
  }

  function getPageState(key: string): OcrPageState | null {
    const next = pageStateOf(key)
    if (!next) {
      pageStates.delete(key)
      return null
    }
    const prev = pageStates.get(key)
    if (prev && sameState(prev, next)) return prev
    pageStates.set(key, next)
    return next
  }

  function pageSupply(key: string): OcrPageSupply | null {
    const found = recOf(key)
    if (!found) return null
    const { r, src } = found
    const hash = chosenHash(key, r)
    const page = hash ? r.results.get(hash) : undefined
    const cls = r.triage?.pageClass ?? null
    const ours = cls === 'ocr-ours'
    const dropsOwnLayer = ours && ocrSelect.has(key)
    return {
      page,
      mode: ours ? 'replace' : 'append',
      pageClass: cls,
      nativeWords: r.triage?.nativeWords,
      dropsOwnLayer,
      triaged: !!r.triage,
      imageOrigin: live.get(src)?.origin === 'image'
    }
  }

  // -------------------------------------------------------------------------------------------
  // Reconcile.

  function reconcile(docs: readonly DocEntry[]): void {
    liveDocs = docs
    const next = new Map<string, LiveSource>()
    const nextKeys = new Map<string, { src: string; index: number; entry: PageEntry }>()
    for (const d of docs) {
      for (const p of d.pages) {
        const bytes = p.source?.bytes
        if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) continue
        let so = sources.get(bytes)
        if (!so) {
          so = {
            src: mint('s'),
            pages: new Map(),
            gate: 'unknown',
            autoDone: false,
            autoDropped: new Set(),
            triageCrashes: 0
          }
          sources.set(bytes, so)
        }
        let ls = next.get(so.src)
        if (!ls) {
          ls = { so, bytes, pdf: p.source.pdf, origin: p.source.origin, pages: new Map() }
          next.set(so.src, ls)
        }
        if (p.source.origin === 'image') ls.origin = 'image'
        const key = makePageKey(p.source.id, p.pageIndex)
        if (nextKeys.has(key)) continue
        nextKeys.set(key, { src: so.src, index: p.pageIndex, entry: p })
        const list = ls.pages.get(p.pageIndex)
        if (list) list.push({ key, entry: p })
        else ls.pages.set(p.pageIndex, [{ key, entry: p }])
      }
    }
    const prev = live
    live = next
    keyInfo = nextKeys
    let dropped = false
    // A source no live page uses any more: its queued pages go silently, then `close` (§3.3.4).
    for (const [src] of prev) {
      if (next.has(src)) continue
      dropSourceWork(src)
      if (opened.has(src)) {
        if (link === 'connected' || link === 'connecting') post({ close: src })
        opened.delete(src)
      }
      triaging.delete(src)
      dropped = true
    }
    // Pages of a still-live source that left: their unsent work goes; sent work runs on (cheap,
    // and a page that comes back finds its result).
    for (const w of [...works.values()]) {
      const ls = live.get(w.src)
      if (ls && !ls.pages.has(w.index) && w.state !== 'sent') {
        dropWork(w)
        dropped = true
      }
    }
    for (const key of [...pageStates.keys()]) if (!keyInfo.has(key)) pageStates.delete(key)
    for (const [src, ls] of next) if (!prev.has(src)) onNewSource(src, ls)
    // Automatic recognition a removal cut short: the pages that came back (an undo) ask again.
    for (const [src, ls] of next) {
      const so = ls.so
      if (so.autoDropped.size === 0) continue
      const back = [...so.autoDropped].filter((i) => ls.pages.has(i)).sort((a, b) => a - b)
      if (back.length === 0) continue
      for (const i of back) so.autoDropped.delete(i)
      const keys = back.map((i) => ls.pages.get(i)![0].key)
      void settingsReady.then(() => {
        if (disposed || !live.has(src) || !autoSetting(src)) return
        startBatch('auto', keys, currentSettings['ocr.languages'], false)
      })
    }
    changed()
    if (dropped) pump()
  }

  /** The automatic-recognition setting that applies to a live source (D4, or opened scans). */
  function autoSetting(src: string): boolean {
    return live.get(src)?.origin === 'image'
      ? currentSettings['ocr.autoRecognizeImports']
      : currentSettings['ocr.autoRecognizeOpened']
  }

  function onNewSource(src: string, ls: LiveSource): void {
    const so = ls.so
    if (ls.origin === 'image') {
      // Imported image: no Stage 0 (§3.4.1); D4 recognises it once settings say so. With D4 off
      // the gate stays shut: its bytes go to the process only on a request (startBatch, prepare).
      void settingsReady.then(() => {
        if (disposed || !live.has(src) || so.autoDone) return
        if (!currentSettings['ocr.autoRecognizeImports']) return
        so.autoDone = true
        startBatch('auto', livePageKeysOf(src), currentSettings['ocr.languages'], false)
      })
      return
    }
    if (so.gate === 'unknown') queueStage0(src)
    else if (so.gate === 'open') pump()
  }

  function livePageKeysOf(src: string): string[] {
    const ls = live.get(src)
    if (!ls) return []
    return [...ls.pages.keys()].sort((a, b) => a - b).map((i) => ls.pages.get(i)![0].key)
  }

  /** Cancel every piece of work for `src` silently (it is no longer live). */
  function dropSourceWork(src: string): void {
    for (const j of [...jobs.values()]) {
      if (j.src !== src) continue
      jobs.delete(j.id)
      if (j.session === postSession()) post({ cancel: j.id })
    }
    for (const w of [...works.values()]) if (w.src === src) dropWork(w)
  }

  /**
   * `w`'s page left the collection before it finished: off the books uncounted (`dropped`, not in
   * any total), and remembered when automatic recognition wanted it, so an undo that brings the
   * page back asks again (reconcile).
   */
  function dropWork(w: Work): void {
    if (works.get(w.id) !== w) return
    const holders = [w.batch, ...w.watchers]
    if (holders.some((b) => b.kind === 'auto')) w.so.autoDropped.add(w.index)
    for (const b of holders) b.dropped++
    finishWork(w, null)
  }

  // -------------------------------------------------------------------------------------------
  // Stage 0 (§3.4.1): idle priority, through Find's extractor and store.

  function queueStage0(src: string): void {
    const ls = live.get(src)
    if (!ls || ls.so.gate !== 'unknown') return
    ls.so.gate = 'checking'
    stage0Queue.push({ src, so: ls.so })
    runStage0Soon()
  }

  function runStage0Soon(): void {
    if (stage0Running || stage0Cancel || disposed || stage0Queue.length === 0) return
    stage0Cancel = idle(() => {
      stage0Cancel = null
      void runOneStage0()
    })
  }

  async function runOneStage0(): Promise<void> {
    const item = stage0Queue.shift()
    if (item === undefined) return
    const { src, so } = item
    stage0Running = true
    /**
     * The source (or one of the pages being read) left the collection mid-run: no decision on
     * partial texts. The gate goes back to 'unknown', so the source is checked afresh, now if it is
     * still live, or by onNewSource when it comes back (an undo).
     */
    const restart = (): void => {
      if (so.gate !== 'checking') return
      so.gate = 'unknown'
      if (live.get(src)?.so === so) queueStage0(src)
    }
    try {
      if (so.gate !== 'checking') return
      const ls = live.get(src)
      if (!ls) return restart()
      // The first min(8, n) live pages of the source in page order, and the page in view.
      const indices = [...ls.pages.keys()].sort((a, b) => a - b)
      const focus = focusKey ? keyInfo.get(focusKey) : undefined
      const inView = focus && focus.src === src ? indices.indexOf(focus.index) : -1
      const positions = new Map<number, number>()
      for (let i = 0; i < Math.min(STAGE0_PAGES, indices.length); i++) positions.set(i, indices[i])
      if (inView >= STAGE0_PAGES) positions.set(inView, indices[inView])
      const texts = new Map<number, Pick<PageText, 'items'>>()
      for (const [pos, index] of positions) {
        if (disposed || so.gate !== 'checking') return
        const key = live.get(src)?.pages.get(index)?.[0]?.key
        if (!key) return restart()
        let t: Pick<PageText, 'items'> | undefined
        let threw = false
        try {
          t = await text.readNative(key)
        } catch {
          threw = true
        }
        if (disposed || so.gate !== 'checking') return
        // Undefined also means the key stopped being live while its text was read: that is no
        // evidence about the page, so start over rather than call it a candidate.
        if (!keyInfo.has(key) || keyInfo.get(key)!.src !== src) return restart()
        // Text that cannot be read (the engine stores an empty text for a failed extraction) is
        // exactly what triage is for: a candidate.
        texts.set(pos, (!threw && t) || { items: [] })
        if (isCandidatePage(texts.get(pos)!)) break
        // One page per idle slice: the pdf.js worker is shared with thumbnails and Find.
        await new Promise<void>((r) => {
          stage0Cancel = idle(() => {
            stage0Cancel = null
            r()
          })
        })
      }
      if (disposed || so.gate !== 'checking') return
      if (!live.has(src)) return restart()
      const decision = stage0Decision({
        pageCount: indices.length,
        inView: inView >= 0 ? inView : null,
        texts
      })
      if (decision.kind === 'candidate') openGate(src)
      else if (decision.kind === 'not-candidate') so.gate = 'closed'
      else restart()
    } finally {
      stage0Running = false
      runStage0Soon()
    }
  }

  /** Find's full extraction (or Stage 0's own reads) found a page that may be a scan. */
  function onNativeText(key: string, pt: Pick<PageText, 'items'>): void {
    const info = keyInfo.get(key)
    if (!info) return
    const ls = live.get(info.src)
    // An imported image has no Stage 0: D4 or a request sends it, never its (empty) native text.
    if (!ls || ls.origin === 'image') return
    const gate = ls.so.gate
    if (gate === 'open' || gate === 'refused') return
    if (isCandidatePage(pt)) openGate(info.src)
  }

  function openGate(src: string): void {
    const ls = live.get(src)
    if (!ls || ls.so.gate === 'open' || ls.so.gate === 'refused') return
    const so = ls.so
    so.gate = 'open'
    changed()
    pump()
    void settingsReady.then(() => {
      if (disposed || !live.has(src) || so.autoDone) return
      if (!autoSetting(src)) return
      so.autoDone = true
      startBatch('auto', livePageKeysOf(src), currentSettings['ocr.languages'], false)
    })
  }

  // -------------------------------------------------------------------------------------------
  // Batches and work.

  function startBatch(
    kind: BatchKind,
    pageKeys: readonly string[],
    langs: readonly string[],
    explicit: boolean
  ): string | null {
    if (link === 'unavailable' || langs.length === 0) return null
    const config = ocrConfig(langs)
    const b: Batch = {
      id: mint('b'),
      kind,
      config,
      state: 'running',
      works: new Set(),
      recognized: 0,
      skipped: 0,
      failed: 0,
      cancelled: 0,
      dropped: 0,
      startedAt: now(),
      lastFinishAt: now(),
      ewma: null,
      samples: 0
    }
    const seen = new Set<string>()
    for (const key of pageKeys) {
      const info = keyInfo.get(key)
      if (!info) continue
      const ls = live.get(info.src)
      if (!ls) continue
      const id = workId(info.src, info.index, config.hash)
      if (seen.has(id)) continue
      seen.add(id)
      const r = rec(ls.so, info.index)
      if (r.results.has(config.hash)) continue // already recognised with this config
      if (ls.so.gate === 'refused') {
        // The coordinator refused the whole source (too large, unreadable): nothing will be sent,
        // so the page fails now, with the refusal's reason, instead of waiting forever.
        r.last = { ...(ls.so.refusal ?? { status: 'failed', reason: 'render' }) }
        b.failed++
        continue
      }
      if (r.crashes >= 2) {
        // §3.3.2: a page implicated in two crashes is failed and not retried.
        if (explicit) b.failed++
        continue
      }
      const existing = works.get(id)
      if (existing) {
        // The same page and config is already out: follow it rather than report an empty request.
        if (explicit) existing.explicit = true
        b.works.add(existing)
        if (existing.state === 'held') adopt(existing, b, r)
        else existing.watchers.add(b)
        continue
      }
      const w: Work = {
        id,
        src: info.src,
        so: ls.so,
        index: info.index,
        batch: b,
        watchers: new Set(),
        state: 'triage',
        explicit
      }
      works.set(id, w)
      b.works.add(w)
      ls.so.gate = 'open'
      void unitFor(info.src, info.index)
      // Triage already answered for this page (this session or an earlier one): decide now.
      if (r.triage) decide(w, r)
    }
    batches.push(b)
    if (b.works.size === 0) b.state = 'done'
    changed()
    pump()
    return b.id
  }

  /**
   * A new request takes over a page a crash holds for Resume (asking again is resuming it): the
   * crashed batch lets it go (counted as cancelled there), and it is decided again for `b`.
   */
  function adopt(w: Work, b: Batch, r: PageRec): void {
    const old = w.batch
    old.works.delete(w)
    old.cancelled++
    if (old.works.size === 0 && old.state === 'crashed') old.state = 'stopped'
    w.watchers.delete(b)
    w.batch = b
    w.state = 'triage'
    if (r.triage) decide(w, r)
  }

  /** What triage's verdict means for `w` (§3.4.1 table): recognise, or skip with a reason. */
  function decide(w: Work, r: PageRec): void {
    const t = r.triage!
    const cls = t.pageClass
    if (cls === 'protected') return skipWork(w, r, 'protected', 'skipped-protected')
    if (holders(w).some((b) => b.kind === 'replace')) {
      w.state = 'ready'
      return
    }
    if (SCANS.has(cls)) {
      w.state = 'ready'
      return
    }
    if (cls === null) {
      if (t.failure === 'too-large') {
        r.last = { status: 'too-large', reason: 'page-too-large' }
        return finishWork(w, 'failed')
      }
      // Unreadable by triage: an explicit request (or an imported image) still tries.
      if (w.explicit || live.get(w.src)?.origin === 'image') {
        w.state = 'ready'
        return
      }
      return finishWork(w, null)
    }
    if (cls === 'ocr-ours') return skipWork(w, r, 'ours')
    if (cls === 'blank') return skipWork(w, r, 'blank')
    // ocr-foreign (D5), text, mixed, broken-text: already has (or is treated as having) text.
    return skipWork(w, r, 'has-text', cls === 'ocr-foreign' ? 'skipped-has-text' : undefined)
  }

  function skipWork(w: Work, r: PageRec, skip: OcrPageState['skip'], status?: OcrStatus): void {
    r.skip = skip
    if (status) r.last = { status }
    // Only a page the request named counts as skipped; an auto request just leaves it alone.
    finishWork(w, w.explicit || skip === 'protected' ? 'skipped' : null)
  }

  /** The batches a work counts for: its owner, then the requests following it. */
  const holders = (w: Work): Batch[] => [w.batch, ...w.watchers]

  /** Take `w` off the books, counted as `outcome` (null: not counted at all) in every holder. */
  function finishWork(w: Work, outcome: 'recognized' | 'skipped' | 'failed' | null): void {
    if (works.get(w.id) !== w) return
    works.delete(w.id)
    if (w.job) w.job.pages.delete(w.index)
    for (const b of holders(w)) {
      b.works.delete(w)
      if (outcome) {
        b[outcome]++
        if (outcome !== 'skipped') {
          const t = now()
          const interval = t - b.lastFinishAt
          b.lastFinishAt = t
          b.ewma = b.ewma === null ? interval : 0.3 * interval + 0.7 * b.ewma
          b.samples++
        }
      }
      if (b.works.size === 0 && (b.state === 'running' || b.state === 'crashed')) {
        // A request whose every page left the collection before it finished did not complete:
        // 'stopped', not 'done' (a toast must not say "recognised" for it).
        const finished = b.recognized + b.skipped + b.failed
        b.state = finished === 0 && b.dropped > 0 ? 'stopped' : 'done'
      }
    }
    changed()
  }

  function unitFor(src: string, index: number): number | null {
    const k = `${src}|${index}`
    const known = userUnits.get(k)
    if (typeof known === 'number') return known
    if (known) return null
    const ls = live.get(src)
    if (!ls) return null
    const p = userUnitOf(ls.pdf, index).then(
      (u) => {
        userUnits.set(k, u)
        pump()
        return u
      },
      () => {
        userUnits.set(k, 1)
        pump()
        return 1
      }
    )
    userUnits.set(k, p)
    return null
  }

  // -------------------------------------------------------------------------------------------
  // Dispatch.

  let pumpQueued = false

  function pump(): void {
    if (pumpQueued || disposed) return
    pumpQueued = true
    queueMicrotask(() => {
      pumpQueued = false
      if (!disposed) dispatch()
    })
  }

  /** The session a message posted now lands in. */
  const postSession = (): number => (link === 'connected' ? session : session + 1)

  function post(msg: ToOcr): boolean {
    if (!port) return false
    try {
      return port.post(msg)
    } catch (err) {
      console.warn('ocr: post failed', err)
      return false
    }
  }

  function ensureLink(): boolean {
    if (link === 'unavailable' || !port) return false
    if (link === 'idle') {
      link = 'connecting'
      try {
        port.connect()
      } catch (err) {
        console.warn('ocr: connect failed', err)
        link = 'idle'
        return false
      }
      changed()
    }
    return true
  }

  /** Sources that need the process now: gated ones awaiting triage, and ones with work. */
  function sourcesNeedingWork(): string[] {
    const out = new Set<string>()
    for (const w of works.values()) if (w.state === 'triage' || w.state === 'ready') out.add(w.src)
    for (const [src, ls] of live) {
      if (ls.so.gate !== 'open' || ls.so.triageCrashes >= 2) continue
      for (const i of ls.pages.keys()) {
        if (!ls.so.pages.get(i)?.triage) {
          out.add(src)
          break
        }
      }
    }
    return [...out]
  }

  function ordered(src: string, indices: Iterable<number>): number[] {
    const focus = focusKey ? keyInfo.get(focusKey) : undefined
    const f = focus && focus.src === src ? focus.index : -1
    return [...indices].sort((a, b) => (a === f ? -1 : b === f ? 1 : a - b))
  }

  function dispatch(): void {
    const needed = sourcesNeedingWork()
    if (needed.length === 0) return
    if (!ensureLink()) {
      if (link === 'unavailable') failAll()
      return
    }
    const target = postSession()
    for (const src of needed) {
      const ls = live.get(src)
      if (!ls || ls.so.gate === 'refused') continue
      if (opened.get(src) !== target) {
        if (!post({ open: { src, bytes: ls.bytes } })) continue
        opened.set(src, target)
        triaging.delete(src)
      }
      // Triage every live page without a verdict (requested pages first) before recognising.
      const t = triaging.get(src)
      const pending = t && t.session === target ? t.pages : new Set<number>()
      const want: number[] = []
      for (const i of ls.pages.keys())
        if (!ls.so.pages.get(i)?.triage && !pending.has(i)) want.push(i)
      if (want.length > 0 && ls.so.triageCrashes < 2) {
        const pages = ordered(src, want)
        post({ triage: { src, pages } })
        const set = t && t.session === target ? t.pages : new Set<number>()
        for (const p of pages) set.add(p)
        triaging.set(src, { session: target, pages: set })
      } else if (ls.so.triageCrashes >= 2) {
        // Triage of this source took the process down twice: no verdict will come. A named page
        // is still tried (the coordinator renders it at its default DPI); an auto one is left.
        for (const w of [...works.values()]) {
          if (w.src !== src || w.state !== 'triage') continue
          if (w.explicit || ls.origin === 'image') w.state = 'ready'
          else finishWork(w, null)
        }
      }
      // Ready work → one recognize request per (batch, source).
      const groups = new Map<Batch, Work[]>()
      for (const w of works.values()) {
        if (w.src !== src || w.state !== 'ready') continue
        if (unitFor(src, w.index) === null) continue
        const g = groups.get(w.batch)
        if (g) g.push(w)
        else groups.set(w.batch, [w])
      }
      for (const [b, ws] of groups) {
        const order = ordered(
          src,
          ws.map((w) => w.index)
        )
        const byIndex = new Map(ws.map((w) => [w.index, w]))
        const pages: PageRequest[] = order.map((index) => {
          const lp = ls.pages.get(index)![0]
          const req: PageRequest = {
            index,
            userUnit: unitFor(src, index) ?? 1,
            width: lp.entry.width,
            height: lp.entry.height
          }
          const rot = quarter(rotations.get(lp.key))
          if (rot) req.editRotation = rot
          return req
        })
        const job: CJob = {
          id: mint('j'),
          src,
          batch: b,
          session: target,
          pages: new Map(),
          inflight: [],
          inflightFrac: 0
        }
        if (!post({ recognize: { jobId: job.id, src, pages, opts: { langs: b.config.langs } } }))
          continue
        jobs.set(job.id, job)
        for (const [i, index] of order.entries()) {
          const w = byIndex.get(index)!
          w.state = 'sent'
          w.job = job
          w.sentRotation = pages[i].editRotation ?? 0
          job.pages.set(index, w)
        }
      }
    }
    const focus = focusKey ? keyInfo.get(focusKey) : undefined
    if (focus && opened.get(focus.src) === target)
      post({ focus: { src: focus.src, index: focus.index } })
    changed()
  }

  /** OCR is off for the session: every running batch fails. */
  function failAll(): void {
    // States first: finishWork would call a batch it empties 'done'.
    for (const b of batches) if (b.state === 'running' || b.state === 'crashed') b.state = 'failed'
    for (const w of [...works.values()]) finishWork(w, null)
    jobs.clear()
    changed()
  }

  // -------------------------------------------------------------------------------------------
  // Messages from the port.

  function onMessage(raw: unknown): void {
    if (disposed) return
    if (isLinkEvent(raw)) {
      if (raw.link.state === 'connected') onConnected()
      else onDisconnected(raw.link.reason)
      return
    }
    let msg: FromOcr
    try {
      msg = parseFromOcr(raw)
    } catch (err) {
      // Never echo the content; the job's jobDone settles what this message would have.
      console.warn('ocr: dropped a malformed message', err instanceof Error ? err.message : '')
      return
    }
    if ('triaged' in msg) onTriaged(msg.triaged.src, msg.triaged.pages, msg.triaged.done)
    else if ('result' in msg) onResult(msg.result.jobId, msg.result.index, msg.result.page)
    else if ('progress' in msg) {
      const j = jobs.get(msg.progress.jobId)
      if (j) {
        j.inflightFrac = msg.progress.inflightFrac
        j.inflight = msg.progress.inflight ?? []
        changed()
      }
    } else if ('jobDone' in msg) onJobDone(msg.jobDone.jobId)
    else if ('evicted' in msg) {
      opened.delete(msg.evicted.src)
      triaging.delete(msg.evicted.src)
      pump()
    } else if ('error' in msg) onError(msg.error)
    // `opened` needs nothing: requests were queued behind the open on the same port.
  }

  function onConnected(): void {
    session++
    link = 'connected'
    // Anything posted to an earlier session is gone with it (a replaced port voids its session).
    for (const j of [...jobs.values()]) if (j.session < session) loseJob(j)
    for (const [src, t] of [...triaging]) if (t.session < session) triaging.delete(src)
    for (const [src, s] of [...opened]) if (s < session) opened.delete(src)
    changed()
    pump()
  }

  /** A job the port lost without a crash: its pages go back to ready, uncharged. */
  function loseJob(j: CJob): void {
    jobs.delete(j.id)
    for (const w of j.pages.values()) {
      w.job = undefined
      if (works.get(w.id) === w && w.state === 'sent') w.state = 'ready'
    }
  }

  function onDisconnected(reason: OcrDisconnectReason): void {
    const hadWork = jobs.size > 0
    opened.clear()
    if (reason === 'crash-loop' || reason === 'fatal') {
      link = 'unavailable'
      unavailable = reason
      triaging.clear()
      failAll()
      return
    }
    link = 'idle'
    if (reason === 'crashed' || (reason === 'closed' && hadWork)) crashed()
    else {
      for (const j of [...jobs.values()]) loseJob(j)
      triaging.clear()
      pump()
    }
    changed()
  }

  /** The process died with work out (§3.3.2): implicate, hold for Resume. */
  function crashed(): void {
    const hit = new Set<Batch>()
    for (const j of [...jobs.values()]) {
      jobs.delete(j.id)
      hit.add(j.batch)
      const ls = live.get(j.src)
      for (const index of j.inflight) {
        const w = j.pages.get(index)
        if (!w || !ls) continue
        const r = rec(ls.so, index)
        r.crashes++
        if (r.crashes >= 2) {
          r.last = { status: 'failed', reason: 'recognize-crash' }
          finishWork(w, 'failed')
        }
      }
      for (const w of j.pages.values()) {
        w.job = undefined
        if (works.get(w.id) === w) w.state = 'held'
      }
    }
    // Triage that was out for a source counts against it: two crashes and its triage stops.
    for (const [src] of triaging) {
      const ls = live.get(src)
      if (ls) ls.so.triageCrashes++
    }
    triaging.clear()
    // Every unfinished page of an affected batch is held, and so is every request following one of
    // those pages (otherwise it would stay 'running' on work nobody runs until a Resume it never
    // gets offered).
    const todo = [...hit]
    while (todo.length > 0) {
      const b = todo.pop()!
      for (const w of b.works) {
        if (w.state !== 'held') w.state = 'held'
        for (const o of holders(w))
          if (!hit.has(o)) {
            hit.add(o)
            todo.push(o)
          }
      }
    }
    for (const b of hit)
      if (b.works.size > 0 && (b.state === 'running' || b.state === 'crashed')) b.state = 'crashed'
    changed()
  }

  function onTriaged(src: string, pages: readonly TriagePage[], done: boolean): void {
    const ls = live.get(src)
    const t = triaging.get(src)
    for (const p of pages) t?.pages.delete(p.index)
    if (done && t && t.pages.size === 0) triaging.delete(src)
    if (!ls) return
    let touched = false
    for (const p of pages) {
      const r = rec(ls.so, p.index)
      r.triage = p
      touched = true
      for (const w of [...works.values()])
        if (w.src === src && w.index === p.index && w.state === 'triage') decide(w, r)
    }
    if (touched) resultsChanged()
    pump()
  }

  function onResult(jobId: string, index: number, page: PageResult): void {
    const j = jobs.get(jobId)
    if (!j) return // cancelled or lost: its pages were already accounted for
    const w = j.pages.get(index)
    j.pages.delete(index)
    const ls = live.get(j.src)
    if (ls) {
      const r = rec(ls.so, index)
      r.last = { status: page.status }
      if (page.reason) r.last.reason = page.reason
      if (page.rotateBy) {
        r.last.rotateBy = page.rotateBy
        r.last.editRotation = w?.sentRotation ?? 0
      }
      if (page.status === 'skipped-protected') r.skip = 'protected'
      if (page.recognition && RECOGNISED.has(page.status)) {
        r.results.set(j.batch.config.hash, page.recognition)
        // A Replace's text is only ever its choice (undo brings the automatic text back), unless a
        // plain request asked for the same page and config too.
        const asked = w ? holders(w) : [j.batch]
        if (asked.some((b) => b.kind !== 'replace')) {
          r.auto = j.batch.config.hash
          r.autoExplicit = !!w?.explicit && asked.some((b) => b.kind === 'user')
        }
      }
    }
    if (w) {
      // skipped-protected counts as done in jobDone; it is a skip here, never "recognised".
      const outcome = RECOGNISED.has(page.status)
        ? 'recognized'
        : FAILED.has(page.status)
          ? 'failed'
          : 'skipped'
      finishWork(w, outcome)
    }
    resultsChanged()
  }

  function onJobDone(jobId: string): void {
    const j = jobs.get(jobId)
    if (!j) return
    jobs.delete(jobId)
    // Pages the job never answered (a message the parser refused): failed, not silently done.
    for (const w of j.pages.values()) {
      const ls = live.get(w.src)
      if (ls) rec(ls.so, w.index).last = { status: 'failed' }
      finishWork(w, 'failed')
    }
    changed()
  }

  function onError(e: { code: string; src?: string; jobId?: string }): void {
    if (e.jobId) {
      const j = jobs.get(e.jobId)
      if (!j) return
      if (e.code === 'not-open' || e.code === 'duplicate') {
        // The source was not open on the coordinator's side: open again and resend (bounded).
        opened.delete(j.src)
        const k = `${j.batch.id}|${j.src}`
        const n = (resends.get(k) ?? 0) + 1
        resends.set(k, n)
        if (n > MAX_RESENDS) {
          jobs.delete(j.id)
          for (const w of j.pages.values()) finishWork(w, 'failed')
        } else loseJob(j)
        pump()
      }
      return
    }
    if (!e.src) {
      console.warn(`ocr: coordinator error ${e.code}`)
      return
    }
    const src = e.src
    const ls = live.get(src)
    if (e.code === 'duplicate') return // already open there: fine
    if (e.code === 'not-open') {
      opened.delete(src)
      triaging.delete(src)
      const n = (resends.get(src) ?? 0) + 1
      resends.set(src, n)
      if (n <= MAX_RESENDS) pump()
      return
    }
    if (e.code === 'too-large' || e.code === 'open-failed') {
      // The source cannot be recognised at all: refuse it for the session.
      opened.delete(src)
      triaging.delete(src)
      if (!ls) return
      ls.so.gate = 'refused'
      const reason: PageReason = e.code === 'too-large' ? 'source-too-large' : 'render'
      const status: OcrStatus = e.code === 'too-large' ? 'too-large' : 'failed'
      ls.so.refusal = { status, reason }
      for (const j of [...jobs.values()]) if (j.src === src) jobs.delete(j.id)
      for (const w of [...works.values()]) {
        if (w.src !== src) continue
        rec(ls.so, w.index).last = { status, reason }
        finishWork(w, 'failed')
      }
      resultsChanged()
      return
    }
    console.warn(`ocr: coordinator error ${e.code}`)
  }

  const unsubscribePort = port?.onMessage(onMessage) ?? null
  const unsubscribeText = text.onNativeText(onNativeText)

  // -------------------------------------------------------------------------------------------
  // Commands.

  function cancelBatch(b: Batch): void {
    if (b.state !== 'running' && b.state !== 'crashed') return
    let requeued = false
    for (const j of [...jobs.values()]) {
      if (j.batch !== b) continue
      jobs.delete(j.id)
      if (j.session === postSession()) post({ cancel: j.id })
      // Pages another request still follows go out again under it (see below).
      for (const w of j.pages.values()) {
        w.job = undefined
        if (w.state === 'sent') w.state = 'ready'
      }
    }
    for (const w of [...b.works]) {
      b.cancelled++
      if (w.batch !== b) {
        // b only followed this page: the request that owns it carries on.
        w.watchers.delete(b)
        b.works.delete(w)
        continue
      }
      const heir = w.watchers.values().next().value
      if (heir) {
        // Another request asked for this page too: it is not stopped for that one.
        w.watchers.delete(heir)
        w.batch = heir
        b.works.delete(w)
        requeued = true
        continue
      }
      finishWork(w, null)
    }
    b.state = 'stopped'
    changed()
    if (requeued) pump()
  }

  function resumeBatch(b: Batch): void {
    if (b.state !== 'crashed') return
    b.state = 'running'
    for (const w of b.works) {
      if (w.state !== 'held') continue
      const ls = live.get(w.src)
      const r = ls ? rec(ls.so, w.index) : undefined
      w.state = 'triage'
      if (r?.triage) decide(w, r)
    }
    if (b.works.size === 0) b.state = 'done'
    changed()
    pump()
  }

  // -------------------------------------------------------------------------------------------
  // Export (§3.7.1, §3.8).

  /** Work still to do for the pages of `docs` (held work is not running). */
  function pendingFor(docs: readonly DocEntry[]): { pending: number; done: number; total: number } {
    const srcs = new Set<string>()
    for (const d of docs)
      for (const p of d.pages) {
        const bytes = p.source?.bytes
        const so = bytes instanceof Uint8Array ? sources.get(bytes) : undefined
        if (so) srcs.add(so.src)
      }
    let pending = 0
    const touched = new Set<Batch>()
    for (const w of works.values()) {
      if (!srcs.has(w.src) || w.state === 'held') continue
      const running = holders(w).filter((b) => b.state === 'running')
      if (running.length === 0) continue
      pending++
      for (const b of running) touched.add(b)
    }
    let done = 0
    let total = 0
    for (const b of touched) {
      const v = batchView(b)
      done += v.done
      total += v.total
    }
    return { pending, done, total }
  }

  /** Live pages whose Replace names a result the store does not hold and nothing is producing. */
  function missingReplacements(docs: readonly DocEntry[]): number {
    let n = 0
    for (const d of docs)
      for (const p of d.pages) {
        const key = makePageKey(p.source.id, p.pageIndex)
        const hash = ocrSelect.get(key)
        if (!hash) continue
        const found = recOf(key)
        if (found?.r.results.has(hash)) continue
        const w = found ? works.get(workId(found.src, found.index, hash)) : undefined
        if (w && w.state !== 'held') continue
        n++
      }
    return n
  }

  function ask(p: OcrPrompt): Promise<OcrPromptAnswer> {
    prompt = p
    changed()
    return new Promise((resolve) => {
      promptAnswer = (a) => {
        promptAnswer = null
        prompt = null
        changed()
        resolve(a)
      }
    })
  }

  /** "Wait and export": until nothing is pending, or the user says otherwise. */
  function waitForPending(): Promise<'done' | 'now' | 'cancel' | 'stopped'> {
    // The batches this wait is for: if one of them ends crashed or stopped, the export would lack
    // pages the user chose to wait for, so that is asked again rather than exported silently.
    const waitedOn = new Set<Batch>()
    for (const w of works.values())
      for (const b of holders(w)) if (b.state === 'running') waitedOn.add(b)
    return new Promise((resolve) => {
      let finished = false
      const finish = (r: 'done' | 'now' | 'cancel' | 'stopped'): void => {
        if (finished) return
        finished = true
        stateListeners.delete(check)
        promptAnswer = null
        prompt = null
        changed()
        resolve(r)
      }
      const check = (): void => {
        if (finished) return
        const p = pendingFor(liveDocs)
        if (p.pending === 0) {
          // Stopped or crashed with pages left: say so instead of exporting without them. (A request
          // whose pages all left the collection is 'stopped' with nothing cancelled: nothing the
          // export could include is missing.)
          const stopped = [...waitedOn].some(
            (b) => b.state === 'crashed' || (b.state === 'stopped' && b.cancelled > 0)
          )
          finish(stopped ? 'stopped' : 'done')
          return
        }
        const etas = batches.map(batchView).filter((b) => b.state === 'running' && b.etaMs !== null)
        const eta = etas.length ? Math.max(...etas.map((b) => b.etaMs!)) : null
        const next: OcrPrompt = { kind: 'waiting', done: p.done, total: p.total, etaMs: eta }
        if (
          !prompt ||
          prompt.kind !== 'waiting' ||
          prompt.done !== next.done ||
          prompt.total !== next.total ||
          prompt.etaMs !== next.etaMs
        ) {
          prompt = next
          changed()
        }
      }
      promptAnswer = (a) => finish(a === 'cancel' ? 'cancel' : 'now')
      stateListeners.add(check)
      check()
    })
  }

  async function flushOrConfirm(docs: DocEntry[]): Promise<boolean> {
    // A second export while one is already asking or waiting is refused (its own Cancel).
    if (promptBusy) return false
    promptBusy = true
    try {
      const p = pendingFor(docs)
      if (p.pending > 0) {
        const a = await ask({ kind: 'running', done: p.done, total: p.total })
        if (a === 'cancel') return false
        if (a === 'wait') {
          const r = await waitForPending()
          if (r === 'cancel') return false
          if (r === 'stopped') {
            const views = batches
              .filter((b) => b.state === 'crashed' || b.state === 'stopped')
              .map(batchView)
            const done = views.reduce((n, b) => n + b.done, 0)
            const total = views.reduce((n, b) => n + b.total, 0)
            if ((await ask({ kind: 'stopped', done, total })) !== 'now') return false
          }
        }
      }
      const missing = missingReplacements(liveDocs.length ? liveDocs : docs)
      if (missing > 0 && (await ask({ kind: 'missing', pages: missing })) !== 'now') return false
      return true
    } finally {
      promptBusy = false
    }
  }

  function snapshotFor(
    docs: DocEntry[],
    editLayer: EditLayer
  ): Map<string, PackedOcrPage> | undefined {
    const pages = new Map<string, PageResults>()
    for (const d of docs)
      for (const p of d.pages) {
        const bytes = p.source?.bytes
        const so = bytes instanceof Uint8Array ? sources.get(bytes) : undefined
        const r = so?.pages.get(p.pageIndex)
        if (!r || r.results.size === 0) continue
        const key = makePageKey(p.source.id, p.pageIndex)
        // auto only for scanned / near-scanned pages (and pages triage could not read that came
        // from an imported image or were asked for by name: `autoCounts`, the rule Find uses):
        // an `ocr-ours` page keeps its own layer unless the user chose Replace or Remove.
        const auto = autoCounts(r, p.source.origin === 'image') ? r.auto : undefined
        pages.set(key, { results: r.results, auto })
      }
    return applyOcrSelections(pages, editLayer.ocrSelect)
  }

  const exportSource: OcrExportSource = {
    flushOrConfirm,
    snapshotFor,
    includeInExports: () => currentSettings['ocr.includeInExports']
  }

  // -------------------------------------------------------------------------------------------

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot,
    getPageState,
    reconcile,
    syncEdits(edits) {
      let sel = false
      if (edits.ocrSelect && edits.ocrSelect !== ocrSelect) {
        ocrSelect = edits.ocrSelect
        sel = true
      }
      // A rotation changes what "Sideways — rotate?" still offers (getPageState).
      const turned = !!edits.rotations && edits.rotations !== rotations
      if (edits.rotations) rotations = edits.rotations
      if (edits.selectOcr) selectOcr = edits.selectOcr
      if (sel) resultsChanged()
      else if (turned) changed()
    },
    setFocus(pageKey) {
      if (pageKey === focusKey) return
      focusKey = pageKey
      const info = pageKey ? keyInfo.get(pageKey) : undefined
      if (info && link === 'connected' && opened.get(info.src) === session)
        post({ focus: { src: info.src, index: info.index } })
    },
    recognize(pageKeys, o) {
      return startBatch('user', pageKeys, o?.langs ?? currentSettings['ocr.languages'], true)
    },
    replace(pageKeys, langs) {
      if (link === 'unavailable' || langs.length === 0) return null
      const config = ocrConfig(langs)
      // The choice first (undoable, §3.5.2): an export while the new text runs knows it is missing.
      for (const key of pageKeys) if (keyInfo.has(key)) selectOcr?.(key, config.hash)
      return startBatch('replace', pageKeys, config.langs, true)
    },
    remove(pageKeys) {
      for (const key of pageKeys) if (keyInfo.has(key)) selectOcr?.(key, null)
    },
    cancel(batchId) {
      for (const b of batches) if (!batchId || b.id === batchId) cancelBatch(b)
    },
    resume(batchId) {
      if (link === 'unavailable') return
      for (const b of batches) if (!batchId || b.id === batchId) resumeBatch(b)
    },
    prepare(pageKeys) {
      for (const key of pageKeys) {
        const info = keyInfo.get(key)
        if (info) openGate(info.src)
      }
    },
    scannedPageKeys() {
      const out: string[] = []
      for (const [key] of keyInfo) {
        const found = recOf(key)
        if (!found) continue
        const cls = found.r.triage?.pageClass ?? null
        if (!SCANS.has(cls)) continue
        const hash = chosenHash(key, found.r)
        if (hash === null || (hash && found.r.results.has(hash))) continue
        out.push(key)
      }
      return out
    },
    pageSupply,
    onResults(listener) {
      resultListeners.add(listener)
      return () => {
        resultListeners.delete(listener)
      }
    },
    settings: () => currentSettings,
    async setSettings(patch) {
      if (opts.setSettings) currentSettings = await opts.setSettings(patch)
      else currentSettings = { ...currentSettings, ...patch }
      changed()
    },
    exportSource,
    getPrompt: () => prompt,
    answerPrompt(answer) {
      promptAnswer?.(answer)
    },
    dispose() {
      disposed = true
      unsubscribePort?.()
      unsubscribeText()
      stage0Cancel?.()
      if (notifyTimer) clearTimeout(notifyTimer)
    }
  }
}
