// The OCR surfaces' shared model (ocr-ui.ts): summary rows and their copy, the collection summary,
// per-document runs, the pill's progress, the toasts' copy, the throttled announcements and the
// language picker's matching.

import { describe, expect, it } from 'vitest'
import type { DocEntry } from '../types'
import type { OcrBatchView, OcrPageState } from './ocr-store'
import {
  batchAttention,
  batchToast,
  createAnnouncer,
  INCLUDED_LANGS,
  isAttention,
  ISSUE_COPY,
  langLabel,
  langMatches,
  nextRuns,
  overallProgress,
  pageIssue,
  removedCopy,
  removeTargets,
  runProgress,
  summarizeOcr,
  unavailableDetails
} from './ocr-ui'

const state = (s: Partial<OcrPageState> = {}): OcrPageState => ({
  pageClass: 'scanned',
  status: 'none',
  hasText: false,
  meanConfCal: null,
  scan: true,
  removed: false,
  triaged: true,
  ...s
})

const batch = (b: Partial<OcrBatchView> = {}): OcrBatchView => ({
  id: 'b1',
  kind: 'user',
  state: 'done',
  langs: ['eng'],
  done: 12,
  total: 12,
  recognized: 12,
  skipped: 0,
  failed: 0,
  inflightFrac: 0,
  etaMs: null,
  keys: [],
  ...b
})

describe('pageIssue (summary rows)', () => {
  it.each([
    [{ skip: 'protected' as const }, 'protected', false],
    [{ status: 'skipped-protected' as const }, 'protected', false],
    [{ status: 'too-large' as const, reason: 'page-too-large' as const }, 'too-large', false],
    [{ status: 'failed' as const, reason: 'source-too-large' as const }, 'too-large', false],
    [{ status: 'failed' as const, reason: 'user-unit' as const }, 'user-unit', false],
    [{ status: 'failed' as const, reason: 'image-format' as const }, 'image-format', false],
    [{ status: 'needs-language' as const }, 'needs-language', false],
    [{ status: 'timeout' as const }, 'timeout', true],
    [{ status: 'failed' as const, reason: 'heap' as const }, 'oom', true],
    [{ status: 'failed' as const, reason: 'render' as const }, 'failed', true],
    [{ status: 'failed' as const, reason: 'recognize-crash' as const }, 'failed', false],
    [{ status: 'ok' as const, hasText: true, rotateBy: 90 as const }, 'sideways', false],
    [{ status: 'low-confidence' as const, hasText: true }, 'low-confidence', false],
    [{ status: 'no-text' as const, hasText: true }, 'no-text', false],
    [{ skip: 'ours' as const, pageClass: 'ocr-ours' as const }, 'ours', false],
    [{ skip: 'has-text' as const, pageClass: 'text' as const }, 'has-text', false],
    [{ status: 'skipped-has-text' as const }, 'has-text', false]
  ])('%j → %s', (s, kind, retry) => {
    const issue = pageIssue(state(s))
    expect(issue?.kind).toBe(kind)
    expect(issue?.text).toBe(ISSUE_COPY[kind as keyof typeof ISSUE_COPY])
    expect(issue?.retry).toBe(retry)
  })

  it('has the final copy', () => {
    expect(ISSUE_COPY['low-confidence']).toBe('Low confidence — check the language or scan quality')
    expect(ISSUE_COPY.sideways).toBe('Sideways — rotate the page?')
    expect(ISSUE_COPY.ours).toBe('Already recognized by PDFx')
    expect(ISSUE_COPY['has-text']).toBe('Skipped — already has searchable text')
    expect(ISSUE_COPY.timeout).toBe('Took too long and was skipped')
    expect(ISSUE_COPY.oom).toBe('Couldn’t recognize (out of memory)')
    expect(ISSUE_COPY.protected).toBe(
      'This PDF is protected; PDFx can’t add searchable text to it.'
    )
    expect(ISSUE_COPY['too-large']).toBe('This page is too large for text recognition.')
    expect(ISSUE_COPY['user-unit']).toBe('Unsupported page units')
    expect(ISSUE_COPY['image-format']).toBe(
      'This page’s image format isn’t supported for text recognition yet'
    )
  })

  it('says nothing for a page being worked on, a fine page, or a page never tried', () => {
    expect(pageIssue(state({ status: 'running', rotateBy: 90 }))).toBeNull()
    expect(pageIssue(state({ status: 'queued' }))).toBeNull()
    expect(pageIssue(state({ status: 'held' }))).toBeNull()
    expect(pageIssue(state({ status: 'ok', hasText: true }))).toBeNull()
    expect(pageIssue(state())).toBeNull()
  })

  it('treats "already recognized" and "already has text" as information, not attention', () => {
    expect(isAttention(pageIssue(state({ skip: 'ours' })))).toBe(false)
    expect(isAttention(pageIssue(state({ skip: 'has-text' })))).toBe(false)
    expect(isAttention(pageIssue(state({ status: 'timeout' })))).toBe(true)
    expect(isAttention(null)).toBe(false)
  })
})

