// Tier-0 layer suite (DESIGN.md §3.9.3 "layer suite detail"). Each synth page (an image-only scan
// plus exact ground truth, PR1) gets the OCR layer an ideal engine would produce (`ocrPageFromGt`),
// baked through the real append + finalize path; the saved bytes are then read back with both
// shipped extractors — pdf.js 5.7.284 `getTextContent` (the app's own search extractor) and PDFium
// (FPDFText_*, the WASM build of the engine inside Chromium) — and rendered with PDFium.
//
// Pinned to pdf.js 5.7.284 and @embedpdf/pdfium 2.14.x (R13): re-run on any upgrade.

import { createHash } from 'node:crypto'
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'

import { needsSpaceBetween } from '../../../shared/ocr/spacing'
import { loadNodeSynthDeps } from '../../../shared/ocr/test-utils/node-deps'
import {
  createPdfiumRasterizer,
  type Rasterizer
} from '../../../shared/ocr/test-utils/pdfium-raster'
import { synthesize, type SynthResult } from '../../../shared/ocr/test-utils/synth'
import { buildPageText, toItemGeom } from '../search/extract'
import { textMatchRects } from '../search/geometry'
import { loadTestPdfium } from '../test-utils/pdfium'
import type { OcrFontBBox } from './ocr-font'
import {
  allStreams,
  bakeLayer,
  boxRect,
  flowWords,
  handPage,
  iou,
  ocrPageFromGt,
  pdfiumCopyText,
  pdfiumProbe,
  pdfjsCopyText,
  pdfjsItemRect,
  pdfjsText,
  union,
  type Baked,
  type PdfiumPageProbe,
  type PdfjsText,
  type ProbePdfium,
  type Rect
} from './test-utils/ocr-layer'

/** Presets covering upright, tilted, two-column, quarter-turned, non-ASCII and tabular pages. */
const PRESETS = ['clean300', 'skew2', 'twocol', 'rot90page', 'latin-diacritics', 'numbers-table']
const UPRIGHT = new Set(['clean300', 'twocol', 'latin-diacritics', 'numbers-table'])
/** Lines not at a multiple of 90°: the layer fits words with Tc there (ocr-layer.ts `show`). */
const OBLIQUE = new Set(['skew2'])
const BBOXES: OcrFontBBox[] = ['em', 'tesseract']

interface IouGate {
  /** At least this share of the words is a hit on target (IoU > 0.5, the §3.9.4 bar). */
  share50: number
  /** At least this share of the words at IoU ≥ 0.85. */
  share85: number
}
/** The design bar (§3.9.3): every word ≥ 0.85. */
const EXACT: IouGate = { share50: 1, share85: 1 }
/**
 * Tilted pages: ≥ 95% of the words a hit on target (IoU > 0.5, the §3.9.4 bar), most at 0.85.
 * The price of keeping pdf.js copy text exact on tilted lines (ocr-layer.ts `show`). skew2 seed 7
 * [measured, PDFX_LAYER_STATS=1]: PDFium char boxes min 0.630 / median 0.885 / 70% ≥ 0.85;
 * whole-word pdf.js items min 0.809 / 93% ≥ 0.85; Find highlights min 0.355 / 99.2% > 0.5 /
 * 68% ≥ 0.85. Over skew2 + photoLike seeds 1–6, PDFium min 0.63, median 0.89, 71% ≥ 0.85.
 */
const OBLIQUE_GATE: IouGate = { share50: 0.95, share85: 0.6 }
/**
 * Find highlights on the DejaVu page: search/geometry.ts splits a pdf.js item by Helvetica widths,
 * so words in another font land off (seed 7: min 0.578 on 'le', median 0.818, 100% > 0.5, only
 * 10% ≥ 0.85 [measured]). That is the estimator, not the layer: the PDFium char boxes and the
 * pdf.js items on the same page pass EXACT.
 */
const DEJAVU_FIND_GATE: IouGate = { share50: 0.95, share85: 0 }

