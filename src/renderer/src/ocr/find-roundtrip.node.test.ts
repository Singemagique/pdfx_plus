// Find over recognised text, end to end through the real engine (DESIGN.md §3.6.1, §3.9.3 tier 0):
// - recall and hit-on-target on PR1 synth pages, before export (setSupplement on the scanned page)
//   and after it (the PR2 layer baked, the file reopened, pdf.js extracting the layer);
// - a CJK round trip: pre-export Find == post-export Find on a hand-made CJK page;
// - a reopened OCR'd ("ocr-ours") page, whose OCR words are NATIVE pdf.js text by then, redacted in
//   the app: Find and Copy Page Text no longer return the word; undo brings it back;
// - Replace on a reopened page: the hit count does not double.

import { PDFDocument } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildPageText, extractPageText } from '../search/extract'

import { copyFidelity, iou, type FindGtWord } from '../../../shared/ocr/test-utils/metrics'
import { loadNodeSynthDeps } from '../../../shared/ocr/test-utils/node-deps'
import { synthesize, type SynthResult } from '../../../shared/ocr/test-utils/synth'
import type { OcrPage } from '../../../shared/ocr/types'
import { bakeLayer, flowWords, handPage, ocrPageFromGt } from '../pdfx/test-utils/ocr-layer'
import { createFindHarness, toPageRect, type FindHarness } from './test-utils/find-harness'

const PRESETS = ['clean300', 'skew2', 'rot90page', 'latin-diacritics']
/** §3.9.4: hit-on-target among hits (IoU > 0.5). */
const HIT_ON_TARGET = 0.95
/**
 * Post-export on-target recall through the app's real extraction today (seed 7) [measured:
 * clean300 0.846, skew2 0.962, rot90page 0.846, latin-diacritics 1.000; twocol 0.941 and
 * numbers-table 1.000 off this list]. See the "after export" test.
 */
const KNOWN_MONO_FLOOR: Record<string, number> = {
  clean300: 0.84,
  skew2: 0.96,
  rot90page: 0.84,
  'latin-diacritics': 1
}

const synthCache = new Map<string, Promise<SynthResult>>()
function synth(preset: string): Promise<SynthResult> {
  let p = synthCache.get(preset)
  if (!p) {
    p = loadNodeSynthDeps().then((deps) => synthesize({ preset, seed: 7 }, deps))
    synthCache.set(preset, p)
  }
  return p
}

const gtWords = (s: SynthResult): FindGtWord[] =>
  s.gt.words.map((w) => ({ t: w.t, box: w.box, page: 0 }))
const gtLines = (s: SynthResult): string[][] =>
  s.gt.lines.map((l) => l.words.map((wi) => s.gt.words[wi].t))

const harnesses: FindHarness[] = []
async function harness(...args: Parameters<typeof createFindHarness>): Promise<FindHarness> {
  const h = await createFindHarness(...args)
  harnesses.push(h)
  return h
}
afterAll(async () => {
  for (const h of harnesses) await h.destroy()
})

async function blankPdf(width = 612, height = 792): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([width, height])
  return doc.save()
}

