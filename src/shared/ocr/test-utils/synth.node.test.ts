import { createHash } from 'node:crypto'
import fontkit from '@pdf-lib/fontkit'
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, StandardFonts } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'

import { applyAffine, invertAffine, rotateQuarter, type GreyImage } from './degrade'
import { loadNodePdfium, loadNodeSynthDeps } from './node-deps'
import {
  getPreset,
  listPresets,
  registerPreset,
  synthesize,
  toOutputFrame,
  toSourceFrame,
  type FontId,
  type SynthDeps,
  type SynthResult
} from './synth'
import type { Box } from './metrics'

let deps: SynthDeps
beforeAll(async () => {
  deps = await loadNodeSynthDeps()
})

const memo = new Map<string, Promise<SynthResult>>()
function synth(preset: string, seed = 1, font?: FontId): Promise<SynthResult> {
  const key = `${preset}/${seed}/${font ?? ''}`
  let p = memo.get(key)
  if (!p) {
    p = synthesize({ preset, seed, font }, deps)
    memo.set(key, p)
  }
  return p
}

const sha256 = (img: GreyImage): string =>
  createHash('sha256').update(`${img.width}x${img.height}:`).update(img.data).digest('hex')

const PR1_PRESETS = [
  'clean300',
  'skew2',
  'blur1',
  'noise',
  'jpeg35',
  'fax200',
  'low150',
  'rot90page',
  'rot180page',
  'twocol',
  'photoLike',
  'smallprint6pt',
  'numbers-table',
  'latin-diacritics'
]

const EPS = 1e-6
const close = (a: Box, b: Box, eps = 1e-6): boolean =>
  Math.abs(a.x - b.x) < eps &&
  Math.abs(a.y - b.y) < eps &&
  Math.abs(a.w - b.w) < eps &&
  Math.abs(a.h - b.h) < eps

describe('preset registry', () => {
  it('has every PR1 preset, ~1.3 MP crops', () => {
    for (const id of PR1_PRESETS) {
      const def = getPreset(id)
      const mp = ((def.page.width * def.renderDpi) / 72) * ((def.page.height * def.renderDpi) / 72)
      expect(mp).toBeGreaterThan(1e6)
      expect(mp).toBeLessThan(1.7e6)
    }
    expect(listPresets()).toEqual(expect.arrayContaining(PR1_PRESETS))
  })

  it('accepts new presets and refuses duplicates', async () => {
    registerPreset({
      id: 'test-tiny',
      description: 'one line',
      font: 'courier',
      page: { width: 144, height: 72 },
      renderDpi: 150,
      layout: (ctx) => ctx.line(['tiny', 'test'], 6, 40, 10),
      ops: [{ op: 'resample', dpi: 75 }]
    })
    expect(() => registerPreset({ ...getPreset('test-tiny') })).toThrow(/already/)
    const r = await synthesize({ preset: 'test-tiny', seed: 0 }, deps)
    expect(r.gt.text).toBe('tiny test')
    expect(r.gt.dpi).toBe(75)
    expect(r.raster.width).toBe(150)
    expect(r.gt.page).toEqual({ width: 144, height: 72 })
    expect(r.gt.words.map((w) => w.t)).toEqual(['tiny', 'test'])
  })

  it('rejects fonts that do not cover the preset text and bad seeds', async () => {
    await expect(
      synthesize({ preset: 'latin-diacritics', seed: 1, font: 'helvetica' }, deps)
    ).rejects.toThrow(/does not support/)
    await expect(synthesize({ preset: 'clean300', seed: 1.5 }, deps)).rejects.toThrow(/seed/)
    // DejaVu Sans Mono has no "ở": it would draw .notdef under GT text that says "ở".
    await expect(
      synthesize({ preset: 'latin-diacritics', seed: 1, font: 'dejavu-mono' }, deps)
    ).rejects.toThrow(/does not support/)
    registerPreset({
      id: 'test-missing-glyph',
      description: 'a word the font cannot draw',
      font: 'dejavu-mono',
      page: { width: 144, height: 72 },
      renderDpi: 150,
      layout: (ctx) => ctx.line(['nước', 'ở'], 6, 40, 10),
      ops: []
    })
    await expect(synthesize({ preset: 'test-missing-glyph', seed: 1 }, deps)).rejects.toThrow(
      /dejavu-mono has no glyph for "ở"/
    )
  })
})

