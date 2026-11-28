// The OCR surfaces' shared model (DESIGN.md §3.8): what each page, document and the collection show,
// derived from the OCR store, plus the copy every surface uses. Pure functions over the store's
// public reads, so the badge, the chip, the banner, the Find row, the toolbar, the dialog and the
// summary popover can never disagree about which pages are "scanned and not recognised yet" or
// which ones "need attention".

import { OCR_LIMITS } from '../../../shared/ocr/protocol'
import { BUNDLED_LANGUAGES } from '../../../shared/settings'
import { makePageKey } from '../edit/model'
import type { DocEntry } from '../types'
import type { OcrBatchView, OcrPageState, OcrSnapshot, OcrStore } from './ocr-store'

export const MAX_LANGS = OCR_LIMITS.maxLangs

// ---------------------------------------------------------------------------------------------
// Pages.

/** Why a page is listed in the summary popover (one row per page, §3.8 "Summary popover"). */
export type OcrIssueKind =
  | 'protected'
  | 'too-large'
  | 'user-unit'
  | 'image-format'
  | 'needs-language'
  | 'timeout'
  | 'oom'
  | 'failed'
  | 'sideways'
  | 'low-confidence'
  | 'no-text'
  | 'ours'
  | 'has-text'

export interface OcrIssue {
  kind: OcrIssueKind
  /** The row's text (final copy). */
  text: string
  /** The page can be asked for again ([Try again]). */
  retry: boolean
}

/** The row copy (DESIGN.md §3.8 "Summary popover" and "Summary rows (new)"). */
export const ISSUE_COPY: Record<OcrIssueKind, string> = {
  protected: 'This PDF is protected; PDFx can’t add searchable text to it.',
  'too-large': 'This page is too large for text recognition.',
  'user-unit': 'Unsupported page units',
  'image-format': 'This page’s image format isn’t supported for text recognition yet',
  // The missing language is not reported per page yet; the Download action is PR9's.
  'needs-language': 'Needs language data that isn’t installed',
  timeout: 'Took too long and was skipped',
  oom: 'Couldn’t recognize (out of memory)',
  failed: 'Couldn’t recognize this page',
  sideways: 'Sideways — rotate the page?',
  'low-confidence': 'Low confidence — check the language or scan quality',
  'no-text': 'No text found',
  ours: 'Already recognized by PDFx',
  'has-text': 'Skipped — already has searchable text'
}

/** Rows that are only information: they never make the chip say "need attention". */
const INFORMATIONAL: ReadonlySet<OcrIssueKind> = new Set(['ours', 'has-text'])

export const isAttention = (i: OcrIssue | null): boolean => !!i && !INFORMATIONAL.has(i.kind)

const WORKING: ReadonlySet<OcrPageState['status']> = new Set(['queued', 'running'])

/** The page's summary row, or null (also null while it is being worked on). */
export function pageIssue(s: OcrPageState): OcrIssue | null {
  if (WORKING.has(s.status) || s.status === 'held') return null
  const issue = (kind: OcrIssueKind, retry = false): OcrIssue => ({
    kind,
    text: ISSUE_COPY[kind],
    retry
  })
  if (s.skip === 'protected' || s.status === 'skipped-protected') return issue('protected')
  if (s.status === 'too-large' || s.reason === 'page-too-large' || s.reason === 'source-too-large')
    return issue('too-large')
  if (s.reason === 'user-unit') return issue('user-unit')
  if (s.reason === 'image-format') return issue('image-format')
  if (s.status === 'needs-language') return issue('needs-language')
  if (s.status === 'timeout' || s.reason === 'watchdog') return issue('timeout', true)
  if (s.status === 'failed') {
    if (s.reason === 'heap') return issue('oom', true)
    // A page that took the process (or a raster thread) down twice is never retried (§3.3.2).
    const crashed = s.reason === 'recognize-crash' || s.reason === 'raster-crash'
    return issue('failed', !crashed)
  }
  if (s.rotateBy) return issue('sideways')
  if (s.status === 'low-confidence') return issue('low-confidence')
  if (s.status === 'no-text') return issue('no-text')
  if (s.skip === 'ours') return issue('ours')
  if (s.skip === 'has-text' || s.status === 'skipped-has-text') return issue('has-text')
  return null
}

export interface OcrPageView {
  key: string
  docId: string
  pageId: string
  /** 1-based position in its document. */
  number: number
  state: OcrPageState
  /** A scanned / near-scanned page (or an imported image triage has not classed yet). */
  scan: boolean
  /** Remove Recognized Text chose no text for it. */
  removed: boolean
  issue: OcrIssue | null
}