describe('summarizeOcr', () => {
  const page = (src: string, i: number): DocEntry['pages'][number] =>
    ({ id: `${src}-${i}`, source: { id: src }, pageIndex: i, width: 1, height: 1 }) as never
  const docs: DocEntry[] = [
    { id: 'd1', name: 'one.pdf', pages: [page('a', 0), page('a', 1), page('a', 2), page('a', 3)] },
    { id: 'd2', name: 'two.pdf', pages: [page('b', 0), page('b', 1)] }
  ]
  const states: Record<string, OcrPageState> = {
    'a#0': state(), // unrecognised scan
    'a#1': state({ status: 'running' }),
    'a#2': state({ status: 'low-confidence', hasText: true }),
    'a#3': state({ pageClass: 'text', scan: false, triaged: false }),
    'b#0': state({ removed: true }), // Remove chose no text: not "unrecognised"
    'b#1': state({ status: 'held' })
  }
  const s = summarizeOcr(docs, { getPageState: (k) => states[k] ?? null })

  it('sorts pages into unrecognised / working / held, per document and overall', () => {
    expect(s.byDoc.get('d1')!.unrecognized).toEqual(['a#0'])
    expect(s.byDoc.get('d1')!.working).toEqual(['a#1'])
    expect(s.byDoc.get('d2')!.held).toEqual(['b#1'])
    expect(s.unrecognized).toEqual(['a#0'])
    expect(s.working).toEqual(['a#1'])
  })

  it('lists issue rows with their 1-based page numbers and counts attention', () => {
    expect(s.issues.map((p) => [p.key, p.number, p.issue!.kind])).toEqual([
      ['a#2', 3, 'low-confidence']
    ])
    expect(s.attention).toBe(1)
  })

  it('knows the pages with text (Sign checkbox) and the untriaged ones (dialog)', () => {
    expect(s.withText).toEqual(['a#2'])
    expect(s.replaceable).toEqual(['a#2'])
    expect(s.untriaged).toBe(1)
  })

  it('counts a page key once per document (duplicates share a key)', () => {
    const dup: DocEntry[] = [{ id: 'd', name: 'd', pages: [page('a', 0), page('a', 0)] }]
    expect(summarizeOcr(dup, { getPageState: () => state() }).unrecognized).toEqual(['a#0'])
  })
})

describe('per-document runs', () => {
  it('counts the pages of a run until none of its pages is worked on', () => {
    let runs = nextRuns(new Map(), new Map([['d', ['k1', 'k2', 'k3']]]))
    expect(runProgress(runs.get('d'), ['k1', 'k2', 'k3'])).toEqual({ done: 0, total: 3 })
    runs = nextRuns(runs, new Map([['d', ['k2', 'k3']]]))
    expect(runProgress(runs.get('d'), ['k2', 'k3'])).toEqual({ done: 1, total: 3 })
    // A page asked for mid-run joins it.
    runs = nextRuns(runs, new Map([['d', ['k3', 'k4']]]))
    expect(runProgress(runs.get('d'), ['k3', 'k4'])).toEqual({ done: 2, total: 4 })
    runs = nextRuns(runs, new Map([['d', []]]))
    expect(runs.has('d')).toBe(false)
  })
})