describe('determinism', () => {
  it('same seed → identical bytes; different seed → different', async () => {
    const a = await synth('noise', 7)
    const b = await synthesize({ preset: 'noise', seed: 7 }, deps)
    expect(Buffer.from(b.pdfBytes).equals(Buffer.from(a.pdfBytes))).toBe(true)
    expect(Buffer.from(b.raster.data).equals(Buffer.from(a.raster.data))).toBe(true)
    expect(Buffer.from(b.vectorPdf).equals(Buffer.from(a.vectorPdf))).toBe(true)
    expect(JSON.stringify(b.gt)).toBe(JSON.stringify(a.gt))
    const c = await synth('noise', 8)
    expect(Buffer.from(c.raster.data).equals(Buffer.from(a.raster.data))).toBe(false)
    expect(Buffer.from(c.pdfBytes).equals(Buffer.from(a.pdfBytes))).toBe(false)
    expect(c.gt.text).not.toBe(a.gt.text) // the seed also picks the text order
  })

  it('the seed reaches the degradation streams, not only the text', async () => {
    // Fixed text (no seeded bank), so any raster difference between seeds comes from the ops.
    registerPreset({
      id: 'test-fixed-noise',
      description: 'fixed line + noise + salt-and-pepper',
      font: 'helvetica',
      page: { width: 144, height: 72 },
      renderDpi: 150,
      layout: (ctx) => ctx.line(['fixed', 'text'], 6, 40, 10),
      ops: [
        { op: 'noise', sigma: 12 },
        { op: 'saltPepper', p: 0.01 }
      ]
    })
    const a = await synthesize({ preset: 'test-fixed-noise', seed: 1 }, deps)
    const b = await synthesize({ preset: 'test-fixed-noise', seed: 2 }, deps)
    expect(Buffer.from(b.clean.data).equals(Buffer.from(a.clean.data))).toBe(true)
    expect(JSON.stringify(b.gt.words)).toBe(JSON.stringify(a.gt.words))
    // Noise residuals over the page: most pixels differ between the two seeds.
    let differ = 0
    for (let i = 0; i < a.raster.data.length; i++)
      if (a.raster.data[i] !== b.raster.data[i]) differ++
    expect(differ / a.raster.data.length).toBeGreaterThan(0.5)
  })

  // Hash guards (DESIGN.md §3.9.1): a PDFium bump, a font change or a degrader change that moves
  // pixels must show up in review instead of silently shifting OCR baselines. These use only
  // PDFium + integer kernels (no jpeg-js), so they are expected to be identical on every OS and
  // Node version. If one changes on purpose, re-record it and say why in the PR.
  it.each([
    ['clean300', '1b5b824ca0023b137713a6ca599f75890e7e5f266302313325d5690565c34c33'],
    ['noise', '12e0637fd62b5c200fb207bd6060b9a8e1011aac2e36c6558b513304d1f2b4fc'],
    ['skew2', '5477ae710cc0d766f6e866870e348a82a881303061e03752ef19ce54d6dc0ca5'],
    ['blur1', 'e5c4d33f517b26db85813cbdcfa592270fde8178395738ae290d3495c09eccf5'],
    ['low150', '8c56a99b07333817e150bf2d1986b644636f3086419393d48414ce59f1a71627'],
    ['fax200', 'c1a854bf4ea9f8f2a565bedfdde8be635463f53634a3a8d38344016beb33c30f'],
    ['photoLike', '36e9d525911d03e75980d224b65b66ec676851a97d17dc5424037cbfed9bc18c']
  ])('%s raster hash is pinned', async (preset, hash) => {
    const r = await synth(preset, 1)
    expect(sha256(r.raster)).toBe(hash)
  })

  // jpeg35 is not hash-pinned (a jpeg-js bump must not read as a determinism bug), so pin its
  // effect instead: lossy, but close to the clean page.
  it('jpeg35 really is a lossy JPEG round trip of the clean raster', async () => {
    const { raster, clean } = await synth('jpeg35', 1)
    let sum = 0
    let changed = 0
    for (let i = 0; i < raster.data.length; i++) {
      const d = Math.abs(raster.data[i] - clean.data[i])
      sum += d
      if (d > 0) changed++
    }
    const mad = sum / raster.data.length
    expect(changed / raster.data.length).toBeGreaterThan(0.05)
    expect(mad).toBeGreaterThan(MAD_JPEG35[0])
    expect(mad).toBeLessThan(MAD_JPEG35[1])
  })
})

