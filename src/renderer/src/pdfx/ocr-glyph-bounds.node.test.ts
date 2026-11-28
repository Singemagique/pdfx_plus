// Glyph-bounds measurements behind the choice of the glyphless glyph (DESIGN.md §3.7.3 rule 4,
// §3.7.4), pinned so a PDFium or pdf.js upgrade that changes them is noticed (R13).
//
// For each glyph variant of scripts/make-glyphless-ttf.py (zero-area spanning contour; no contour;
// no contour + em-box head bbox) and each FontDescriptor variant (em: [0 -200 500 800], Flags 4;
// tesseract: [0 0 500 1000], Flags 5) this measures, as a fraction of the em height (the font
// size): PDFium FPDFPageObj_GetBounds of the text objects, FPDFText_GetCharBox and
// FPDFText_GetLooseCharBox, and pdf.js's item geometry (ascent − descent). It then runs the
// shipped redaction engine (redact.ts `redactPdf`, the 1.1.3 code path) with a box over one
// word's x-height band that misses its baseline — the case rule 4 is about.
//
// Result [measured, this file]: only `zero-area` gives every PDFium measure ≥ 90% of the em, and
// only with it does the redaction remove the word. With the two contour-less variants PDFium
// reports zero-height text objects and char boxes, so the word under the box SURVIVES the
// redaction: a leak. pdf.js ignores outlines for geometry and reports 0.8/−0.2 for all of them.
// MuPDF `mutool draw -F stext` was not measured (not installed on the PR2 machine; it is AGPL and
// must never become a dependency).

import { PDFDocument } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  createPdfiumRasterizer,
  type Rasterizer
} from '../../../shared/ocr/test-utils/pdfium-raster'
import { loadTestPdfium } from '../test-utils/pdfium'
import {
  GLYPHLESS_TTF_FONTBBOX,
  GLYPHLESS_TTF_NO_CONTOUR,
  GLYPHLESS_TTF_ZERO_AREA
} from './ocr-glyphless-ttf'
import type { OcrFontBBox } from './ocr-font'
import { redactPdf } from './redact'
import {
  bakeLayer,
  flowWords,
  handPage,
  pdfiumProbe,
  pdfjsCopyText,
  pdfjsText,
  type ProbePdfium
} from './test-utils/ocr-layer'

const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const VARIANTS = {
  'zero-area': b64(GLYPHLESS_TTF_ZERO_AREA),
  none: b64(GLYPHLESS_TTF_NO_CONTOUR),
  fontbbox: b64(GLYPHLESS_TTF_FONTBBOX)
} as const
type Variant = keyof typeof VARIANTS
const BBOXES: OcrFontBBox[] = ['em', 'tesseract']

const SIZE = 20
const BASELINE = 200
// "Secret word here" at x0 = 20, 10 pt per character, 6 pt gaps: "word" spans x 86..126.
const PAGE = handPage([
  { y: BASELINE, size: SIZE, x0: 20, words: flowWords(['Secret', 'word', 'here'], 10, 6) },
  { y: 120, size: SIZE, x0: 20, words: flowWords(['東京'], 20, 0) }
])
/** Over "word"'s x-height band (baseline + 0.05 em … + 0.45 em), clear of its baseline. */
const X_HEIGHT_BOX = { x: 90, y: BASELINE + 1, w: 30, h: 8 }

let pdfium: ProbePdfium
let raster: Rasterizer
let blank: Uint8Array

beforeAll(async () => {
  pdfium = await loadTestPdfium<ProbePdfium>()
  raster = createPdfiumRasterizer(pdfium as never)
  const doc = await PDFDocument.create()
  doc.addPage([300, 300])
  blank = await doc.save()
})

interface Measure {
  /** FPDFPageObj_GetBounds height of the first word's text object, in em. */
  objH: number
  charH: number
  looseH: number
  /** Bottom of the char box relative to the baseline, in em. */
  charB: number
  pdfjsH: number
  /** Width of a CJK char's FPDFText_GetCharBox, in em (its advance is 1 em). */
  wideCharW: number
}