describe('overallProgress (the pill)', () => {
  it('sums the running batches, in-flight fractions included', () => {
    const p = overallProgress([
      batch({ state: 'running', done: 3, total: 10, inflightFrac: 0.7 }),
      batch({ state: 'done', done: 5, total: 5 })
    ])
    expect([p.done, p.total]).toEqual([3, 10])
    expect(p.fraction).toBeCloseTo(0.37, 10)
  })
  it('is 0 of 0 with nothing running', () => {
    expect(overallProgress([batch()])).toEqual({ done: 0, total: 0, fraction: 0 })
  })
})

describe('batchToast (final copy)', () => {
  it('done, every page recognised', () => {
    expect(batchToast(batch())).toEqual({
      message: 'Text recognized on 12 pages — now searchable'
    })
    expect(batchToast(batch({ total: 1, done: 1, recognized: 1 }))!.message).toBe(
      'Text recognized on 1 page — now searchable'
    )
  })
  it('done with pages that need attention', () => {
    expect(batchToast(batch({ recognized: 10, failed: 2 }))).toEqual({
      message: 'Text recognized on 10 of 12 pages · 2 need attention',
      action: 'details'
    })
  })
  it('done with skipped pages (skipped is never "recognized")', () => {
    expect(batchToast(batch({ total: 3, done: 3, recognized: 2, skipped: 1 }))!.message).toBe(
      'Text recognized on 2 of 3 pages · 1 skipped'
    )
  })
  it('stopped and crashed', () => {
    expect(batchToast(batch({ state: 'stopped', recognized: 7 }))!.message).toBe(
      'Stopped. 7 of 12 pages recognized.'
    )
    expect(batchToast(batch({ state: 'crashed', done: 7 }))).toEqual({
      message: 'Text recognition stopped unexpectedly; 7 of 12 pages done.',
      action: 'resume'
    })
  })
  it('nothing for an automatic request with nothing to do; a hint for a user one', () => {
    expect(batchToast(batch({ kind: 'auto', total: 0, done: 0, recognized: 0 }))).toBeNull()
    expect(batchToast(batch({ total: 0, done: 0, recognized: 0 }))!.message).toMatch(
      /Nothing to recognize/
    )
  })
  it('no toast while running or for a failed session (the "couldn’t start" toast says it)', () => {
    expect(batchToast(batch({ state: 'running' }))).toBeNull()
    expect(batchToast(batch({ state: 'failed' }))).toBeNull()
    expect(unavailableDetails('crash-loop')).toBe(
      'Error code: crash-loop · nothing was sent anywhere'
    )
  })
})

describe('createAnnouncer (a11y: every 10% or 5 pages, plus a final announcement)', () => {
  it('announces the start, then at most every 10% / 5 pages, then the end', () => {
    const a = createAnnouncer()
    const out: Array<string | null> = []
    out.push(a.next({ running: true, done: 0, total: 100 }))
    for (let d = 1; d <= 12; d++) out.push(a.next({ running: true, done: d, total: 100 }))
    out.push(a.next({ running: false, done: 100, total: 100, final: 'Done!' }))
    expect(out.filter(Boolean)).toEqual([
      'Recognizing text on 100 pages',
      'Recognizing text: 5 of 100 pages done',
      'Recognizing text: 10 of 100 pages done',
      'Done!'
    ])
  })

  it('announces each 10% step of a short run', () => {
    const a = createAnnouncer()
    a.next({ running: true, done: 0, total: 4 })
    expect(a.next({ running: true, done: 1, total: 4 })).toBe('Recognizing text: 1 of 4 pages done')
    expect(a.next({ running: true, done: 1, total: 4 })).toBeNull()
  })

  it('says nothing while idle without a final message', () => {
    expect(createAnnouncer().next({ running: false, done: 0, total: 0 })).toBeNull()
  })

  it('without a final message the end clears the region (the toast says how it ended)', () => {
    const a = createAnnouncer()
    a.next({ running: true, done: 0, total: 3 })
    expect(a.next({ running: false, done: 3, total: 3 })).toBe('')
    expect(a.next({ running: false, done: 3, total: 3 })).toBeNull()
  })
})