function expectIous(ious: { t: string; v: number }[], gate: IouGate): void {
  const share = (bar: number): number => ious.filter((i) => i.v >= bar).length / ious.length
  if (process.env.PDFX_LAYER_STATS) {
    const v = ious.map((i) => i.v).sort((a, b) => a - b)
    const line = `min ${v[0].toFixed(3)} p10 ${v[Math.floor(v.length / 10)].toFixed(3)} median ${v[v.length >> 1].toFixed(3)} >0.5 ${share(0.5000001).toFixed(3)} >=0.85 ${share(0.85).toFixed(3)} n ${v.length}` // prettier-ignore
    console.log(`STATS ${expect.getState().currentTestName} :: ${line}`)
  }
  if (gate.share50 === 1 && gate.share85 === 1)
    for (const { t, v } of ious) expect(v, t).toBeGreaterThanOrEqual(0.85)
  expect(share(0.5000001)).toBeGreaterThanOrEqual(gate.share50)
  expect(share(0.85)).toBeGreaterThanOrEqual(gate.share85)
}
/** Render resolution of the pixel-identity checks. */
const DPI = 96

let pdfium: ProbePdfium
let raster: Rasterizer
const synthCache = new Map<string, Promise<SynthResult>>()

beforeAll(async () => {
  pdfium = await loadTestPdfium<ProbePdfium>()
  raster = createPdfiumRasterizer(pdfium as never)
})

async function synth(preset: string): Promise<SynthResult> {
  let p = synthCache.get(preset)
  if (!p) {
    p = loadNodeSynthDeps().then((deps) => synthesize({ preset, seed: 7 }, deps))
    synthCache.set(preset, p)
  }
  return p
}

const gtRect = (b: { x: number; y: number; w: number; h: number }): Rect => ({
  x0: b.x,
  y0: b.y,
  x1: b.x + b.w,
  y1: b.y + b.h
})

/** The char boxes PDFium reports for each GT word, in content order (spaces skipped). */
function pdfiumWordChars(probe: PdfiumPageProbe, words: readonly { t: string }[]): Rect[][] {
  const solid = probe.chars.filter((c) => !c.generated && c.ch !== ' ')
  let k = 0
  return words.map((w) => {
    const n = [...w.t].length
    const chars = solid.slice(k, k + n)
    expect(chars.map((c) => c.ch).join('')).toBe(w.t)
    k += n
    return chars.map((c) => boxRect(c.box))
  })
}

const pdfiumWordRects = (probe: PdfiumPageProbe, words: readonly { t: string }[]): Rect[] =>
  pdfiumWordChars(probe, words).map(union)

/**
 * Each GT word's Find highlight over the pdf.js items — exactly what the app draws for a hit on a
 * reopened OCR'd PDF (search/extract.ts + search/geometry.ts) — in the overlay frame.
 */
function findWordRects(text: PdfjsText, words: readonly { t: string }[]): Rect[] {
  const pt = buildPageText(
    text.items.map((it) =>
      toItemGeom(
        {
          str: it.str,
          transform: it.transform,
          width: it.width,
          height: it.height,
          hasEOL: it.hasEOL
        },
        { ascent: it.ascent, descent: it.descent }
      )
    ),
    text.vt
  )
  const raw = text.items.map((it) => it.str).join('')
  let cursor = 0
  return words.map((w) => {
    const start = raw.indexOf(w.t, cursor)
    expect(start, w.t).toBeGreaterThanOrEqual(0)
    const end = start + w.t.length
    cursor = end
    let ns = -1
    let ne = -1
    for (let i = 0; i < pt.srcStart.length; i++)
      if (pt.srcStart[i] >= start && pt.srcStart[i] < end) {
        if (ns < 0) ns = i
        ne = i + 1
      }
    const rects = textMatchRects(pt, ns, ne)
    return union(rects.map((r) => ({ x0: r.x, y0: text.height - r.y - r.h, x1: r.x + r.w, y1: text.height - r.y }))) // prettier-ignore
  })
}