export interface DocOcr {
  docId: string
  name: string
  pages: OcrPageView[]
  /** Scanned pages never recognised (nor being recognised): the badge, chip, banner and button. */
  unrecognized: string[]
  /** Pages queued or running. */
  working: string[]
  /** Pages a crash holds for Resume. */
  held: string[]
  /** Pages with a summary row. */
  issues: OcrPageView[]
  /** Pages with a row that needs attention (the chip's "N pages need attention"). */
  attention: number
  /** Pages with recognised text (Replace / Remove targets, the Sign checkbox). */
  withText: string[]
  /** Pages Replace can re-recognise: recognised text, or a reopened PDFx export's own layer. */
  replaceable: string[]
}

export interface CollectionOcr {
  docs: DocOcr[]
  byDoc: ReadonlyMap<string, DocOcr>
  byKey: ReadonlyMap<string, OcrPageView>
  unrecognized: string[]
  working: string[]
  held: string[]
  issues: OcrPageView[]
  attention: number
  withText: string[]
  replaceable: string[]
  /** Live pages triage has not answered for yet (the dialog says "Checking pages…"). */
  untriaged: number
}

/** The OCR view of the collection, from the store's per-page reads. */
export function summarizeOcr(
  docs: readonly DocEntry[],
  store: Pick<OcrStore, 'getPageState'>
): CollectionOcr {
  const out: DocOcr[] = []
  const byKey = new Map<string, OcrPageView>()
  let untriaged = 0
  for (const d of docs) {
    const doc: DocOcr = {
      docId: d.id,
      name: d.name,
      pages: [],
      unrecognized: [],
      working: [],
      held: [],
      issues: [],
      attention: 0,
      withText: [],
      replaceable: []
    }
    const seen = new Set<string>()
    d.pages.forEach((p, i) => {
      const key = makePageKey(p.source.id, p.pageIndex)
      if (seen.has(key)) return
      seen.add(key)
      const state = store.getPageState(key)
      if (!state) return
      if (!state.triaged) untriaged++
      const view: OcrPageView = {
        key,
        docId: d.id,
        pageId: p.id,
        number: i + 1,
        state,
        scan: state.scan,
        removed: state.removed,
        issue: pageIssue(state)
      }
      doc.pages.push(view)
      if (!byKey.has(key)) byKey.set(key, view)
      if (WORKING.has(state.status)) doc.working.push(key)
      else if (state.status === 'held') doc.held.push(key)
      else if (view.scan && !state.hasText && !view.removed && state.status === 'none')
        doc.unrecognized.push(key)
      if (view.issue) {
        doc.issues.push(view)
        if (isAttention(view.issue)) doc.attention++
      }
      if (state.hasText) doc.withText.push(key)
      if (state.hasText || state.pageClass === 'ocr-ours') doc.replaceable.push(key)
    })
    out.push(doc)
  }
  const flat = <K extends 'unrecognized' | 'working' | 'held' | 'withText' | 'replaceable'>(
    k: K
  ): string[] => [...new Set(out.flatMap((d) => d[k]))]
  return {
    docs: out,
    byDoc: new Map(out.map((d) => [d.docId, d])),
    byKey,
    unrecognized: flat('unrecognized'),
    working: flat('working'),
    held: flat('held'),
    issues: out.flatMap((d) => d.issues),
    attention: out.reduce((n, d) => n + d.attention, 0),
    withText: flat('withText'),
    replaceable: flat('replaceable'),
    untriaged
  }
}

// ---------------------------------------------------------------------------------------------
// Per-document progress ("Recognizing 4 / 12").

/**
 * The pages of each document in its current run: a page joins when it starts being worked on and
 * the run ends (forgotten) when none of the document's pages is worked on any more. done = the
 * run's pages no longer worked on. Pure: returns the next map.
 */
export function nextRuns(
  prev: ReadonlyMap<string, ReadonlySet<string>>,
  working: ReadonlyMap<string, readonly string[]>
): Map<string, Set<string>> {
  const next = new Map<string, Set<string>>()
  for (const [docId, keys] of working) {
    if (keys.length === 0) continue
    const run = new Set(prev.get(docId) ?? [])
    for (const k of keys) run.add(k)
    next.set(docId, run)
  }
  return next
}

export function runProgress(
  run: ReadonlySet<string> | undefined,
  working: readonly string[]
): { done: number; total: number } {
  const total = run?.size ?? working.length
  return { done: Math.max(0, total - working.length), total }
}

