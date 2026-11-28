// The OCR surfaces' shared model (DESIGN.md §3.8): what each page, document and the collection show,
// derived from the OCR store, plus the copy every surface uses. Pure functions over the store's
// public reads, so the badge, the chip, the banner, the Find row, the toolbar, the dialog and the
// summary popover can never disagree about which pages are "scanned and not recognised yet" or
// which ones "need attention".

import {
  CJK_SCRIPTS,
  langFileName,
  type LangDownloadError,
  type LangInstallResult,
  type LangPackInfo
} from '../../../shared/ocr/lang-packs'
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
  // The generic row; the summary names the missing languages and offers [Download] (PR9).
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
 * How many of a batch's pages need attention, by the chip's own rule (`pageIssue` / `isAttention`
 * over the summary), so the toast and the chip never disagree: a Sideways or Low-confidence page
 * counts though it was recognised.
 */
export function batchAttention(b: OcrBatchView, summary: Pick<CollectionOcr, 'byKey'>): number {
  let n = 0
  for (const k of new Set(b.keys)) if (isAttention(summary.byKey.get(k)?.issue ?? null)) n++
  return n
}

/**
 * The toast for a batch that just ended (§3.8 "Toasts"), or null when there is nothing to say.
 * `action` names the toast's button: Resume (a crash), Details (the summary). `attention` is the
 * batch's pages that need attention (`batchAttention`); without it, its failures.
 */
export function batchToast(
  b: OcrBatchView,
  attention: number = b.failed
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
  const needs = (n: number): string => `${n} need${n === 1 ? 's' : ''} attention`
  if (attention > 0)
    return {
      message:
        b.recognized === total
          ? `Text recognized on ${pagesWord(total)} · ${needs(attention)}`
          : `Text recognized on ${b.recognized} of ${total} pages · ${needs(attention)}`,
      action: 'details'
    }
  if (b.recognized === total)
    return { message: `Text recognized on ${pagesWord(total)} — now searchable` }
  return {
    message: `Text recognized on ${b.recognized} of ${total} pages · ${b.skipped} skipped`,
    action: 'details'
  }
}

/**
 * Document ▸ Remove Recognized Text: the page in view (or the selected one) when there is one,
 * else every page with recognised text. `none` is what to say when there is nothing to remove.
 */
export function removeTargets(
  summary: Pick<CollectionOcr, 'replaceable'>,
  focusKey: string | null
): { keys: string[]; none: string } {
  if (focusKey)
    return {
      keys: summary.replaceable.includes(focusKey) ? [focusKey] : [],
      none: 'This page has no recognized text'
    }
  return { keys: [...summary.replaceable], none: 'No recognized text to remove' }
}

/** The toast after Remove Recognized Text: one Undo step brings every page of it back. */
export const removedCopy = (n: number): string =>
  `Recognized text removed from ${pagesWord(n)} · Undo brings it back`

/** The session-wide failure toast (§3.8 "Errors": "Text recognition couldn't start. [Details]"). */
export const UNAVAILABLE_COPY = 'Text recognition couldn’t start.'

/** What [Details] says: the error code, and that nothing was sent anywhere. */
export function unavailableDetails(reason: OcrSnapshot['unavailable']): string {
  return `Error code: ${reason ?? 'unknown'} · nothing was sent anywhere`
}

// ---------------------------------------------------------------------------------------------
// Screen-reader announcements (§3.8 "Accessibility").

export interface Announcer {
  /**
   * Feed the current progress; returns the text to announce now ('' clears the region), or null
   * for no change.
   */
  next(p: { running: boolean; done: number; total: number; final?: string | null }): string | null
}

/**
 * Throttled progress announcements: once when a run starts, then every 10% or every 5 pages
 * (whichever comes first), and `final` when it ends. Without a `final` the end clears the region
 * (''): the app's toast region speaks how the run ended, and the same sentence twice is noise.
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
        return final ?? ''
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

/** Catalogue names main reported (lang-packs.ts registers them when the list arrives). */
const CATALOGUE_NAMES = new Map<string, [native: string, english: string]>()

/** Remember the catalogue's names, so chips and summary rows can name a downloaded language. */
export function registerLangNames(
  list: ReadonlyArray<Pick<LangPackInfo, 'code' | 'nativeName' | 'name'>>
): void {
  for (const l of list) CATALOGUE_NAMES.set(l.code, [l.nativeName, l.name])
}

const names = (code: string): [string, string] | undefined =>
  Object.hasOwn(NATIVE, code) ? NATIVE[code] : CATALOGUE_NAMES.get(code)

export function langLabel(code: string): string {
  const n = names(code)
  if (!n) return code
  return n[0] === n[1] ? n[0] : `${n[0]} — ${n[1]}`
}

/** The English name ("Russian"), for sentences; the code when PDFx does not know it. */
export function langName(code: string): string {
  return names(code)?.[1] ?? code
}

/** Tesseract's CJK ceiling, said plainly (§3.2.5 "Quality labels"). */
export const CJK_NOTE = '(printed text; photos may be less accurate)'

/** "2.7 MB" (decimal megabytes, one decimal, as the design writes sizes). */
export function formatSize(bytes: number): string {
  const mb = bytes / 1_000_000
  return `${mb < 0.1 ? mb.toFixed(2) : mb.toFixed(1)} MB`
}

/** A catalogue language as the picker lists it. */
export interface LangOption extends LangInfo {
  /** CJK: carries CJK_NOTE. */
  cjk: boolean
  /** Download group: "2.7 MB from cdn.jsdelivr.net". */
  detail?: string
}