/** jpeg35 vs its clean raster, seed 1: mean absolute difference 1.935 levels [measured], ± 30%. */
const MAD_JPEG35: [number, number] = [1.35, 2.5]

describe.each(PR1_PRESETS)('GT sanity: %s', (preset) => {
  it('words are inside the page, ordered, non-overlapping and inked', async () => {
    const { gt, raster } = await synth(preset, 1)
    expect(gt.words.length).toBeGreaterThan(8)
    expect(gt.raster).toEqual({ width: raster.width, height: raster.height })
    expect(gt.page.width).toBeCloseTo((raster.width * 72) / gt.dpi, 9)
    expect(gt.page.height).toBeCloseTo((raster.height * 72) / gt.dpi, 9)
    for (const w of gt.words) {
      expect(w.box.x).toBeGreaterThanOrEqual(-EPS)
      expect(w.box.y).toBeGreaterThanOrEqual(-EPS)
      expect(w.box.x + w.box.w).toBeLessThanOrEqual(gt.page.width + EPS)
      expect(w.box.y + w.box.h).toBeLessThanOrEqual(gt.page.height + EPS)
      expect(w.srcInk, `no ink under "${w.t}"`).not.toBeNull()
      expect(w.t).toBe(w.t.normalize('NFC'))
      expect(w.t).not.toMatch(/\s/)
    }
    gt.words.forEach((w, i) => expect(w.order).toBe(i))
    // Lines: words left to right (source frame), indices contiguous in reading order.
    let next = 0
    gt.lines.forEach((line, li) => {
      for (const wi of line.words) {
        expect(wi).toBe(next++)
        expect(gt.words[wi].line).toBe(li)
      }
      for (let k = 1; k < line.words.length; k++) {
        const a = gt.words[line.words[k - 1]].srcBox
        const b = gt.words[line.words[k]].srcBox
        expect(b.x).toBeGreaterThan(a.x + a.w)
      }
      expect(line.text).toBe(line.words.map((i) => gt.words[i].t).join(' '))
    })
    expect(next).toBe(gt.words.length)
    expect(gt.text).toBe(gt.lines.map((l) => l.text).join('\n'))
    // No two word boxes overlap (source frame; output quads are a rigid map of these).
    const boxes = gt.words.map((w) => w.srcBox)
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        if (ix > EPS && iy > EPS) throw new Error(`"${gt.words[i].t}" overlaps "${gt.words[j].t}"`)
      }
    // JSON-serialisable without loss.
    expect(JSON.parse(JSON.stringify(gt))).toEqual(gt)
  })
})

