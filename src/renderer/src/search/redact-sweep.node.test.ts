// Redaction fail-safety on REAL pdf.js items (DESIGN.md §3.6.1): long standard-14 lines drawn with
// pdf-lib, read back with the shipped extractor, every word and every character boxed in turn with
// its exact glyph box. pdf.js reports one advance per merged item, so a character's place in it is
// only estimated (redact-filter.ts); a boxed character must never survive the estimate's error,
// whatever the font. Over-removal (neighbours that go too) is bounded, not zero.

import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
// Run pdf.js's worker in-process (its "fake worker": it picks up globalThis.pdfjsWorker).
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'
import { beforeAll, describe, expect, it } from 'vitest'

import { extractPageText, type PageText } from './extract'
import type { PageRect } from './geometry'
import { nativeRuns } from './redact-filter'

/** Long lines heavy in capitals, in i/l, in wide letters, and plain prose. */
const LINES = [
  'NOTICE OF ASSIGNMENT: THE BENEFICIARY OF RECORD AT 1200 MOUNT HOLLY AVENUE, MOUNT HOLLY, NJ, WILLAMINA BENEFICIARY: FINAL',
  'Minimal illumination with millimetre WWW MMM wording, the CONFIDENTIAL token sits near the end here and the ssn 123-45-6789 also',
  'fill lilt illicit little lilies fill the hill till all illnesses will still kill; lilt fill ill',
  'The quick brown fox jumps over the lazy dog while the account number 4417 1234 5678 9113 is printed',
  'MMMMMMMMMM lllllllll WWWWWW iiiiiiiiii mmmmm IIIIII lllll MMMMM wide and narrow letters mixed up'
]
const FONTS = [
  StandardFonts.Helvetica,
  StandardFonts.HelveticaBold,
  StandardFonts.TimesRoman,
  StandardFonts.TimesRomanBold,
  StandardFonts.TimesRomanItalic,
  StandardFonts.TimesRomanBoldItalic,
  StandardFonts.Courier
]
const PAGE = { width: 1190, height: 400 }

/** A boxed stretch of the page's text: global offsets into the items' strs concatenated. */
interface Target {
  lo: number
  hi: number
  rect: PageRect
}

interface FontPage {
  pt: PageText
  words: Target[]
  chars: Target[]
}

async function fontPage(name: StandardFonts, size: number): Promise<FontPage> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([PAGE.width, PAGE.height])
  const font = await doc.embedFont(name)
  // Glyph advances as drawText lays them out: its Tj applies no kerning, so neither may the GT
  // (widthOfTextAtSize of a whole string adds the AFM kerning pairs).
  const adv = (t: string): number => [...t].reduce((a, c) => a + font.widthOfTextAtSize(c, size), 0)
  const asc = font.heightAtSize(size, { descender: false })
  const words: Target[] = []
  const chars: Target[] = []
  let base = 0
  LINES.forEach((text, li) => {
    const y = PAGE.height - 40 - li * 30
    page.drawText(text, { x: 20, y, size, font })
    const box = (lo: number, hi: number, h: number): PageRect => {
      const x0 = 20 + adv(text.slice(0, lo))
      return { x: x0, y: PAGE.height - y - h, w: 20 + adv(text.slice(0, hi)) - x0, h }
    }
    for (const m of text.matchAll(/\S+/gu)) {
      const lo = m.index
      words.push({ lo: base + lo, hi: base + lo + m[0].length, rect: box(lo, lo + m[0].length, asc) }) // prettier-ignore
    }
    for (let i = 0; i < text.length; i++) {
      // A thin box across the x-height: the glyph's own advance, nothing either side.
      if (text[i] !== ' ')
        chars.push({ lo: base + i, hi: base + i + 1, rect: box(i, i + 1, asc / 3) })
    }
    base += text.length
  })
  const pdf = await getDocument({ data: await doc.save(), verbosity: 0 }).promise
  const pt = await extractPageText(pdf as never, 0)
  await pdf.destroy()
  expect(pt.items.map((i) => i.str).join('')).toBe(LINES.join(''))
  return { pt, words, chars }
}

/** Per target: the boxed characters that survive, and how many other characters went too. */
function sweep({ pt }: FontPage, targets: readonly Target[]): { leaks: string[]; over: number } {
  const all = pt.items.map((i) => i.str).join('')
  const starts: number[] = []
  let at = 0
  for (const it of pt.items) {
    starts.push(at)
    at += it.str.length
  }
  const leaks: string[] = []
  let over = 0
  for (const t of targets) {
    const removed = new Uint8Array(all.length)
    pt.items.forEach((it, k) => {
      for (const r of nativeRuns(it, [t.rect], pt.vt) ?? [])
        if (r.removed) removed.fill(1, starts[k] + r.lo, starts[k] + r.hi)
    })
    for (let i = t.lo; i < t.hi; i++) if (!removed[i]) leaks.push(`${all.slice(t.lo, t.hi)}[${i - t.lo}]`) // prettier-ignore
    for (let i = 0; i < all.length; i++)
      if (removed[i] && all[i] !== ' ' && (i < t.lo || i >= t.hi)) over++
  }
  return { leaks, over: over / targets.length }
}

describe.each(FONTS)('redacting real pdf.js items in %s', (name) => {
  for (const size of [7, 11]) {
    describe(`${size} pt`, () => {
      let page: FontPage
      beforeAll(async () => {
        page = await fontPage(name, size)
      })

      it('boxing any word removes every character of it', () => {
        const { leaks, over } = sweep(page, page.words)
        expect(leaks).toEqual([])
        // [measured, this commit] 0.4 (Courier) to 3.7 extra characters per boxed word here.
        expect(over).toBeLessThan(4.5)
      })

      it('boxing any single character removes it', () => {
        const { leaks, over } = sweep(page, page.chars)
        expect(leaks).toEqual([])
        // [measured, this commit] 2.3 to 4.5.
        expect(over).toBeLessThan(5.5)
      })
    })
  }
})