describe('batchAttention: the toast counts attention like the chip', () => {
  const page = (src: string, i: number): DocEntry['pages'][number] =>
    ({ id: `${src}-${i}`, source: { id: src }, pageIndex: i, width: 1, height: 1 }) as never
  const docs: DocEntry[] = [{ id: 'd', name: 'd', pages: [0, 1, 2].map((i) => page('a', i)) }]
  const states: Record<string, OcrPageState> = {
    'a#0': state({ status: 'ok', hasText: true }),
    'a#1': state({ status: 'ok', hasText: true, rotateBy: 90 }), // recognised, but sideways
    'a#2': state({ status: 'ok', hasText: true })
  }
  const summary = summarizeOcr(docs, { getPageState: (k) => states[k] ?? null })

  it('a sideways page that was recognised still needs attention: no "now searchable"', () => {
    const b = batch({ total: 3, done: 3, recognized: 3, keys: ['a#0', 'a#1', 'a#2'] })
    expect(batchAttention(b, summary)).toBe(summary.attention)
    expect(batchAttention(b, summary)).toBe(1)
    expect(batchToast(b, batchAttention(b, summary))).toEqual({
      message: 'Text recognized on 3 pages · 1 needs attention',
      action: 'details'
    })
  })

  it('counts only the batch’s own pages, once each', () => {
    expect(batchAttention(batch({ keys: ['a#0', 'a#2'] }), summary)).toBe(0)
    expect(batchAttention(batch({ keys: ['a#1', 'a#1'] }), summary)).toBe(1)
    expect(batchToast(batch({ recognized: 10, failed: 2 }), 3)!.message).toBe(
      'Text recognized on 10 of 12 pages · 3 need attention'
    )
  })
})

describe('removeTargets (Document ▸ Remove Recognized Text)', () => {
  const s = { replaceable: ['a#0', 'a#2', 'b#1'] }

  it('the page in view (or selected) only, when it has recognised text', () => {
    expect(removeTargets(s, 'a#2').keys).toEqual(['a#2'])
  })
  it('a page in view without recognised text: nothing, and says so', () => {
    expect(removeTargets(s, 'a#1')).toEqual({ keys: [], none: 'This page has no recognized text' })
  })
  it('no page in view: every page with recognised text', () => {
    expect(removeTargets(s, null).keys).toEqual(['a#0', 'a#2', 'b#1'])
    expect(removeTargets({ replaceable: [] }, null)).toEqual({
      keys: [],
      none: 'No recognized text to remove'
    })
    expect(removedCopy(3)).toBe('Recognized text removed from 3 pages · Undo brings it back')
  })
})

describe('languages', () => {
  it('shows the four bundled languages by native name (D1)', () => {
    expect(INCLUDED_LANGS.map((l) => l.label)).toEqual([
      'English',
      'Deutsch — German',
      'Français — French',
      'Español — Spanish'
    ])
    expect(langLabel('xyz')).toBe('xyz')
  })
  it('matches native or English names and codes, ignoring case and accents', () => {
    const fra = INCLUDED_LANGS.find((l) => l.code === 'fra')!
    expect(langMatches(fra, 'franc')).toBe(true)
    expect(langMatches(fra, 'FRENCH')).toBe(true)
    expect(langMatches(fra, 'fra')).toBe(true)
    expect(langMatches(fra, 'german')).toBe(false)
    expect(langMatches(fra, '  ')).toBe(true)
  })
})
