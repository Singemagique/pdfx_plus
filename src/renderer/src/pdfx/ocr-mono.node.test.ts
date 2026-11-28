// The pdf.js monospace guard of the OCR font (ocr-font.ts MONO_GUARD_CID; found by PR7a).
//
// pdf.js 5.7.284 flags a font FixedPitch when every /W width equals /DW (`extractWidths`), and a
// Latin-only layer had only 500s. The app's Find (search/extract.ts `mono`, search/geometry.ts)
// then split each merged line of a reopened OCR'd PDF evenly per character, so highlights missed
// words that each carry their own Tz [PR7a, measured: clean300 0.846 on-target recall]. The guard
// lists the never-shown CID 0 at the wide advance. This suite proves, on the saved bytes:
// - pdf.js no longer reports the layer font monospace (and does with the guard taken out);
// - the after-export Find gate of §3.9.4 (every GT word found on its box, hit-on-target ≥ 0.95)
//   holds through the app's own extraction, normalisation, matching and highlight geometry, on
//   the four presets PR7a pinned with KNOWN_MONO_FLOOR (the equivalent of raising that floor to
//   the real gate, PR7a's harness not being on this branch);
// - the guard leaks nothing: no character, no ToUnicode entry, no pixel.

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  findScores,
  fromTopLeft,
  type FindGtWord,
  type FindHit,
  type FindScores
} from '../../../shared/ocr/test-utils/metrics'
import { loadNodeSynthDeps } from '../../../shared/ocr/test-utils/node-deps'
import {
  createPdfiumRasterizer,
  type Rasterizer
} from '../../../shared/ocr/test-utils/pdfium-raster'
import { synthesize, type SynthResult } from '../../../shared/ocr/test-utils/synth'
import { extractPageText, type PageText } from '../search/extract'
import { textMatchRects } from '../search/geometry'
import { compileQuery, findAll, normalizeQuery } from '../search/normalize'
import { loadTestPdfium } from '../test-utils/pdfium'
import { MONO_GUARD_CID } from './ocr-font'
import { rawLeaks, uniqueCodePoints } from './test-utils/leak-oracle'
import {
  bakeLayer,
  ocrPageFromGt,
  pdfjsCopyText,
  pdfjsText,
  type ProbePdfium
} from './test-utils/ocr-layer'

const PRESETS = ['clean300', 'skew2', 'rot90page', 'latin-diacritics']
/** §3.9.4: hit-on-target among hits (IoU > 0.5). */
const HIT_ON_TARGET = 0.95

let pdfium: ProbePdfium
let raster: Rasterizer
beforeAll(async () => {
  pdfium = await loadTestPdfium<ProbePdfium>()
  raster = createPdfiumRasterizer(pdfium as never)
})

const synthCache = new Map<string, Promise<SynthResult>>()
function synth(preset: string): Promise<SynthResult> {
  let p = synthCache.get(preset)
  if (!p) {
    p = loadNodeSynthDeps().then((d) => synthesize({ preset, seed: 7 }, d))
    synthCache.set(preset, p)
  }
  return p
}

/** The app's PageText of page 0 of `bytes` (search/extract.ts over the shipped pdf.js). */
async function pageText(bytes: Uint8Array): Promise<PageText> {
  const pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise
  try {
    return await extractPageText(pdf as never, 0)
  } finally {
    await pdf.destroy()
  }
}

/** pdf.js's font family for each font of page 0 (the style `extract.ts` reads `mono` from). */
async function fontFamilies(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise
  try {
    const content = await (await pdf.getPage(1)).getTextContent()
    const styles = content.styles as Record<string, { fontFamily?: string }>
    return Object.values(styles).map((s) => s.fontFamily ?? '')
  } finally {
    await pdf.destroy()
  }
}