describe.each(PRESETS)('Find recall on synth %s (real engine)', (preset) => {
  let s: SynthResult
  let ocr: OcrPage
  beforeAll(async () => {
    s = await synth(preset)
    ocr = ocrPageFromGt(s.gt)
  })

  it('before export: the supplement on the scanned page finds every word on target', async () => {
    const h = await harness([{ native: s.pdfBytes, height: s.gt.page.height, ocr }])
    const sc = await h.scores(gtWords(s))
    expect(sc.eligible).toBeGreaterThan(20)
    expect(sc.words.filter((w) => !w.found).map((w) => w.query)).toEqual([])
    expect(sc.recall).toBe(1)
    expect(sc.hitOnTarget).toBeGreaterThanOrEqual(HIT_ON_TARGET)
    // Copy Page Text from the same items: the GT exactly (single spaces, one "\n" per line).
    const copy = copyFidelity(gtLines(s), h.copyText(0))
    expect(copy.joins).toBe(0)
    expect(copy.breaksWithinLine).toBe(0)
    expect(copy.blankLineRuns).toBe(0)
    expect(copy.cer.rate).toBe(0)
  })

  it('after export: the baked layer, reopened, finds every word', async () => {
    const baked = await bakeLayer(s.pdfBytes, [ocr])
    const h = await harness([{ native: baked.bytes, height: s.gt.page.height }])
    const sc = await h.scores(gtWords(s))
    // Every word's text is found on its page...
    expect(sc.words.filter((w) => !w.anyHitOnPage).map((w) => w.query)).toEqual([])
    // ...but not every highlight lands on its word yet: pdf.js flags the layer's glyphless font
    // FixedPitch (every /W width is 500, pdf.js's `extractWidths` heuristic), so extract.ts marks
    // its items `mono` and search/geometry.ts splits a whole merged line evenly per character,
    // although each word was stretched with its own Tz. Open item (ocr-font.ts or extract.ts);
    // these floors pin today's numbers [measured, seed 7] so a regression still shows.
    expect(sc.recall).toBeGreaterThanOrEqual(KNOWN_MONO_FLOOR[preset])
    const copy = copyFidelity(gtLines(s), h.copyText(0))
    expect(copy.joins).toBe(0)
    expect(copy.blankLineRuns).toBe(0)
    expect(copy.cer.rate).toBe(0)
  })

  it('after export, with the even split for "monospace" items off: every word on target', async () => {
    // The fix target of the open item above: the same reopened page with its items' `mono`
    // cleared (the Helvetica-weighted estimate) passes the release gates exactly.
    const baked = await bakeLayer(s.pdfBytes, [ocr])
    const pdf = await getDocument({ data: baked.bytes.slice(), verbosity: 0 }).promise
    const pt = await extractPageText(pdf as never, 0)
    await pdf.destroy()
    expect(pt.items.some((i) => i.mono)).toBe(true)
    const weighted = buildPageText(
      pt.items.map((i) => ({ ...i, mono: false, hasEOL: !!i.hasEOL })),
      pt.vt
    )
    const h = await harness([{ native: weighted, height: s.gt.page.height }])
    const sc = await h.scores(gtWords(s))
    expect(sc.words.filter((w) => !w.found).map((w) => w.query)).toEqual([])
    expect(sc.recall).toBe(1)
    expect(sc.hitOnTarget).toBeGreaterThanOrEqual(HIT_ON_TARGET)
  })
})

describe('reopened OCR page (ocr-ours): native text that is OCR text', () => {
  let s: SynthResult
  let baked: Uint8Array
  beforeAll(async () => {
    s = await synth('clean300')
    baked = (await bakeLayer(s.pdfBytes, [ocrPageFromGt(s.gt)])).bytes
  })

  /** A word in the middle of a long line, whose text occurs nowhere else on the page. */
  function target(): { index: number; line: number[] } {
    const count = new Map<string, number>()
    const key = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    for (const w of s.gt.words) count.set(key(w.t), (count.get(key(w.t)) ?? 0) + 1)
    for (const l of s.gt.lines) {
      if (l.words.length < 7) continue
      for (const wi of l.words.slice(2, -2)) {
        const t = key(s.gt.words[wi].t)
        if (t.length >= 5 && count.get(t) === 1) return { index: wi, line: l.words }
      }
    }
    throw new Error('no unique mid-line word on the page')
  }

  it('a redaction filters the word from Find and Copy; undo brings it back', async () => {
    const { index, line } = target()
    const word = s.gt.words[index]
    const query = word.t.replace(/[^\p{L}\p{N}]/gu, '')
    const height = s.gt.page.height
    const h = await harness([{ native: baked, height }])
    expect(h.search(query).length).toBe(1)
    expect(h.copyText(0)).toContain(query)
    // Every other word's query, except those that also occur inside the word or its two line
    // neighbours (the slice pad may clip a neighbour's edge character), and its hit count.
    const pos = line.indexOf(index)
    const near = [line[pos - 1], index, line[pos + 1]].map((i) => s.gt.words[i].t.toLowerCase())
    const others = [
      ...new Set(
        s.gt.words
          .map((w) => w.t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase())
          .filter((q) => q.length >= 2 && !near.some((n) => n.includes(q)))
      )
    ]
    expect(others.length).toBeGreaterThan(30)
    const before = new Map(others.map((q) => [q, h.search(q).length]))

    h.engine.setRedactions(h.keys[0], [toPageRect(word.box, height)])
    expect(h.search(query)).toEqual([])
    expect(h.copyText(0)).not.toContain(query)
    // The rest of the page, its own line included, is still found exactly as before.
    for (const q of others) expect(h.search(q).length, q).toBe(before.get(q))
    // The copy keeps the line, with the box as a word boundary (one space, no join).
    const copied = h.copyText(0)
    expect(copied.split('\n')).toHaveLength(s.gt.lines.length)
    expect(copied).not.toMatch(/ {2}/)

    h.engine.setRedactions(h.keys[0], null)
    expect(h.search(query).length).toBe(1)
    expect(h.copyText(0)).toContain(query)
  })

  it('Replace with the same words leaves the hit count unchanged (append would double it)', async () => {
    const ocr = ocrPageFromGt(s.gt)
    const height = s.gt.page.height
    const plain = await harness([{ native: baked, height }])
    const replaced = await harness([{ native: baked, height, ocr, mode: 'replace' }])
    const appended = await harness([{ native: baked, height, ocr, mode: 'append' }])
    for (const q of ['the', 'and', s.gt.words[3].t.replace(/[^\p{L}\p{N}]/gu, '')]) {
      const n = plain.search(q).length
      expect(n, q).toBeGreaterThan(0)
      expect(replaced.search(q).length, q).toBe(n)
      expect(appended.search(q).length, q).toBe(2 * n)
    }
  })
})