/** Rotate a rect's corners by −angle and take the bounding box (a line's own frame). */
function derotate(r: Rect, angle: number): Rect {
  const c = Math.cos(-angle)
  const s = Math.sin(-angle)
  const pts = [
    [r.x0, r.y0],
    [r.x1, r.y0],
    [r.x0, r.y1],
    [r.x1, r.y1]
  ].map(([x, y]) => [x * c - y * s, x * s + y * c])
  return {
    x0: Math.min(...pts.map((p) => p[0])),
    y0: Math.min(...pts.map((p) => p[1])),
    x1: Math.max(...pts.map((p) => p[0])),
    y1: Math.max(...pts.map((p) => p[1]))
  }
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1

async function imageHashes(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const out: string[] = []
  for (const [, obj] of doc.context.enumerateIndirectObjects())
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'))
      out.push(createHash('sha256').update(obj.getContents()).digest('hex'))
  return out.sort()
}

/** ToUnicode CMaps of a saved PDF: every bfchar block size and every source CID. */
async function toUnicodeStats(bytes: Uint8Array): Promise<{ blocks: number[]; cids: number[] }> {
  const blocks: number[] = []
  const cids: number[] = []
  for (const { data } of await allStreams(bytes)) {
    const text = new TextDecoder('latin1').decode(data)
    if (!text.includes('begincmap')) continue
    for (const m of text.matchAll(/(\d+) beginbfchar\n([\s\S]*?)endbfchar/g)) {
      blocks.push(Number(m[1]))
      for (const row of m[2].trim().split('\n')) cids.push(parseInt(row.slice(1, 5), 16))
    }
  }
  return { blocks, cids }
}

describe.each(BBOXES)('layer suite (FontBBox %s)', (bbox) => {
  describe.each(PRESETS)('%s', (preset) => {
    let s: SynthResult
    let baked: Baked
    let pj: PdfjsText
    let pf: PdfiumPageProbe

    beforeAll(async () => {
      s = await synth(preset)
      baked = await bakeLayer(s.pdfBytes, [ocrPageFromGt(s.gt)], { bbox })
      pj = await pdfjsText(baked.bytes)
      pf = pdfiumProbe(pdfium, baked.bytes)
    })

    it('writes 3 Tr in every BT, Tz before every Tj, and never CID 0', () => {
      const ops = baked.content.trim().split('\n')
      const bts = ops.filter((o) => o.startsWith('BT'))
      expect(bts.length).toBe(s.gt.lines.length)
      for (const bt of bts) expect(bt).toMatch(/^BT 3 Tr \/FOcr [\d.]+ Tf$/)
      const tj = ops.filter((o) => o.endsWith('Tj'))
      expect(tj.length).toBeGreaterThan(s.gt.words.length)
      for (const o of tj) {
        expect(o).toMatch(/ Tz (-?[\d.]+ Tc )?<[0-9A-F]+> Tj$/)
        const hex = /<([0-9A-F]+)> Tj$/.exec(o)![1]
        for (let i = 0; i < hex.length; i += 4) expect(hex.slice(i, i + 4)).not.toBe('0000')
      }
    })

    it('renders pixel-identical with and without the layer (PDFium)', () => {
      expect(raster(baked.bytes, DPI).data).toEqual(raster(s.pdfBytes, DPI).data)
    })

    it('paints nothing on its own even with 3 Tr patched to 0 Tr', async () => {
      const visible = await bakeLayer(s.pdfBytes, [ocrPageFromGt(s.gt)], {
        bbox,
        renderMode: 0,
        layerOnly: true
      })
      expect(visible.content).toContain(' 0 Tr ')
      expect(visible.content).not.toContain(' 3 Tr ')
      const img = raster(visible.bytes, DPI)
      expect(img.data.every((v) => v === 255)).toBe(true)
    })

    it('pdf.js copy text equals the GT exactly (single spaces, one line break per line)', () => {
      if (preset === 'numbers-table') {
        // Cells on one row share a baseline, so pdf.js (rightly) reads a row as one line; the GT
        // calls every cell a line. Compare row-joined text instead.
        expect(pdfjsCopyText(pj.items).replace(/\s+/g, ' ')).toBe(s.gt.text.replace(/\s+/g, ' '))
        return
      }
      expect(pdfjsCopyText(pj.items)).toBe(s.gt.text)
    })

    it('PDFium text equals the GT; generated chars are line breaks only; OCR chars are mode 3', () => {
      for (const c of pf.chars) {
        if (c.generated) expect(['\r', '\n', ' '], JSON.stringify(c.ch)).toContain(c.ch)
        else expect(c.mode).toBe(3)
      }
      // No generated space anywhere: every word gap is our own U+0020.
      expect(pf.chars.filter((c) => c.generated && c.ch === ' ')).toEqual([])
      if (preset === 'numbers-table') {
        expect(pdfiumCopyText(pf).replace(/\s+/g, ' ')).toBe(s.gt.text.replace(/\s+/g, ' '))
        return
      }
      if (preset === 'rot90page') {
        // PDFium's line-break inference puts an EMPTY line between quarter-turned lines (its own
        // behaviour for vertical baselines, measured; upright and 2° pages get one break).
        expect(pdfiumCopyText(pf)).not.toBe(s.gt.text)
        expect(pdfiumCopyText(pf).replace(/\n{2,}/g, '\n')).toBe(s.gt.text)
        return
      }
      expect(pdfiumCopyText(pf)).toBe(s.gt.text)
    })

    it('separates words by exactly one space character', () => {
      const real = pf.chars.filter((c) => !c.generated)
      const text = real.map((c) => c.ch).join('')
      for (const l of s.gt.lines) {
        const at = text.indexOf(l.text)
        expect(at, l.text).toBeGreaterThanOrEqual(0)
      }
      expect(text).not.toMatch(/ {2}/)
    })

    it('places every word: PDFium char boxes IoU ≥ 0.85 vs GT, right edge within 15%', () => {
      const rects = pdfiumWordRects(pf, s.gt.words)
      const ious = s.gt.words.map((w, i) => {
        const gt = gtRect(w.box)
        if (UPRIGHT.has(preset))
          expect(Math.abs(rects[i].x1 - gt.x1), w.t).toBeLessThanOrEqual(0.15 * w.box.w)
        return { t: w.t, v: iou(rects[i], gt) }
      })
      expectIous(ious, OBLIQUE.has(preset) ? OBLIQUE_GATE : EXACT)
    })

    it('places every pdf.js item: IoU ≥ 0.85 vs the GT words it holds, right edge within 15%', () => {
      // pdf.js merges each layer line into ONE item (the stretched spaces leave no gap), so its
      // own geometry is per line. The item's em box must cover exactly its words.
      // On tilted lines a strongly condensed word can split into fragments (negative Tc, see
      // ocr-layer.ts); only items made of whole words are measured, and on every other page that
      // must be all of them.
      const starts: number[] = []
      let stream = ''
      for (const w of s.gt.words) {
        if (stream) stream += ' '
        starts.push(stream.length)
        stream += w.t
      }
      let cursor = 0
      let fragments = 0
      const ious: { t: string; v: number }[] = []
      for (const it of pj.items) {
        const str = it.str.trim()
        if (!str) continue
        const a = stream.indexOf(str, cursor)
        expect(a, str).toBeGreaterThanOrEqual(0)
        expect(stream.slice(cursor, a).trim(), str).toBe('')
        cursor = a + str.length
        const first = starts.indexOf(a)
        const last = s.gt.words.findIndex((w, i) => starts[i] + w.t.length === cursor)
        if (first < 0 || last < first) {
          fragments++
          continue
        }
        const held = s.gt.words.slice(first, last + 1)
        const gt = union(held.map((w) => gtRect(w.box)))
        // (The item's advance includes the line's trailing space, 0.5 em: well inside the bars.)
        const got = pdfjsItemRect(it)
        ious.push({ t: str, v: iou(got, gt) })
        if (UPRIGHT.has(preset))
          expect(Math.abs(got.x1 - gt.x1), str).toBeLessThanOrEqual(0.15 * (gt.x1 - gt.x0))
      }
      expect(cursor).toBe(stream.length)
      if (!OBLIQUE.has(preset)) expect(fragments).toBe(0)
      expectIous(ious, OBLIQUE.has(preset) ? OBLIQUE_GATE : EXACT)
    })

    it('Find highlights over pdf.js (the app’s own geometry) hit every word: IoU ≥ 0.85', () => {
      // search/geometry.ts splits an item's advance by Helvetica widths, so the bar is met where
      // the scan was set in Helvetica; the DejaVu page measures the estimator, not the layer.
      const rects = findWordRects(pj, s.gt.words)
      const ious = s.gt.words.map((w, i) => ({ t: w.t, v: iou(rects[i], gtRect(w.box)) }))
      const gate =
        preset === 'latin-diacritics'
          ? DEJAVU_FIND_GATE
          : OBLIQUE.has(preset)
            ? OBLIQUE_GATE
            : EXACT
      expectIous(ious, gate)
    })

    it('keeps line rects apart', () => {
      // Each char box is taken into its line's own frame first: on a tilted page the AABB of a
      // whole line is far taller than the line.
      const chars = pdfiumWordChars(pf, s.gt.words)
      const angle = Math.atan2(s.gt.toOutput[1], s.gt.toOutput[0])
      const lines = s.gt.lines.map((l) =>
        union(l.words.flatMap((wi) => chars[wi].map((r) => derotate(r, angle))))
      )
      for (let i = 0; i < lines.length; i++)
        for (let j = i + 1; j < lines.length; j++)
          expect(overlaps(lines[i], lines[j]), `${i}/${j}`).toBe(false)
    })

    it('copies the scan image streams byte for byte', async () => {
      const src = await imageHashes(s.pdfBytes)
      expect(src.length).toBe(1)
      expect(await imageHashes(baked.bytes)).toEqual(src)
    })

    it('writes ToUnicode in bfchar blocks of ≤ 100 entries without CID 0', async () => {
      const { blocks, cids } = await toUnicodeStats(baked.bytes)
      expect(blocks.length).toBeGreaterThan(0)
      expect(blocks.every((b) => b > 0 && b <= 100)).toBe(true)
      expect(cids).not.toContain(0)
      expect(new Set(cids).size).toBe(cids.length)
    })
  })
})

// ---------------------------------------------------------------------------------------------
// Hand-made pages: scripts and inputs the synth corpus has no font for. The font is glyphless, so
// no Han or kana font is needed to write — or extract — their layer.

async function blankPdf(w = 400, h = 300, setup?: (doc: PDFDocument) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([w, h])
  setup?.(doc)
  return doc.save()
}

describe('hand-made pages', () => {
  it('CJK: no spaces inside a CJK run, spaces at script boundaries and between Korean words', async () => {
    const page = handPage([
      { y: 250, size: 16, x0: 20, words: flowWords(['東京都', 'の', '天気', '予報'], 16, 1) },
      { y: 220, size: 16, x0: 20, words: flowWords(['日本語', 'テキスト', 'です。'], 16, 1) },
      { y: 190, size: 16, x0: 20, words: flowWords(['PDF', '文書', 'を', '保存'], 16, 4) },
      { y: 160, size: 16, x0: 20, words: flowWords(['한국어', '텍스트', '大韓', '민국'], 16, 6) }
    ])
    // Hangul next to Han joins (a Hanja–Hangul word split in two); Hangul next to Hangul keeps
    // Korean word spacing.
    const expected = [
      '東京都の天気予報',
      '日本語テキストです。',
      'PDF 文書を保存',
      '한국어 텍스트大韓민국'
    ]
    // The rule the layer applies is the shared one.
    expect(needsSpaceBetween('大韓', '민국')).toBe(false)
    const baked = await bakeLayer(await blankPdf(), [page])
    expect(pdfjsCopyText((await pdfjsText(baked.bytes)).items)).toBe(expected.join('\n'))
    const pf = pdfiumProbe(pdfium, baked.bytes)
    expect(pf.chars.filter((c) => c.generated && c.ch === ' ')).toEqual([])
    expect(pdfiumCopyText(pf)).toBe(expected.join('\n'))
    // Wide advances: a CJK char's PDFium box is one em (16 pt) wide at Tz 100.
    const han = pf.chars.find((c) => c.ch === '東')!
    expect(han.box.r - han.box.l).toBeCloseTo(16 + 1 / 3, 0) // stretched by the 1 pt gap / 3 chars
  })

  it('expands ligature input, so both extractors return plain letters', async () => {
    const page = handPage([
      { y: 200, size: 12, x0: 20, words: flowWords(['ﬁnd', 'the', 'oﬃce', 'ﬂow'], 6, 4) }
    ])
    const baked = await bakeLayer(await blankPdf(), [page])
    expect(pdfjsCopyText((await pdfjsText(baked.bytes)).items)).toBe('find the office flow')
    expect(pdfiumCopyText(pdfiumProbe(pdfium, baked.bytes))).toBe('find the office flow')
    const { cids } = await toUnicodeStats(baked.bytes)
    expect(cids.length).toBe(new Set('find the office flow').size)
  })

  it('carries > 100 distinct characters (several bfchar blocks) and non-BMP code points', async () => {
    const chars = [...Array.from({ length: 140 }, (_, i) => String.fromCodePoint(0x4e00 + i * 7))]
    const words = ['𝐀𝐁𝐂', '😀ok', ...Array.from({ length: 14 }, (_, i) => chars.slice(i * 10, i * 10 + 10).join(''))] // prettier-ignore
    const lines = [0, 1, 2, 3].map((r) => ({
      y: 260 - r * 30,
      size: 10,
      x0: 10,
      words: flowWords(words.slice(r * 4, r * 4 + 4), 8, 8)
    }))
    const baked = await bakeLayer(await blankPdf(), [handPage(lines)])
    const { blocks, cids } = await toUnicodeStats(baked.bytes)
    // 140 Han + 𝐀𝐁𝐂 + 😀 + o, k + space = 147 distinct code points.
    expect(blocks).toEqual([100, 47])
    expect(cids.length).toBe(new Set(words.join('') + ' ').size)
    const expected = lines.map((l) => {
      let s = ''
      l.words.forEach((w, i) => {
        if (i > 0) s += needsSpaceBetween(l.words[i - 1].t, w.t) ? ' ' : ''
        s += w.t
      })
      return s
    })
    expect(pdfjsCopyText((await pdfjsText(baked.bytes)).items)).toBe(expected.join('\n'))
    expect(pdfiumCopyText(pdfiumProbe(pdfium, baked.bytes))).toBe(expected.join('\n'))
  })

  it.each([0, 90, 180, 270])(
    'lands in the overlay frame on a /Rotate %i page with an offset view box',
    async (rotate) => {
      const pdf = await blankPdf(300, 200, (doc) => {
        const p = doc.getPage(0)
        p.setMediaBox(40, 60, 300, 200)
        p.setRotation({ type: 'degrees', angle: rotate } as never)
      })
      // Overlay frame: the visual page (rotation applied), origin at its lower-left corner.
      const visualH = rotate % 180 ? 300 : 200
      const page = handPage([
        { y: visualH - 50, size: 20, x0: 30, words: flowWords(['Rotated', 'words'], 10, 10) }
      ])
      const baked = await bakeLayer(pdf, [page])
      const pj = await pdfjsText(baked.bytes)
      expect(pdfjsCopyText(pj.items)).toBe('Rotated words')
      // pdf.js reports user space; its viewport transform takes it to the visual page.
      const it0 = pj.items[0]
      const [a, b, c, d, e, f] = pj.vt
      const vx = a * it0.transform[4] + c * it0.transform[5] + e
      const vy = pj.height - (b * it0.transform[4] + d * it0.transform[5] + f)
      expect(vx).toBeCloseTo(30, 3)
      expect(vy).toBeCloseTo(visualH - 50, 3)
      expect(raster(baked.bytes, 72).data.every((v) => v === 255)).toBe(true)
    }
  )
})