/** Find over one page's text, as the app highlights it: hits in the GT frame (bottom-left). */
function searchOf(pt: PageText, height: number): (q: string) => FindHit[] {
  return (query) => {
    const norm = normalizeQuery(query)
    const re = compileQuery(norm)
    if (!re) return []
    const pairs = findAll(pt.norm, re, 10_000)
    const hits: FindHit[] = []
    for (let j = 0; j < pairs.length; j += 2) {
      const rects = textMatchRects(pt, pairs[j], pairs[j + 1])
      if (!rects.length) continue
      const x0 = Math.min(...rects.map((r) => r.x))
      const y0 = Math.min(...rects.map((r) => r.y))
      const x1 = Math.max(...rects.map((r) => r.x + r.w))
      const y1 = Math.max(...rects.map((r) => r.y + r.h))
      hits.push({ page: 0, box: fromTopLeft({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, height) })
    }
    return hits
  }
}

/** Find scores of the GT words on page 0 of `bytes`. */
async function scores(s: SynthResult, bytes: Uint8Array): Promise<FindScores> {
  const gt: FindGtWord[] = s.gt.words.map((w) => ({ t: w.t, box: w.box, page: 0 }))
  const pt = await pageText(bytes)
  return findScores(gt, searchOf(pt, s.gt.page.height), { fold: normalizeQuery })
}

/** `bytes` with the guard taken out of every OCR font's /W (the pre-fix font, as a control). */
async function withoutGuard(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue
    if (obj.get(PDFName.of('Subtype')) !== PDFName.of('CIDFontType2')) continue
    const w = obj.lookup(PDFName.of('W'), PDFArray)
    expect(String(w.get(0))).toBe(String(MONO_GUARD_CID))
    obj.set(PDFName.of('W'), doc.context.obj(w.asArray().slice(2)))
  }
  return doc.save({ useObjectStreams: false })
}

describe.each(PRESETS)('after export, %s (seed 7)', (preset) => {
  let s: SynthResult
  let baked: Uint8Array
  beforeAll(async () => {
    s = await synth(preset)
    baked = (await bakeLayer(s.pdfBytes, [ocrPageFromGt(s.gt)])).bytes
  })

  it('pdf.js does not report the layer font monospace (it did without the guard)', async () => {
    expect(await fontFamilies(baked)).not.toContain('monospace')
    expect((await pageText(baked)).items.some((i) => i.mono)).toBe(false)
    const unguarded = await withoutGuard(baked)
    expect(await fontFamilies(unguarded)).toContain('monospace')
    expect((await pageText(unguarded)).items.some((i) => i.mono)).toBe(true)
  })

  it('the Find gate: every GT word found on its own box, hit-on-target ≥ 0.95', async () => {
    const sc = await scores(s, baked)
    expect(sc.eligible).toBeGreaterThan(20)
    expect(sc.words.filter((w) => !w.found).map((w) => w.query)).toEqual([])
    expect(sc.recall).toBe(1)
    expect(sc.hitOnTarget).toBeGreaterThanOrEqual(HIT_ON_TARGET)
  })

  it('the guard leaks nothing and paints nothing', async () => {
    // The oracle's rule-5 check allows CID 0 only as the guard: every other CID a font table
    // describes is shown on the page. No pixel differs from the bare scan, and the text is exact.
    const kept = s.gt.words.map((w) => w.t)
    const none = { words: [], uniqueCps: uniqueCodePoints(['§¶'], kept) }
    expect(await rawLeaks(baked, none)).toEqual([])
    expect(raster(baked, 72).data).toEqual(raster(s.pdfBytes, 72).data)
    expect(pdfjsCopyText((await pdfjsText(baked)).items)).toBe(s.gt.text)
  })
})

it('control: without the guard the gate is missed, so the guard is what reaches it', async () => {
  const s = await synth('clean300')
  const baked = (await bakeLayer(s.pdfBytes, [ocrPageFromGt(s.gt)])).bytes
  expect((await scores(s, await withoutGuard(baked))).recall).toBeLessThan(1)
})