describe('CJK Find round trip: pre-export supplement == post-export pdf.js', () => {
  // Words as an engine splits them: CJK runs broken into "words" with no space between them
  // (needsSpaceBetween → false), Latin and Korean words with spaces, and mixed boundaries.
  const lines = [
    ['東京', '都庁', 'の', '近く', 'に', 'あります'],
    ['PDFx', 'は', '日本語', 'を', '検索', 'できる'],
    ['我们', '的', '文档', '很', '重要'],
    ['한국어', '문서', '검색', '테스트'],
    ['全角', 'ＡＢＣ', 'と', 'カタカナ', 'テスト']
  ]
  const page = handPage(
    lines.map((ws, i) => ({ y: 700 - 30 * i, size: 16, x0: 72, words: flowWords(ws, 16, 1) })),
    { langs: ['jpn', 'chi_sim', 'kor'] }
  )
  const queries = [
    ...new Set(lines.flat().filter((w) => [...w].length >= 2)),
    // Across engine word boundaries: one run in the layer, so one run before export too.
    '東京都庁',
    '都庁の近く',
    '日本語を検索',
    '我们的文档',
    '全角ａｂｃ',
    // Across a space and across a line break.
    'pdfx は',
    '한국어 문서',
    'あります pdfx'
  ]

  let pre: FindHarness
  let post: FindHarness
  beforeAll(async () => {
    const blank = await blankPdf()
    pre = await harness([{ native: blank, height: 792, ocr: page }])
    post = await harness([{ native: (await bakeLayer(blank, [page])).bytes, height: 792 }])
  })

  it.each(queries)('%s: the same hits in the same places', (q) => {
    const a = pre.search(q)
    const b = post.search(q)
    expect(a.length, `pre-export hits for ${q}`).toBeGreaterThan(0)
    expect(b.length, `post-export hits for ${q}`).toBe(a.length)
    const order = (hs: typeof a): typeof a => [...hs].sort((x, y) => y.box.y - x.box.y || x.box.x - y.box.x) // prettier-ignore
    const [sa, sb] = [order(a), order(b)]
    sa.forEach((h, i) => expect(iou(h.box, sb[i].box), q).toBeGreaterThan(0.5))
  })

  it('copy text agrees before and after export', () => {
    expect(pre.copyText(0)).toBe(
      ['東京都庁の近くにあります', 'PDFx は日本語を検索できる', '我们的文档很重要', '한국어 문서 검색 테스트', '全角ＡＢＣとカタカナテスト'].join('\n') // prettier-ignore
    )
    expect(post.copyText(0)).toBe(pre.copyText(0))
  })
})