async function measure(variant: Variant, bbox: OcrFontBBox): Promise<Measure> {
  const baked = await bakeLayer(blank, [PAGE], { ttf: VARIANTS[variant], bbox })
  const p = pdfiumProbe(pdfium, baked.bytes)
  const obj = p.textObjects[0].bounds
  const ch = p.chars[0]
  const han = p.chars.find((c) => c.ch === '東')!
  const it0 = (await pdfjsText(baked.bytes)).items[0]
  return {
    objH: (obj.t - obj.b) / SIZE,
    charH: (ch.box.t - ch.box.b) / SIZE,
    looseH: (ch.loose.t - ch.loose.b) / SIZE,
    charB: (ch.box.b - BASELINE) / SIZE,
    pdfjsH: it0.ascent - it0.descent,
    wideCharW: (han.box.r - han.box.l) / SIZE
  }
}

describe.each(BBOXES)('FontBBox %s', (bbox) => {
  it('zero-area (the default): every tool reports ≥ 90% of the em height', async () => {
    const m = await measure('zero-area', bbox)
    expect(m.objH).toBeGreaterThanOrEqual(0.9)
    expect(m.charH).toBeGreaterThanOrEqual(0.9)
    expect(m.looseH).toBeGreaterThanOrEqual(0.9)
    expect(m.pdfjsH).toBeGreaterThanOrEqual(0.9)
    // The box hangs below the baseline by the descent (−0.2 em), not from the baseline up.
    expect(m.charB).toBeCloseTo(-0.2, 1)
    // Wide CIDs use g2, so a CJK char's PDFium box is its full 1 em advance.
    expect(m.wideCharW).toBeCloseTo(1, 1)
  })

  it.each(['none', 'fontbbox'] as const)(
    '%s: PDFium reports zero-height boxes (why it is not the default)',
    async (variant) => {
      const m = await measure(variant, bbox)
      expect(m.objH).toBeLessThan(0.05)
      expect(m.charH).toBeLessThan(0.05)
      // Only the loose box (font ascent/descent) and pdf.js still see the em.
      expect(m.looseH).toBeGreaterThanOrEqual(0.9)
      expect(m.pdfjsH).toBeGreaterThanOrEqual(0.9)
    }
  )

  it.each(Object.keys(VARIANTS) as Variant[])(
    '%s: paints nothing even in render mode 0',
    async (variant) => {
      const visible = await bakeLayer(blank, [PAGE], {
        ttf: VARIANTS[variant],
        bbox,
        renderMode: 0
      })
      expect(visible.content).toContain(' 0 Tr ')
      for (const dpi of [72, 300]) expect(raster(visible.bytes, dpi).data.every((v) => v === 255)).toBe(true) // prettier-ignore
    }
  )

  it.each([
    ['zero-area', true],
    ['none', false],
    ['fontbbox', false]
  ] as const)(
    '%s: redactPage over the x-height band (baseline missed) removes the word: %s',
    async (variant, removed) => {
      const baked = await bakeLayer(blank, [PAGE], { ttf: VARIANTS[variant], bbox })
      const out = redactPdf(pdfium, baked.bytes, [{ pageIndex: 0, rects: [X_HEIGHT_BOX] }])
      const pdfiumText = pdfiumProbe(pdfium, out).text
      const pdfjs = pdfjsCopyText((await pdfjsText(out)).items)
      expect(pdfiumText.includes('word')).toBe(!removed)
      expect(pdfjs.includes('word')).toBe(!removed)
      expect(pdfjs).toContain('Secret')
      expect(pdfjs).toContain('here')
      // FPDFPage_GenerateContent keeps the survivors invisible.
      for (const o of pdfiumProbe(pdfium, out).textObjects) expect(o.mode).toBe(3)
    }
  )
})