describe('GT frames', () => {
  it('rot90page: (X, Y) → (H − Y, X), and the raster is the clean raster turned once', async () => {
    const up = await synth('clean300', 1)
    const rot = await synth('rot90page', 1)
    const H = up.gt.sourcePage.height
    expect(rot.gt.page).toEqual({ width: up.gt.page.height, height: up.gt.page.width })
    expect(
      Buffer.from(rot.raster.data).equals(Buffer.from(rotateQuarter(up.raster, 1).image.data))
    ).toBe(true)
    rot.gt.words.forEach((w, i) => {
      const s = up.gt.words[i].srcBox
      expect(w.t).toBe(up.gt.words[i].t)
      expect(close(w.box, { x: H - s.y - s.h, y: s.x, w: s.h, h: s.w }, 1e-9)).toBe(true)
      expect(close(toSourceFrame(rot.gt, w.box).box, s, 1e-9)).toBe(true)
    })
  })

  it('rot180page: (X, Y) → (W − X, H − Y)', async () => {
    const { gt } = await synth('rot180page', 1)
    const { width: W, height: H } = gt.sourcePage
    for (const w of gt.words) {
      const s = w.srcBox
      expect(close(w.box, { x: W - s.x - s.w, y: H - s.y - s.h, w: s.w, h: s.h }, 1e-9)).toBe(true)
    }
  })

  it('skew2: quads are the source boxes tilted 2° CCW about the page centre', async () => {
    const { gt } = await synth('skew2', 1)
    const cx = gt.page.width / 2
    const cy = gt.page.height / 2
    // The true cos/sin of 2°; the kernel's Q16 quantisation moves points by < 0.005 pt here.
    const cos2 = 0.9993908270190958
    const sin2 = 0.03489949670250097
    for (const w of gt.words) {
      const [ll] = w.quad
      const dx = w.srcBox.x - cx
      const dy = w.srcBox.y - cy
      // Bottom-left frame, CCW: (dx, dy) → (dx·cos − dy·sin, dx·sin + dy·cos).
      expect(ll.x).toBeCloseTo(cx + dx * cos2 - dy * sin2, 2)
      expect(ll.y).toBeCloseTo(cy + dx * sin2 + dy * cos2, 2)
      // Round trip through the helper (exact to rounding).
      const back = invertAffine(gt.toOutput)
      const [sx, sy] = applyAffine(back, ll.x, ll.y)
      expect(sx).toBeCloseTo(w.srcBox.x, 9)
      expect(sy).toBeCloseTo(w.srcBox.y, 9)
      expect(close(toOutputFrame(gt, w.srcBox).box, w.box, 1e-9)).toBe(true)
    }
  })

  it('fax200 and low150 scale the frame exactly; the page size is unchanged', async () => {
    for (const [preset, dpi] of [
      ['fax200', 200],
      ['low150', 150]
    ] as const) {
      const { gt, raster } = await synth(preset, 1)
      expect(gt.dpi).toBe(dpi)
      expect(raster.width).toBe((432 * dpi) / 72)
      expect(gt.page).toEqual(gt.sourcePage)
      for (const w of gt.words) expect(close(w.box, w.srcBox, 1e-9)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// GT geometry, checked against sources independent of synth.ts: the fonts' own metrics, PDFium's
// text layout of the vector page, and the clean raster's pixels. Every font, several seeds.

/** AFM Ascender / Descender of the Standard-14 fonts (Adobe Core14 AFMs, units of 1/1000 em). */
const AFM_VMETRICS: Record<'helvetica' | 'times' | 'courier', [number, number]> = {
  helvetica: [718, -207],
  times: [683, -217],
  courier: [629, -157]
}
const STD_NAMES = {
  helvetica: StandardFonts.Helvetica,
  times: StandardFonts.TimesRoman,
  courier: StandardFonts.Courier
}
const DEJAVU: FontId[] = ['dejavu-sans', 'dejavu-serif', 'dejavu-mono']
const ALL_FONTS: FontId[] = ['helvetica', 'times', 'courier', ...DEJAVU]

/** [preset, seed, font] runs the geometry checks cover. */
const GEOMETRY_RUNS: [string, number, FontId][] = [
  ...ALL_FONTS.flatMap((f) =>
    [1, 2, 3].map((seed): [string, number, FontId] => ['clean300', seed, f])
  ),
  ['latin-diacritics', 1, 'dejavu-sans'],
  ['latin-diacritics', 1, 'dejavu-serif']
]

interface FontOracle {
  /** Ascent and descent as fractions of the em (both positive). */
  ascent: number
  descent: number
  /** Advance of one character in em fractions, as the font file / AFM defines it (no kerning). */
  advance(ch: string): number
}

async function fontOracle(id: FontId): Promise<FontOracle> {
  if (id === 'helvetica' || id === 'times' || id === 'courier') {
    const [a, d] = AFM_VMETRICS[id]
    // A single glyph's width: pdf-lib's AFM WX with no pair to kern against.
    const font = await (await PDFDocument.create()).embedFont(STD_NAMES[id])
    return { ascent: a / 1000, descent: -d / 1000, advance: (ch) => font.widthOfTextAtSize(ch, 1) }
  }
  const f = fontkit.create(deps.fontBytes(id as 'dejavu-sans'))
  return {
    ascent: f.ascent / f.unitsPerEm,
    descent: -f.descent / f.unitsPerEm,
    // The cmap glyph's hmtx advance (no shaping, no GPOS kerning).
    advance: (ch) => f.glyphForCodePoint(ch.codePointAt(0)!).advanceWidth / f.unitsPerEm
  }
}

interface PdfiumTextModule {
  FPDF_LoadMemDocument(ptr: number, size: number, password: string): number
  FPDF_CloseDocument(doc: number): void
  FPDF_LoadPage(doc: number, index: number): number
  FPDF_ClosePage(page: number): void
  FPDFText_LoadPage(page: number): number
  FPDFText_ClosePage(tp: number): void
  FPDFText_CountChars(tp: number): number
  FPDFText_GetUnicode(tp: number, i: number): number
  FPDFText_IsGenerated(tp: number, i: number): number
  FPDFText_GetCharOrigin(tp: number, i: number, x: number, y: number): boolean
  pdfium: { HEAPU8: Uint8Array; wasmExports: { malloc(n: number): number; free(p: number): void } }
}

/** PDFium's own text layout of page 0: each drawn (non-generated, non-space) char and its origin. */
async function pdfiumGlyphs(pdf: Uint8Array): Promise<{ ch: string; x: number; y: number }[]> {
  const mod = (await loadNodePdfium()) as unknown as PdfiumTextModule
  const rt = mod.pdfium
  const ptr = rt.wasmExports.malloc(pdf.length)
  const xy = rt.wasmExports.malloc(16)
  rt.HEAPU8.set(pdf, ptr)
  const doc = mod.FPDF_LoadMemDocument(ptr, pdf.length, '')
  const page = mod.FPDF_LoadPage(doc, 0)
  const tp = mod.FPDFText_LoadPage(page)
  const out: { ch: string; x: number; y: number }[] = []
  try {
    for (let i = 0, n = mod.FPDFText_CountChars(tp); i < n; i++) {
      const ch = String.fromCodePoint(mod.FPDFText_GetUnicode(tp, i))
      if (mod.FPDFText_IsGenerated(tp, i) || /\s/.test(ch)) continue
      expect(mod.FPDFText_GetCharOrigin(tp, i, xy, xy + 8)).toBe(true)
      const [x, y] = new Float64Array(rt.HEAPU8.buffer, xy, 2)
      out.push({ ch, x, y })
    }
  } finally {
    mod.FPDFText_ClosePage(tp)
    mod.FPDF_ClosePage(page)
    mod.FPDF_CloseDocument(doc)
    rt.wasmExports.free(xy)
    rt.wasmExports.free(ptr)
  }
  return out
}

/** A source-frame box → its pixel edges on the clean raster (top-left origin, continuous). */
function pxEdges(b: Box, s: number, H: number): { l: number; r: number; t: number; b: number } {
  return { l: b.x * s, r: (b.x + b.w) * s, t: (H - b.y - b.h) * s, b: (H - b.y) * s }
}

describe.each(GEOMETRY_RUNS)('GT geometry: %s seed %i in %s', (preset, seed, font) => {
  it('word boxes are the font’s advance × ascent..descent (its own metrics, no kerning)', async () => {
    const { gt } = await synth(preset, seed, font)
    const o = await fontOracle(font)
    for (const line of gt.lines)
      for (const wi of line.words) {
        const { srcBox: b, t } = gt.words[wi]
        let adv = 0
        for (const ch of t) adv += o.advance(ch)
        expect(b.y, t).toBeCloseTo(line.baseline - o.descent * line.size, 9)
        expect(b.h, t).toBeCloseTo((o.ascent + o.descent) * line.size, 9)
        expect(b.w, t).toBeCloseTo(adv * line.size, 9)
      }
  })

  it('PDFium places every glyph where the GT advances say (drawText does not kern)', async () => {
    const { gt, vectorPdf } = await synth(preset, seed, font)
    const o = await fontOracle(font)
    const glyphs = await pdfiumGlyphs(vectorPdf)
    expect(glyphs.map((g) => g.ch).join('')).toBe(gt.words.map((w) => w.t).join(''))
    let k = 0
    const problems: string[] = []
    for (const line of gt.lines)
      for (const wi of line.words) {
        const w = gt.words[wi]
        let x = w.srcBox.x
        let i = 0
        for (const ch of w.t) {
          const g = glyphs[k++]
          // PDFium keeps CID widths as whole 1/1000 em, so the i-th glyph of a DejaVu word may sit
          // up to i/1000 em from the exact sum (≤ 0.1 pt here). A kerning pair is 15–100/1000 em,
          // and PDFium would show it from the glyph after the pair onwards.
          const tol = (i * line.size) / 1000 + 1e-3
          if (Math.abs(g.x - x) > tol || Math.abs(g.y - line.baseline) > 1e-3)
            problems.push(
              `${w.t}[${i}] ${ch}: PDFium (${g.x}, ${g.y}), GT (${x}, ${line.baseline})`
            )
          x += o.advance(ch) * line.size
          i++
        }
        expect(x).toBeCloseTo(w.srcBox.x + w.srcBox.w, 9)
      }
    expect(problems).toEqual([])
  })

  it('the ink sits in the em boxes: every word’s own ink, and no ink outside all of them', async () => {
    const { clean, gt } = await synth(preset, seed, font)
    const s = gt.renderDpi / 72
    const H = gt.sourcePage.height
    // Glyphs may overshoot the em box a little (round tops above the AFM ascender, 'f'/'j' past
    // their advance): 2 px vertically, 5 px horizontally. The old DejaVu ascent was 11 px short.
    const PAD_V = 2
    const PAD_H = 5
    const inside = new Uint8Array(clean.width * clean.height)
    for (const w of gt.words) {
      const e = pxEdges(w.srcBox, s, H)
      const x0 = Math.max(0, Math.floor(e.l) - PAD_H)
      const x1 = Math.min(clean.width, Math.ceil(e.r) + PAD_H)
      const y0 = Math.max(0, Math.floor(e.t) - PAD_V)
      const y1 = Math.min(clean.height, Math.ceil(e.b) + PAD_V)
      for (let y = y0; y < y1; y++) inside.fill(1, y * clean.width + x0, y * clean.width + x1)
      // This word's own ink, in a window 0.75 pt around its box (less than half of every line
      // gap and word space here), must lie within the box ± the pads.
      const m = Math.round(0.75 * s)
      let top = Infinity
      let bottom = -Infinity
      for (let y = Math.max(0, Math.floor(e.t) - m); y < Math.min(clean.height, e.b + m); y++)
        for (let x = Math.floor(e.l); x < Math.ceil(e.r); x++)
          if (clean.data[y * clean.width + x] < 128) {
            top = Math.min(top, y)
            bottom = Math.max(bottom, y + 1)
          }
      expect(top, `${w.t} ink above its box`).toBeGreaterThanOrEqual(e.t - PAD_V)
      expect(bottom, `${w.t} ink below its box`).toBeLessThanOrEqual(e.b + PAD_V)
    }
    let dark = 0
    let outside = 0
    for (let i = 0; i < clean.data.length; i++)
      if (clean.data[i] < 128) {
        dark++
        if (!inside[i]) outside++
      }
    expect(dark).toBeGreaterThan(5000)
    expect(outside).toBe(0)
  })

  it('srcInk is exactly the dark-pixel bounds inside the box (contains them all, touches each)', async () => {
    const { clean, gt } = await synth(preset, seed, font)
    const s = gt.renderDpi / 72
    const H = gt.sourcePage.height
    const tol = 1e-6
    const problems: string[] = []
    for (const w of gt.words) {
      const box = pxEdges(w.srcBox, s, H)
      const ink = pxEdges(w.srcInk!, s, H)
      // Each dark pixel's extent, clipped to the box (srcInk is clipped to srcBox), must lie in
      // srcInk, and each of srcInk's four edges must be reached by some dark pixel.
      const touch = { l: false, r: false, t: false, b: false }
      let outside = 0
      for (let y = Math.floor(box.t); y < Math.ceil(box.b); y++)
        for (let x = Math.floor(box.l); x < Math.ceil(box.r); x++) {
          if (clean.data[y * clean.width + x] >= 128) continue
          const pl = Math.max(x, box.l)
          const pr = Math.min(x + 1, box.r)
          const pt = Math.max(y, box.t)
          const pb = Math.min(y + 1, box.b)
          if (pl < ink.l - tol || pr > ink.r + tol || pt < ink.t - tol || pb > ink.b + tol)
            outside++
          if (Math.abs(pl - ink.l) < tol) touch.l = true
          if (Math.abs(pr - ink.r) < tol) touch.r = true
          if (Math.abs(pt - ink.t) < tol) touch.t = true
          if (Math.abs(pb - ink.b) < tol) touch.b = true
        }
      if (outside > 0) problems.push(`${w.t}: ${outside} dark px outside srcInk`)
      if (!(touch.l && touch.r && touch.t && touch.b))
        problems.push(`${w.t}: srcInk not tight ${JSON.stringify(touch)}`)
      if (!close(w.ink!, toOutputFrame(gt, w.srcInk!).box, 1e-9)) problems.push(`${w.t}: ink`)
    }
    expect(problems).toEqual([])
  })
})

describe('scanned PDF', () => {
  async function imageOf(bytes: Uint8Array): Promise<{ bpc: number; w: number; h: number }> {
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
    const xobjs = doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict)
    const stream = doc.context.lookup(xobjs.values()[0])
    if (!(stream instanceof PDFRawStream)) throw new Error('image XObject is not a raw stream')
    const num = (k: string): number => (stream.dict.get(PDFName.of(k)) as PDFNumber).asNumber()
    return { bpc: num('BitsPerComponent'), w: num('Width'), h: num('Height') }
  }

  // Every preset, so both the 8 bpc and the packed 1 bpc paths (fax200) are read back by a real
  // PDF renderer: a negative or bit-scrambled 1 bpc image must not pass on its metadata alone.
  it.each(PR1_PRESETS)(
    '%s: one page-filling grey image PDFium renders back to the raster',
    async (preset) => {
      const { pdfBytes, raster, gt } = await synth(preset, 1)
      const binary = raster.data.every((v) => v === 0 || v === 255)
      expect(await imageOf(pdfBytes)).toEqual({
        bpc: binary ? 1 : 8,
        w: raster.width,
        h: raster.height
      })
      const doc = await PDFDocument.load(pdfBytes)
      const { width, height } = doc.getPage(0).getSize()
      expect(width).toBeCloseTo(gt.page.width, 6)
      expect(height).toBeCloseTo(gt.page.height, 6)
      const back = deps.rasterize(pdfBytes, gt.dpi)
      expect(back.width).toBe(raster.width)
      expect(back.height).toBe(raster.height)
      let maxDiff = 0
      for (let i = 0; i < back.data.length; i++)
        maxDiff = Math.max(maxDiff, Math.abs(back.data[i] - raster.data[i]))
      expect(maxDiff).toBeLessThanOrEqual(1)
    }
  )

  it('stores binarised rasters at 1 bpc', async () => {
    const { pdfBytes, raster } = await synth('fax200', 1)
    expect(raster.data.every((v) => v === 0 || v === 255)).toBe(true)
    expect(await imageOf(pdfBytes)).toEqual({ bpc: 1, w: 1200, h: 500 })
  })
})

describe('content', () => {
  it('latin-diacritics carries all six languages in NFC', async () => {
    const { gt } = await synth('latin-diacritics', 1)
    for (const s of ['Größe', 'cœur', 'añadió', 'świeże', 'přivezl', 'Người', 'đọc'])
      expect(gt.text).toContain(s)
    expect(gt.font).toBe('dejavu-sans')
  })

  it('numbers-table has 28 cells with dates, amounts and confusable IDs', async () => {
    const { gt } = await synth('numbers-table', 1)
    expect(gt.lines).toHaveLength(28)
    expect(gt.lines.slice(0, 4).map((l) => l.text)).toEqual(['Invoice', 'Date', 'Amount', 'Code'])
    expect(gt.text).toMatch(/INV-[0O1lI2-9]{5}/)
    expect(gt.text).toMatch(/(\$[\d,]+\.\d\d|€ [\d.]+,\d\d)/)
  })

  it('twocol reads column 1 top to bottom, then column 2', async () => {
    const { gt } = await synth('twocol', 1)
    const firstX = gt.lines.map((l) => gt.words[l.words[0]].srcBox.x)
    const switchAt = firstX.findIndex((x) => x > 200)
    expect(switchAt).toBeGreaterThan(4)
    expect(firstX.slice(switchAt).every((x) => x > 200)).toBe(true)
    expect(firstX.slice(0, switchAt).every((x) => x < 200)).toBe(true)
  })

  it.each(['times', 'courier', 'dejavu-serif', 'dejavu-mono'] as FontId[])(
    'clean300 renders in %s',
    async (font) => {
      const { gt } = await synth('clean300', 3, font)
      expect(gt.font).toBe(font)
      expect(gt.words.every((w) => w.srcInk !== null)).toBe(true)
    }
  )
})
