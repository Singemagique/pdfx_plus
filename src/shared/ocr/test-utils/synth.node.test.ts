import { createHash } from 'node:crypto'
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'

import { applyAffine, invertAffine, rotateQuarter, type GreyImage } from './degrade'
import { loadNodeSynthDeps } from './node-deps'
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

  // Hash guards (DESIGN.md §3.9.1): a PDFium bump, a font change or a degrader change that moves
  // pixels must show up in review instead of silently shifting OCR baselines. These three use only
  // PDFium + integer kernels (no jpeg-js), so they are expected to be identical on every OS and
  // Node version. If one changes on purpose, re-record it and say why in the PR.
  it.each([
    ['clean300', '698067e6089c2603ab95ceb34411e3b4c25f809ff71348f15436ec72636241b8'],
    ['noise', '688aeb4fe090c2ab1d2746bc11795e05f23ab2235fe31f1f30ea11ba6359c3ae'],
    ['skew2', '47b8f6bf8c7f87a596f1bc8be328ed186a564c9dafa159846e643917e1e2bab9']
  ])('%s raster hash is pinned', async (preset, hash) => {
    const r = await synth(preset, 1)
    expect(sha256(r.raster)).toBe(hash)
  })
})

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

  it('ink lies inside the em boxes on the clean raster (GT is where the pixels are)', async () => {
    const { clean, gt } = await synth('clean300', 1)
    const s = gt.renderDpi / 72
    const H = gt.sourcePage.height
    const inside = new Uint8Array(clean.width * clean.height)
    for (const { srcBox: b } of gt.words) {
      const x0 = Math.max(0, Math.floor(b.x * s) - 1)
      const x1 = Math.min(clean.width, Math.ceil((b.x + b.w) * s) + 1)
      const y0 = Math.max(0, Math.floor((H - b.y - b.h) * s) - 1)
      const y1 = Math.min(clean.height, Math.ceil((H - b.y) * s) + 1)
      for (let y = y0; y < y1; y++) inside.fill(1, y * clean.width + x0, y * clean.width + x1)
    }
    let dark = 0
    let outside = 0
    for (let i = 0; i < clean.data.length; i++)
      if (clean.data[i] < 128) {
        dark++
        if (!inside[i]) outside++
      }
    expect(dark).toBeGreaterThan(10000)
    expect(outside).toBe(0)
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

  it('is one page-filling grey image that PDFium renders back to the raster', async () => {
    const { pdfBytes, raster, gt } = await synth('clean300', 1)
    expect(await imageOf(pdfBytes)).toEqual({ bpc: 8, w: raster.width, h: raster.height })
    const doc = await PDFDocument.load(pdfBytes)
    const { width, height } = doc.getPage(0).getSize()
    expect(width).toBeCloseTo(gt.page.width, 6)
    expect(height).toBeCloseTo(gt.page.height, 6)
    const back = deps.rasterize(pdfBytes, gt.dpi)
    expect(back.width).toBe(raster.width)
    let maxDiff = 0
    for (let i = 0; i < back.data.length; i++)
      maxDiff = Math.max(maxDiff, Math.abs(back.data[i] - raster.data[i]))
    expect(maxDiff).toBeLessThanOrEqual(1)
  })

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