/** "Downloading… 10%" (a picker row while that language downloads). */
export function downloadingCopy(progress: { received: number; total: number }): string {
  const pct = progress.total > 0 ? Math.floor((100 * progress.received) / progress.total) : 0
  return `Downloading… ${pct}%`
}

export function langOption(
  p: LangPackInfo,
  progress?: { received: number; total: number }
): LangOption {
  const label = p.nativeName === p.name ? p.name : `${p.nativeName} — ${p.name}`
  const detail =
    p.state === 'installed'
      ? undefined
      : progress
        ? downloadingCopy(progress)
        : `${formatSize(p.bytes)} from ${p.host}`
  return { code: p.code, label, cjk: CJK_SCRIPTS.has(p.script), ...(detail ? { detail } : {}) }
}

/** The CJK quality note as a sentence, for the consent (§3.2.5 "Quality labels"). */
export const CJK_CONSENT_NOTE = 'Works best on printed text; photos may be less accurate.'

/** The consent asked before any request (§3.2.5 "Consent wording"). */
export function consentCopy(
  p: Pick<LangPackInfo, 'name' | 'bytes' | 'host'> & { script?: LangPackInfo['script'] }
): string {
  const base = `Download ${p.name} language data (${formatSize(p.bytes)}) from ${p.host}? It’s stored on this computer and used offline after that.`
  return p.script && CJK_SCRIPTS.has(p.script) ? `${base} ${CJK_CONSENT_NOTE}` : base
}

/**
 * The way round a download this computer can't make (offline, a proxy sign-in): which file, from
 * where, and what to do with it. The address is the catalogue's (main's compiled list).
 */
export function manualCopy(p: Pick<LangPackInfo, 'code'>): string {
  return `Or get ${langFileName(p.code)} on another computer from the address below, then use Install from file…`
}

/** §3.2.5 "Offline wording" / §3.8 "Errors". */
export function offlineCopy(name: string): string {
  return `Connect to the internet once to add ${name}, or choose a language that’s already installed.`
}

/** Install from file… refused a file (§3.2.5). */
export const INSTALL_REFUSED =
  'This file isn’t one of the language files PDFx knows. PDFx 1.1.4 only installs its own language files.'

/** Install from file… refused a file, with nothing more specific to point at (the picker footer). */
export const INSTALL_REFUSED_HINT =
  'Each language has its own <code>.traineddata.gz file; when a download can’t finish, PDFx names the file and where to get it.'

/** Download errors that get the manual route (the file, its address, Install from file…). */
export const MANUAL_ROUTE_ERRORS: ReadonlySet<LangDownloadError> = new Set([
  'offline',
  'proxy-auth',
  'timeout',
  'http'
])

/** What a download that did not finish says (never a path, never a server message). */
export function downloadErrorCopy(
  error: LangDownloadError,
  p: Pick<LangPackInfo, 'code' | 'name'>
): string {
  const name = p.name
  switch (error) {
    case 'offline':
      return offlineCopy(name)
    case 'timeout':
      return `The download of ${name} language data stopped responding. Try again, or choose a language that’s already installed.`
    case 'proxy-auth':
      return `Your network’s proxy asks for a sign-in PDFx can’t give. Get ${langFileName(p.code)} on another computer from the address below, then use Install from file…`
    case 'http':
      return `The server couldn’t provide ${name} language data right now. Try again later.`
    case 'verify':
      return `The downloaded ${name} language data didn’t match what PDFx expects, so it was deleted. Try again.`
    case 'disk':
      return `PDFx couldn’t save ${name} language data on this computer (is the disk full?).`
    case 'unknown-language':
      return `PDFx doesn’t offer ${name} language data.`
    case 'cancelled':
      return 'Download stopped.'
  }
}

/**
 * What Install from file… says when it did not install (null: nothing to say). `forLang`: the
 * language the user is getting (a download prompt), so a refusal names the file it needs.
 */
export function installErrorCopy(
  r: LangInstallResult,
  forLang?: Pick<LangPackInfo, 'code' | 'name'>
): string | null {
  if (r.ok || r.error === 'cancelled') return null
  if (r.error === 'unreadable') return 'PDFx couldn’t read that file.'
  if (r.error === 'disk') return 'PDFx couldn’t save the language data on this computer.'
  const refused =
    r.error === 'too-large' ? `${INSTALL_REFUSED} (It is 100 MB or larger.)` : INSTALL_REFUSED
  const hint = forLang
    ? `${forLang.name} needs ${langFileName(forLang.code)}, from the address above.`
    : INSTALL_REFUSED_HINT
  return `${refused} ${hint}`
}

/** The summary row for a page needing languages that aren't installed (§3.8 "Summary popover"). */
export function needsLanguageCopy(missing: readonly string[]): string {
  if (missing.length === 0) return ISSUE_COPY['needs-language']
  const list = missing.map(langName)
  const named = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`
  return `Needs ${named} language data`
}

/** The dialog's warning for chosen languages that are neither bundled nor installed. */
export function notInstalledCopy(missing: readonly string[]): string {
  const list = missing.map(langName)
  const named = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`
  const which = list.length === 1 ? 'the language' : 'those languages'
  return `${named} language data isn’t installed yet. Download it, or remove ${which}, before recognizing.`
}

/** The page's languages that are neither bundled nor installed. */
export function missingLangs(
  langs: readonly string[] | undefined,
  installed: ReadonlySet<string>
): string[] {
  return (langs ?? []).filter(
    (l) => !(BUNDLED_LANGUAGES as readonly string[]).includes(l) && !installed.has(l)
  )
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
