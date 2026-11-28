// The PDFx OCR layer a reopened file carries, read back with pdf.js marked content for "Show
// recognized text" (DESIGN.md §3.6.3): only the layer's runs (never the page's visible text), in the
// same display frame the session words are drawn in, on an upright and on a /Rotate 90 page.

import { degrees, PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'

import { pack } from '../../../shared/ocr/types'
import { OCR_MARK } from '../pdfx/ocr-layer'
import { bakeLayer, flowWords, handPage } from '../pdfx/test-utils/ocr-layer'
import { sessionWords, type ShownWord } from './recognized-text'
import {
  readSavedLayer,
  SAVED_LAYER_TAG,
  savedRuns,
  savedWordsFromOps,
  WALK_OPS
} from './saved-layer'

const LINES = [
  ['Recognised', 'words', 'here'],
  ['second', 'line', 'of', 'text']
]

async function sourcePdf(rotate = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  if (rotate) page.setRotation(degrees(rotate))
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('Visible heading', { x: 72, y: 760, size: 14, font })
  return doc.save()
}

/** The layer's lines in the overlay frame (display width `fw`). */
const layerPage = (): ReturnType<typeof handPage> =>
  handPage(
    LINES.map((ws, i) => ({ y: 600 - 30 * i, size: 16, x0: 72, words: flowWords(ws, 9, 5) }))
  )

async function open(
  bytes: Uint8Array
): Promise<Awaited<ReturnType<typeof getDocument>['promise']>> {
  return getDocument({ data: bytes.slice(), verbosity: 0 }).promise
}

describe('saved PDFx OCR layer', () => {
  it('the tag is the layer’s marked-content tag', () => {
    expect(SAVED_LAYER_TAG).toBe(OCR_MARK)
  })

  it('reads only the layer’s words, at their place in the display frame', async () => {
    const baked = await bakeLayer(await sourcePdf(), [layerPage()])
    const pdf = await open(baked.bytes)
    try {
      const runs = await readSavedLayer(pdf as never, 0)
      expect(runs.map((r) => r.t)).toEqual(LINES.flat())
      expect(runs.some((r) => r.t.includes('Visible'))).toBe(false)
      // Line 1: baseline start (72, 600) in the overlay frame → (72, 192) on screen, upright.
      expect(runs[0].x).toBeCloseTo(72, 0)
      expect(runs[0].y).toBeCloseTo(792 - 600, 0)
      expect(runs[0].size).toBeCloseTo(16, 1)
      expect(runs[0].deg).toBeCloseTo(0, 3)
      // Each word its own advance: 'Recognised' is 10 × 9 pt; 'words' starts 90 + 5 further on.
      expect(runs[0].w).toBeCloseTo(90, 2)
      expect(runs[1].x).toBeCloseTo(72 + 95, 2)
      expect(runs[3].y).toBeCloseTo(792 - 570, 0)
      // Cached per document and page.
      expect(readSavedLayer(pdf as never, 0)).toBe(readSavedLayer(pdf as never, 0))
    } finally {
      await pdf.destroy()
    }
  })

  it('on a /Rotate 90 page, lands where the session words would (the overlay frame flipped)', async () => {
    const baked = await bakeLayer(await sourcePdf(90), [layerPage()])
    const pdf = await open(baked.bytes)
    try {
      const page = await pdf.getPage(1)
      const { width, height } = page.getViewport({ scale: 1 })
      expect([width, height]).toEqual([792, 612])
      const runs = await readSavedLayer(pdf as never, 0)
      expect(runs).toHaveLength(7)
      expect(runs[0].x).toBeCloseTo(72, 0)
      expect(runs[0].y).toBeCloseTo(height - 600, 0)
      expect(runs[0].deg).toBeCloseTo(0, 3)
    } finally {
      await pdf.destroy()
    }
  })

  it('pins the operator codes the walk reads to pdf.js’s OPS', () => {
    for (const [name, code] of Object.entries(WALK_OPS))
      expect([name, code]).toEqual([name, (OPS as Record<string, number>)[name]])
  })

  // The overlay must draw a reopened file's words where it drew them in the session: per word, at
  // the layer's own start and advance (pdf.js's text content merges a line into one run, and one
  // run stretched over the line in a substitute font ghosts the print).
  describe('per word, where the session drew them', () => {
    /** The saved words beside the session words of the same page (same order). */
    async function compare(
      page: ReturnType<typeof handPage>,
      rotate = 0
    ): Promise<{ saved: Awaited<ReturnType<typeof readSavedLayer>>; session: ShownWord[] }> {
      const baked = await bakeLayer(await sourcePdf(rotate), [page])
      const pdf = await open(baked.bytes)
      try {
        const { height } = (await pdf.getPage(1)).getViewport({ scale: 1 })
        const saved = await readSavedLayer(pdf as never, 0)
        return { saved, session: sessionWords(pack(page), height) }
      } finally {
        await pdf.destroy()
      }
    }

    function expectAligned(
      saved: readonly { t: string; x: number; y: number; w: number; size: number; deg: number }[],
      session: readonly ShownWord[],
      tol: { pos: number; w: number }
    ): void {
      expect(saved.map((w) => w.t)).toEqual(session.map((w) => w.t))
      saved.forEach((s, i) => {
        const o = session[i]
        expect(Math.abs(s.x - o.x), `${s.t} x`).toBeLessThan(tol.pos)
        expect(Math.abs(s.y - o.y), `${s.t} y`).toBeLessThan(tol.pos)
        expect(Math.abs(s.w - o.w), `${s.t} w`).toBeLessThan(tol.w)
        expect(Math.abs(s.size - o.size), `${s.t} size`).toBeLessThan(0.01)
        expect(Math.abs(s.deg - o.deg), `${s.t} deg`).toBeLessThan(0.01)
      })
    }

    // Words of uneven width and spacing, as a real scan has them (a char-count split of the run
    // would not land on them).
    const uneven = (): ReturnType<typeof handPage> =>
      handPage([
        {
          y: 600,
          size: 14,
          x0: 72,
          words: [
            { t: 'maps,', x: 0, w: 38 },
            { t: 'photographs', x: 43, w: 81 },
            { t: 'and', x: 131, w: 22 },
            { t: 'Ill', x: 160, w: 12 }
          ]
        },
        { y: 570, size: 11, x0: 90, words: flowWords(['kitchen', 'table', 'WWW'], 7, 4) }
      ])

    it('upright: every word starts and ends where the session word does', async () => {
      const { saved, session } = await compare(uneven())
      expect(saved).toHaveLength(7)
      expectAligned(saved, session, { pos: 0.01, w: 0.01 })
    })

    it('on a /Rotate 90 page too', async () => {
      const { saved, session } = await compare(uneven(), 90)
      expectAligned(saved, session, { pos: 0.01, w: 0.01 })
    })

    it('on a skewed page (one page-wide Tz, words fitted with Tc): the starts are exact', async () => {
      const angle = (2 * Math.PI) / 180
      const skew = handPage([
        {
          y: 600,
          size: 12,
          x0: 72,
          angle,
          // 'WOW' is far wider than the page Tz gives it: its widening is capped.
          words: [
            { t: 'is', x: 0, w: 12 },
            { t: 'WOW', x: 17, w: 33 },
            { t: 'in', x: 55, w: 12 },
            { t: 'the', x: 72, w: 18 }
          ]
        },
        {
          y: 580,
          size: 12,
          x0: 72,
          angle,
          words: flowWords(['courtyard', 'when', 'it', 'rains'], 5.5, 6)
        },
        // A column jump (a gap over MAX_STRETCH_GAP_EM): the space keeps its natural width, so the
        // word before it must not be stretched across the gutter.
        {
          y: 560,
          size: 12,
          x0: 72,
          angle,
          words: [
            { t: 'left', x: 0, w: 30 },
            { t: 'right', x: 200, w: 36 }
          ]
        }
      ])
      const { saved, session } = await compare(skew)
      // The layer writes a word widened past OBLIQUE_TC_MAX per glyph short (ocr-layer.ts `show`);
      // the reader recovers its width from the stretched space after it. The last word of a line
      // has none, so it keeps the written width.
      const lastOfLine = new Set([3, 7, 8, 9])
      expectAligned(
        saved.filter((_, i) => !lastOfLine.has(i)),
        session.filter((_, i) => !lastOfLine.has(i)),
        { pos: 0.01, w: 0.01 }
      )
      for (const i of lastOfLine) {
        expect(saved[i].t).toBe(session[i].t)
        expect(Math.abs(saved[i].x - session[i].x)).toBeLessThan(0.01)
        expect(saved[i].w).toBeLessThanOrEqual(session[i].w + 0.01)
      }
    })
  })

  it('the walk: words split at spaces, wide TJ gaps and text positioning; only inside the layer', () => {
    const O = WALK_OPS
    const g = (unicode: string, width = 500): unknown => ({
      unicode,
      width,
      isSpace: unicode === ' '
    })
    const glyphs = (s: string): unknown[] => [...s].map((c) => g(c))
    const vt = [1, 0, 0, -1, 0, 792]
    const fn = [
      O.showText, // outside the layer: ignored
      O.beginMarkedContentProps,
      O.beginText,
      O.setFont,
      O.setTextMatrix,
      O.setHScale,
      O.showText,
      O.showText, // a space glyph
      O.setTextMatrix,
      O.showText, // "cd" then a wide TJ gap then "ef"
      O.save,
      O.transform,
      O.setTextMatrix,
      O.showText,
      O.restore,
      O.endText,
      O.endMarkedContent,
      O.beginMarkedContent,
      O.showText // other marked content: ignored
    ]
    const args = [
      [glyphs('outside')],
      [SAVED_LAYER_TAG, null],
      null,
      ['f1', 10],
      [new Float32Array([1, 0, 0, 1, 100, 700])],
      [200],
      [glyphs('ab')],
      [[g(' ')]],
      [new Float32Array([1, 0, 0, 1, 150, 700])],
      [[...glyphs('cd'), -400, ...glyphs('ef')]],
      null,
      [2, 0, 0, 2, 0, 0],
      [new Float32Array([1, 0, 0, 1, 10, 20])],
      [glyphs('gh')],
      null,
      null,
      null,
      [{ name: 'Span' }],
      [glyphs('span')]
    ]
    const words = savedWordsFromOps(fn, args, vt)
    expect(words.map((w) => w.t)).toEqual(['ab', 'cd', 'ef', 'gh'])
    // "ab": 2 glyphs × 500/1000 × 10 pt × Tz 200% = 20 pt wide, baseline (100, 700) → (100, 92).
    expect(words[0]).toMatchObject({ x: 100, y: 92, w: 20, size: 10, deg: 0 })
    // "ef" starts after "cd" (20) and the 0.4 em × Tz gap (8).
    expect(words[2].x).toBeCloseTo(178)
    // Under `2 0 0 2 0 0 cm`: twice the size and place.
    expect(words[3]).toMatchObject({ x: 20, y: 752, w: 40, size: 20 })
  })

  it('a page without a layer, or one that cannot be read, has no runs', async () => {
    const pdf = await open(await sourcePdf())
    try {
      expect(await readSavedLayer(pdf as never, 0)).toEqual([])
      expect(await readSavedLayer(pdf as never, 5)).toEqual([])
    } finally {
      await pdf.destroy()
    }
    expect(await readSavedLayer({} as never, 0)).toEqual([])
  })

  it('tracks nesting: text in other marked content, or after the layer ends, is not the layer', () => {
    const vt = [1, 0, 0, -1, 0, 792]
    const item = (str: string): unknown => ({ str, transform: [10, 0, 0, 10, 50, 700], width: 40 })
    const runs = savedRuns(
      [
        item('before'),
        { type: 'beginMarkedContent', tag: 'Span' },
        item('in span'),
        { type: 'endMarkedContent' },
        { type: 'beginMarkedContentProps', tag: SAVED_LAYER_TAG, id: null },
        { type: 'beginMarkedContent', tag: 'Inner' },
        item('nested in layer'),
        { type: 'endMarkedContent' },
        item('layer'),
        item('   '),
        { str: 'bad', transform: [1, 0, 0, 1, NaN, 0], width: 1 },
        { type: 'endMarkedContent' },
        item('after')
      ],
      vt
    )
    expect(runs.map((r) => r.t)).toEqual(['nested in layer', 'layer'])
    expect(runs[0]).toMatchObject({ x: 50, y: 92, w: 40, size: 10, deg: 0 })
  })
})
