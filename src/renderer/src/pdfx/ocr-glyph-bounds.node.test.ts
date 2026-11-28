// Glyph-bounds measurements behind the choice of the glyphless glyph (DESIGN.md §3.7.3 rule 4,
// §3.7.4), pinned so a PDFium or pdf.js upgrade that changes them is noticed (R13).
//
// For each glyph variant of scripts/make-glyphless-ttf.py (zero-area: two one-point contours at
// the em box's corners; diagonal: one there-and-back two-point contour; no contour; no contour +
// em-box head bbox) and each FontDescriptor variant (em: [0 -200 1000 800], Flags 4; tesseract:
// [0 0 1000 1000], Flags 5) this measures, as a fraction of the em height (the font size): PDFium
// FPDFPageObj_GetBounds of the text objects, FPDFText_GetCharBox and FPDFText_GetLooseCharBox,
// and pdf.js's item geometry (ascent − descent). It then runs the shipped redaction engine
// (redact.ts `redactPdf`, and the frozen 1.1.3 copy in test-utils/legacy) with a box over one
// word's x-height band that misses its baseline — the case rule 4 is about.
//
// Result [measured, this file]: only the two spanning variants (zero-area, diagonal) give every
// PDFium measure ≥ 90% of the em, and only with them does the 1.1.3 redaction remove the word.
// With the two contour-less variants PDFium reports zero-height text objects and char boxes, so
// under 1.1.3 the word under the box SURVIVES the redaction: a leak, which 1.1.4's invisible-text
// pad (PR3b) closes for every variant. pdf.js ignores outlines for geometry and reports
// 0.8/−0.2 for all of them. Painting: `diagonal` (the PR2 first choice) paints a 1-px hairline per
// glyph under PDFium's monochrome text path (FPDF_RENDER_NO_SMOOTHTEXT) at 36/72/90/144 dpi, and
// under FreeType 2.14.3 mono rendering at every size from 8 to 300 px [measured: Pillow 12.2
// `ImageDraw.fontmode = '1'`, a scratch script, not part of the suite: it would add a Python
// dependency]: dropout control fills its edge pair. `zero-area` has no edge at all and painted 0 px
// in every one of those renders. Hence the default.
// MuPDF `mutool draw -F stext` was not measured (not installed on the PR2 machine; it is AGPL and
// must never become a dependency).

import { PDFDocument } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  createPdfiumRasterizer,
  FPDF_PRINTING,
  FPDF_RENDER_NO_SMOOTHTEXT,
  type Rasterizer
} from '../../../shared/ocr/test-utils/pdfium-raster'
import { loadTestPdfium } from '../test-utils/pdfium'
import {
  GLYPHLESS_TTF_DIAGONAL,
  GLYPHLESS_TTF_FONTBBOX,
  GLYPHLESS_TTF_NO_CONTOUR,
  GLYPHLESS_TTF_ZERO_AREA
} from './ocr-glyphless-ttf'
import type { OcrFontBBox } from './ocr-font'
import { redactPdf } from './redact'
import { redactPdf as redactPdf113 } from './test-utils/legacy/redact-1.1.3'
import {
  allStreams,
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
  diagonal: b64(GLYPHLESS_TTF_DIAGONAL),
  none: b64(GLYPHLESS_TTF_NO_CONTOUR),
  fontbbox: b64(GLYPHLESS_TTF_FONTBBOX)
} as const
/** Anti-aliased (default), monochrome text, and monochrome text on the print path. */
const RENDER_FLAGS = [0, FPDF_RENDER_NO_SMOOTHTEXT, FPDF_RENDER_NO_SMOOTHTEXT | FPDF_PRINTING]
/** Monochrome dropout pixels of the diagonal glyph showed at these (and not at 50–300) dpi. */
const PAINT_DPIS = [36, 72, 90, 144, 300]

