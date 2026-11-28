// The PDFx OCR layer a reopened file carries, read back with pdf.js marked content for "Show
// recognized text" (DESIGN.md §3.6.3): only the layer's runs (never the page's visible text), in the
// same display frame the session words are drawn in, on an upright and on a /Rotate 90 page.

import { degrees, PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'

import { OCR_MARK } from '../pdfx/ocr-layer'
import { bakeLayer, flowWords, handPage } from '../pdfx/test-utils/ocr-layer'
import { readSavedLayer, SAVED_LAYER_TAG, savedRuns } from './saved-layer'

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

  it('reads only the layer’s runs, at their place in the display frame', async () => {
    const baked = await bakeLayer(await sourcePdf(), [layerPage()])
    const pdf = await open(baked.bytes)
    try {
      const runs = await readSavedLayer(pdf as never, 0)
      expect(runs.map((r) => r.t)).toEqual(LINES.map((l) => l.join(' ')))
      expect(runs.some((r) => r.t.includes('Visible'))).toBe(false)
      // Line 1: baseline start (72, 600) in the overlay frame → (72, 192) on screen, upright.
      expect(runs[0].x).toBeCloseTo(72, 0)
      expect(runs[0].y).toBeCloseTo(792 - 600, 0)
      expect(runs[0].size).toBeCloseTo(16, 1)
      expect(runs[0].deg).toBeCloseTo(0, 3)
      // The run spans its words: the last word ends at 72 + Σ widths + gaps.
      const span = flowWords(LINES[0], 9, 5).at(-1)!
      expect(runs[0].w).toBeGreaterThan(span.x + span.w - 10)
      expect(runs[0].w).toBeLessThan(span.x + span.w + 10)
      expect(runs[1].y).toBeCloseTo(792 - 570, 0)
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
      expect(runs).toHaveLength(2)
      expect(runs[0].x).toBeCloseTo(72, 0)
      expect(runs[0].y).toBeCloseTo(height - 600, 0)
      expect(runs[0].deg).toBeCloseTo(0, 3)
    } finally {
      await pdf.destroy()
    }
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