/** Running batches' progress as one fraction (the pill's "Recognizing text · 37%"). */
export function overallProgress(batches: readonly OcrBatchView[]): {
  done: number
  total: number
  fraction: number
} {
  let done = 0
  let total = 0
  let frac = 0
  for (const b of batches) {
    if (b.state !== 'running') continue
    done += b.done
    total += b.total
    frac += b.done + b.inflightFrac
  }
  return { done, total, fraction: total > 0 ? Math.min(1, frac / total) : 0 }
}

// ---------------------------------------------------------------------------------------------
// Copy.

export const pagesWord = (n: number): string => `${n} page${n === 1 ? '' : 's'}`

/**
 * The toast for a batch that just ended (§3.8 "Toasts"), or null when there is nothing to say.
 * `action` names the toast's button: Resume (a crash), Details (the summary).
 */
export function batchToast(
  b: OcrBatchView
): { message: string; action?: 'resume' | 'details' } | null {
  const total = b.total
  if (b.state === 'stopped') {
    if (total === 0) return null
    return { message: `Stopped. ${b.recognized} of ${total} pages recognized.` }
  }
  if (b.state === 'crashed')
    return {
      message: `Text recognition stopped unexpectedly; ${b.done} of ${total} pages done.`,
      action: 'resume'
    }
  if (b.state === 'failed') return null // the session-wide "couldn't start" toast says it
  if (b.state !== 'done') return null
  if (total === 0)
    return b.kind === 'auto' ? null : { message: 'Nothing to recognize — no scanned pages left' }
  if (b.recognized === total)
    return { message: `Text recognized on ${pagesWord(total)} — now searchable` }
  if (b.failed > 0)
    return {
      message: `Text recognized on ${b.recognized} of ${total} pages · ${b.failed} need${b.failed === 1 ? 's' : ''} attention`,
      action: 'details'
    }
  return {
    message: `Text recognized on ${b.recognized} of ${total} pages · ${b.skipped} skipped`,
    action: 'details'
  }
}

/** The session-wide failure toast (§3.8 "Errors": "Text recognition couldn't start. [Details]"). */
export const UNAVAILABLE_COPY = 'Text recognition couldn’t start.'

/** What [Details] says: the error code, and that nothing was sent anywhere. */
export function unavailableDetails(reason: OcrSnapshot['unavailable']): string {
  return `Error code: ${reason ?? 'unknown'} · nothing was sent anywhere`
}

// ---------------------------------------------------------------------------------------------
// Screen-reader announcements (§3.8 "Accessibility").

export interface Announcer {
  /** Feed the current progress; returns the text to announce now, or null. */
  next(p: { running: boolean; done: number; total: number; final?: string | null }): string | null
}

/**
 * Throttled progress announcements: once when a run starts, then every 10% or every 5 pages
 * (whichever comes first), and a final announcement when it ends.
 */
export function createAnnouncer(): Announcer {
  let active = false
  let lastDone = 0
  let lastBucket = 0
  return {
    next({ running, done, total, final }) {
      if (!running) {
        if (!active) return final ?? null
        active = false
        return final ?? 'Text recognition finished'
      }
      if (!active) {
        active = true
        lastDone = done
        lastBucket = total > 0 ? Math.floor((done / total) * 10) : 0
        return `Recognizing text on ${pagesWord(total)}`
      }
      const bucket = total > 0 ? Math.floor((done / total) * 10) : 0
      if (done - lastDone >= 5 || bucket > lastBucket) {
        lastDone = done
        lastBucket = bucket
        return `Recognizing text: ${done} of ${total} pages done`
      }
      return null
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Languages (§3.8 "Language picker").

export interface LangInfo {
  code: string
  /** "Deutsch — German"; English alone for English. */
  label: string
}

const NATIVE: Record<string, [native: string, english: string]> = {
  eng: ['English', 'English'],
  deu: ['Deutsch', 'German'],
  fra: ['Français', 'French'],
  spa: ['Español', 'Spanish']
}

export function langLabel(code: string): string {
  const n = NATIVE[code]
  if (!n) return code
  return n[0] === n[1] ? n[0] : `${n[0]} — ${n[1]}`
}

/** The Included group: the languages bundled with the app (D1). */
export const INCLUDED_LANGS: readonly LangInfo[] = BUNDLED_LANGUAGES.map((code) => ({
  code,
  label: langLabel(code)
}))

/** Case- and accent-insensitive match of a picker query against a language. */
export function langMatches(l: LangInfo, query: string): boolean {
  const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  const q = fold(query.trim())
  return !q || fold(l.label).includes(q) || l.code.includes(q)
}