/** Every code point a ToUnicode CMap (bfchar) in `bytes` maps to. */
async function toUnicodeCodePoints(bytes: Uint8Array): Promise<Set<string>> {
  const out = new Set<string>()
  for (const { data } of await allStreams(bytes)) {
    const text = new TextDecoder('latin1').decode(data)
    if (!text.includes('begincmap')) continue
    for (const m of text.matchAll(/<[0-9A-Fa-f]+> <([0-9A-Fa-f]+)>/g)) {
      const u = m[1].match(/.{4}/g)!.map((h) => parseInt(h, 16))
      out.add(String.fromCharCode(...u))
    }
  }
  return out
}
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
  it.each(['zero-area', 'diagonal'] as const)(
    '%s: every tool reports ≥ 90% of the em height',
    async (variant) => {
      const m = await measure(variant, bbox)
      expect(m.objH).toBeGreaterThanOrEqual(0.9)
      expect(m.charH).toBeGreaterThanOrEqual(0.9)
      expect(m.looseH).toBeGreaterThanOrEqual(0.9)
      expect(m.pdfjsH).toBeGreaterThanOrEqual(0.9)
      // The box hangs below the baseline by the descent (−0.2 em), not from the baseline up.
      expect(m.charB).toBeCloseTo(-0.2, 1)
      // Wide CIDs use g2, so a CJK char's PDFium box is its full 1 em advance.
      expect(m.wideCharW).toBeCloseTo(1, 1)
    }
  )

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

  it.each(['zero-area', 'none', 'fontbbox'] as const)(
    '%s: paints nothing in render mode 0, anti-aliased or monochrome',
    async (variant) => {
      const visible = await bakeLayer(blank, [PAGE], {
        ttf: VARIANTS[variant],
        bbox,
        renderMode: 0
      })
      expect(visible.content).toContain(' 0 Tr ')
      for (const flags of RENDER_FLAGS)
        for (const dpi of PAINT_DPIS) {
          const painted = raster(visible.bytes, dpi, 0, flags).data.filter((v) => v !== 255).length
          expect(painted, `flags ${flags} at ${dpi} dpi`).toBe(0)
        }
    }
  )

  it('diagonal: monochrome text paints its dropout pixels (why it is not the default)', async () => {
    const visible = await bakeLayer(blank, [PAGE], {
      ttf: VARIANTS.diagonal,
      bbox,
      renderMode: 0
    })
    const painted = (dpi: number, flags: number): number =>
      raster(visible.bytes, dpi, 0, flags).data.filter((v) => v !== 255).length
    expect(painted(72, 0)).toBe(0)
    expect(painted(72, FPDF_RENDER_NO_SMOOTHTEXT)).toBeGreaterThan(0)
  })

  it.each([
    ['zero-area', true],
    ['diagonal', true],
    ['none', false],
    ['fontbbox', false]
  ] as const)(
    '%s: redactPage over the x-height band (baseline missed) removes the word: 1.1.3 %s, 1.1.4 always',
    async (variant, removedBy113) => {
      const baked = await bakeLayer(blank, [PAGE], { ttf: VARIANTS[variant], bbox })
      // The frozen 1.1.3 engine (no pad) and today's (the invisible-text pad of §3.7.3 rule 4).
      for (const [engine, removed] of [
        [redactPdf113, removedBy113],
        [redactPdf, true]
      ] as const) {
        const out = engine(pdfium, baked.bytes, [{ pageIndex: 0, rects: [X_HEIGHT_BOX] }])
        const pdfiumText = pdfiumProbe(pdfium, out).text
        const pdfjs = pdfjsCopyText((await pdfjsText(out)).items)
        expect(pdfiumText.includes('word')).toBe(!removed)
        expect(pdfjs.includes('word')).toBe(!removed)
        // The pad grows the bounds across the baseline only: the neighbours on the line stay.
        expect(pdfjs).toContain('Secret')
        expect(pdfjs).toContain('here')
        // FPDFPage_GenerateContent keeps the survivors invisible.
        for (const o of pdfiumProbe(pdfium, out).textObjects) expect(o.mode).toBe(3)
      }
    }
  )

  it('per-word redactPdf leaves the OCR ToUnicode mapping "word" (why the export passes dropOcrText)', async () => {
    // Per-word removal takes the word's text objects, but the page's OCR font keeps the ToUnicode,
    // /W and CIDToGIDMap written for every character baked (OcrFontCache), and a PDFium pass
    // cannot trim them. "w", "o" and "d" occur only in "word", so this alone would violate §3.7.3
    // rule 5 on the "re-redacting a reopened OCR'd PDF" fixture. The export's redaction pass
    // (redact-export.ts) therefore passes `dropOcrText`, which removes the page's whole OCR layer
    // and with it the font (ocr-export.node.test.ts "a reopened OCR'd export"). PR3b keeps that
    // whole-layer drop: trimming the tables would mean parsing PDFium's regenerated content for
    // the CIDs still shown, a new parser on the security path; Replace (PR3c) re-bakes instead.
    const baked = await bakeLayer(blank, [PAGE], { ttf: VARIANTS['zero-area'], bbox })
    const out = redactPdf(pdfium, baked.bytes, [{ pageIndex: 0, rects: [X_HEIGHT_BOX] }])
    expect(pdfiumProbe(pdfium, out).text).not.toContain('word')
    const cps = await toUnicodeCodePoints(out)
    for (const ch of 'wod') expect(cps).toContain(ch)
  })
})
