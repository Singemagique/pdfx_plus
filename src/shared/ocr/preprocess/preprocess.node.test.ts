// Tier 0 (DESIGN.md §3.9.3): preprocessing, orientation and deskew on synthetic inputs, exact.

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { scanMath } from '../../test-utils/source-scan'
import type { RawOcr } from '../engine/types'
import { looksLikePhoto, normalizeBackground } from './background'
import { BORDER_PAD, removeBorder } from './border'
import { labelComponents } from './components'
import { NOISY_PER_MP, despeckle, maxSpeck } from './despeckle'
import { applyAffine, compose, rotateBilinear, rotateQuarterCW, sinCosDeg } from './geometry'
import {
  binarize,
  boxDownscale,
  cropRows,
  histogram,
  otsu,
  packed,
  padWhite,
  resizeBilinear,
  type Gray
} from './image'
import {
  bandReading,
  plausibility,
  profileTest,
  rotationDelta,
  shouldFlip,
  type Orientation
} from './orientation'
import { findSkew } from './skew'

const blank = (w: number, h: number, v = 255): Gray => ({
  width: w,
  height: h,
  data: new Uint8Array(w * h).fill(v)
})

function fillRect(img: Gray, x0: number, y0: number, x1: number, y1: number, v = 0): void {
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++)
    img.data.fill(v, y * img.width + Math.max(0, x0), y * img.width + Math.min(img.width, x1))
}

/**
 * A text-like page: lines of "words" (dark blocks with letter gaps) between margins. Lines are
 * 12 px tall every 32 px; letters 6 px wide with 2 px gaps; words 5–9 letters, 10 px apart.
 */
function textPage(w = 640, h = 480): Gray {
  const img = blank(w, h)
  let seed = 7
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  for (let y = 48; y + 12 < h - 48; y += 32) {
    let x = 48
    while (x < w - 120) {
      const letters = 5 + Math.floor(rnd() * 5)
      for (let k = 0; k < letters; k++) {
        const tall = rnd() < 0.3 ? 4 : 0
        fillRect(img, x, y - tall, x + 6, y + 12)
        x += 8
      }
      x += 10
    }
  }
  return img
}

describe('determinism rules', () => {
  const dir = fileURLToPath(new URL('./', import.meta.url))
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  it.each(files)('%s calls no transcendental or random Math function', (f) => {
    expect(scanMath(readFileSync(dir + f, 'utf8'), f)).toEqual([])
  })
  it.each(['../calibration-fit.ts', '../calibration.ts'])('%s too', (f) => {
    expect(scanMath(readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8'), f)).toEqual(
      []
    )
  })
  it('sinCosDeg matches Math to 1e-15 on the deskew range and is exact on quarter turns', () => {
    for (let d = -7; d <= 7; d += 0.05) {
      const { sin, cos } = sinCosDeg(d)
      expect(Math.abs(sin - Math.sin((d * Math.PI) / 180))).toBeLessThan(1e-15)
      expect(Math.abs(cos - Math.cos((d * Math.PI) / 180))).toBeLessThan(1e-15)
    }
    expect(sinCosDeg(90)).toEqual({ sin: 1, cos: -0 })
    expect(sinCosDeg(180).cos).toBe(-1)
  })
})

describe('image helpers', () => {
  it('Otsu splits a bimodal histogram between its modes', () => {
    const img = blank(100, 10)
    fillRect(img, 0, 0, 30, 10, 40)
    const t = otsu(histogram(img))
    expect(t).toBeGreaterThan(40)
    expect(t).toBeLessThanOrEqual(255)
    expect(binarize(img, t).reduce((a, b) => a + b, 0)).toBe(300)
  })

  it('boxDownscale averages blocks (edge blocks average what they have), rounding half up', () => {
    const img: Gray = { width: 5, height: 1, data: Uint8Array.from([0, 1, 2, 3, 255]) }
    expect([...boxDownscale(img, 4).data]).toEqual([2, 255])
  })

  it('padWhite translates every pixel by the pad', () => {
    const img = blank(3, 2, 0)
    const p = padWhite(img, 2)
    expect([p.width, p.height]).toEqual([7, 6])
    expect(p.data[2 * 7 + 2]).toBe(0)
    expect(p.data[0]).toBe(255)
  })

  it('packed drops a row stride; cropRows clips', () => {
    const p = packed({ width: 2, height: 2, stride: 3, data: Uint8Array.from([1, 2, 9, 3, 4, 9]) })
    expect([...p.data]).toEqual([1, 2, 3, 4])
    expect(cropRows(p, 1, 5).height).toBe(1)
  })

  it('resizeBilinear keeps a flat image flat and a 1× copy exact', () => {
    expect(resizeBilinear(blank(7, 5, 77), 13, 9).data.every((v) => v === 77)).toBe(true)
    const t = textPage(64, 64)
    expect(Buffer.from(resizeBilinear(t, 64, 64).data).equals(Buffer.from(t.data))).toBe(true)
  })
})

describe('components', () => {
  it('labels 8-connected components with their bounds and edge flag', () => {
    const mask = Uint8Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1])
    const { components } = labelComponents(mask, 4, 4)
    // (0,0)-(1,1) diagonal: one component; (3,2),(2,3),(3,3): another.
    expect(components.map((c) => c.area)).toEqual([2, 3])
    expect(components[0]).toMatchObject({ x0: 0, y0: 0, x1: 2, y1: 2, edge: true })
  })
})

describe('border removal', () => {
  it('paints an edge frame white and leaves the text inside alone', () => {
    const img = textPage()
    fillRect(img, 0, 0, img.width, 10)
    fillRect(img, 0, 0, 14, img.height)
    const r = removeBorder(img)
    expect(r.removed).toBeGreaterThan(0)
    for (let y = 0; y < 10; y++) expect(r.image.data[y * img.width + 300]).toBe(255)
    // The text block (x 48.., y 48..) is untouched.
    const t = textPage()
    for (let y = 40; y < img.height - 40; y++)
      for (let x = 40; x < img.width - 40; x++)
        expect(r.image.data[y * img.width + x]).toBe(t.data[y * img.width + x])
  })

  it('does nothing to a clean page, and never erases a background covering half the page', () => {
    const t = textPage()
    expect(removeBorder(t)).toEqual({ image: t, removed: 0 })
    const dim = blank(200, 100, 120)
    fillRect(dim, 50, 40, 150, 60, 10)
    expect(removeBorder(dim).removed).toBe(0)
  })

  it('pads by 16 px', () => {
    expect(BORDER_PAD).toBe(16)
  })
})

describe('despeckle', () => {
  it('removes specks only on a noisy page', () => {
    const t = textPage()
    expect(despeckle(t, 300).noisy).toBe(false)
    expect(despeckle(t, 300).image).toBe(t)
    const noisy = textPage()
    let n = 0
    for (let y = 2; y < noisy.height - 2; y += 7)
      for (let x = 3; x < noisy.width - 2; x += 9) {
        // Only isolated dots (a white 3×3 around them): a dot touching a letter is part of it.
        let clear = true
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            if (noisy.data[(y + dy) * noisy.width + x + dx] !== 255) clear = false
        if (clear) {
          noisy.data[y * noisy.width + x] = 0
          n++
        }
      }
    expect((n * 1e6) / (noisy.width * noisy.height)).toBeGreaterThan(NOISY_PER_MP)
    const d = despeckle(noisy, 300)
    expect(d.noisy).toBe(true)
    // The dots are gone; the text is intact (its letters are 72+ px² components).
    expect(Buffer.from(d.image.data).equals(Buffer.from(t.data))).toBe(true)
    expect(d.ink).toBe(despeckle(t, 300).ink)
  })

  it('speck size scales with DPI and is capped at 9 px²', () => {
    expect([maxSpeck(150), maxSpeck(300), maxSpeck(400), maxSpeck(600), maxSpeck(1200)]).toEqual([
      1, 4, 7, 9, 9
    ])
  })
})

describe('background normalisation', () => {
  it('tells a photographed page from a scan', () => {
    expect(looksLikePhoto(textPage())).toBe(false)
    const photo = textPage()
    for (let i = 0; i < photo.data.length; i++)
      photo.data[i] = Math.floor((photo.data[i] * (150 + ((i % photo.width) >> 4))) / 255)
    expect(looksLikePhoto(photo)).toBe(true)
  })

  it('flattens a lighting gradient back to white paper and keeps the ink dark', () => {
    const t = textPage()
    const g: Gray = { width: t.width, height: t.height, data: new Uint8Array(t.data.length) }
    for (let y = 0; y < t.height; y++)
      for (let x = 0; x < t.width; x++) {
        const k = 256 - Math.floor((x * 90) / t.width) // ×1.0 → ×0.65 across
        g.data[y * t.width + x] = (t.data[y * t.width + x] * k) >> 8
      }
    const n = normalizeBackground(g, 300)
    let paper = 0
    let papers = 0
    let ink = 0
    let inks = 0
    for (let i = 0; i < t.data.length; i++)
      if (t.data[i] === 255) {
        paper += n.data[i]
        papers++
      } else {
        ink += n.data[i]
        inks++
      }
    expect(paper / papers).toBeGreaterThan(245)
    expect(ink / inks).toBeLessThan(40)
  })
})

describe('geometry', () => {
  it('rotateQuarterCW is exact and its toSource maps pixel centres back', () => {
    const img = textPage(40, 30)
    for (const t of [1, 2, 3] as const) {
      const r = rotateQuarterCW(img, t)
      expect(r.image.width * r.image.height).toBe(img.width * img.height)
      for (let y = 0; y < r.image.height; y++)
        for (let x = 0; x < r.image.width; x++) {
          const [sx, sy] = applyAffine(r.toSource, x + 0.5, y + 0.5)
          expect(r.image.data[y * r.image.width + x]).toBe(
            img.data[Math.floor(sy) * img.width + Math.floor(sx)]
          )
        }
    }
    const four = [1, 1, 1, 1].reduce((im) => rotateQuarterCW(im, 1).image, img)
    expect(Buffer.from(four.data).equals(Buffer.from(img.data))).toBe(true)
  })

  it('rotateBilinear keeps every source pixel on its canvas and maps back through toSource', () => {
    const img = blank(200, 100)
    fillRect(img, 150, 20, 154, 24)
    const r = rotateBilinear(img, 5)
    expect(r.image.width).toBeGreaterThanOrEqual(200)
    expect(r.image.height).toBeGreaterThan(100)
    // The darkest output pixel maps back onto the source square.
    let best = 0
    for (let i = 1; i < r.image.data.length; i++) if (r.image.data[i] < r.image.data[best]) best = i
    const [sx, sy] = applyAffine(
      r.toSource,
      (best % r.image.width) + 0.5,
      Math.floor(best / r.image.width) + 0.5
    )
    expect(sx).toBeGreaterThan(149)
    expect(sx).toBeLessThan(155)
    expect(sy).toBeGreaterThan(19)
    expect(sy).toBeLessThan(25)
  })

  it('compose applies the first map, then the second', () => {
    const m = compose([1, 0, 0, 1, 5, 0], [2, 0, 0, 2, 0, 0])
    expect(applyAffine(m, 1, 1)).toEqual([12, 2])
  })
})

describe('skew', () => {
  it.each([0, 0.3, -0.6, 2, -3.5, 6.5])('finds a %f° tilt within 0.1°', (deg) => {
    const r = rotateBilinear(textPage(1600, 900), deg).image
    const q = boxDownscale(r, 4)
    const s = findSkew(binarize(q, otsu(histogram(q))), q.width, q.height)
    expect(Math.abs(s.deg - deg)).toBeLessThanOrEqual(0.1)
    expect(s.conf).toBeGreaterThan(3)
    expect(s.apply).toBe(Math.abs(s.deg) >= 0.1)
  })

  it('reports nothing for an empty page', () => {
    expect(findSkew(new Uint8Array(100), 10, 10)).toEqual({
      deg: 0,
      conf: 0,
      score: 0,
      apply: false
    })
  })
})

describe('orientation', () => {
  const quarter = (img: Gray): Uint8Array => {
    const q = boxDownscale(img, 4)
    return binarize(q, otsu(histogram(q)))
  }

  it('the 90° test: horizontal text is not vertical; turned text is; skew does not fool it', () => {
    const t = textPage()
    const q = boxDownscale(t, 4)
    expect(profileTest(quarter(t), q.width, q.height).vertical).toBe(false)
    const turned = rotateQuarterCW(t, 1).image
    const qt = boxDownscale(turned, 4)
    expect(profileTest(quarter(turned), qt.width, qt.height).vertical).toBe(true)
    for (const d of [2, -5]) {
      const s = rotateBilinear(t, d).image
      const qs = boxDownscale(s, 4)
      expect(profileTest(quarter(s), qs.width, qs.height).vertical).toBe(false)
    }
  })

  const raw = (words: [string, number][]): RawOcr => ({
    lines: [
      {
        kind: 'ocr_line',
        bbox: { x0: 0, y0: 0, x1: 1, y1: 1 },
        baseline: null,
        xHeight: 0,
        size: 0,
        words: words.map(([text, conf]) => ({ text, conf, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }))
      }
    ],
    meanConf: null,
    confSource: 'word'
  })

  it('plausibility: text scores high, upside-down garbage low', () => {
    const good = raw(
      'The harbour office opens at seven and closes when the last ferry docked'
        .split(' ')
        .map((t) => [t, 95])
    )
    // What Tesseract's eng model makes of upside-down Latin: punctuation-led shards, no vowels.
    const bad = raw(["'p3]", 'ʎ}', 's|', ':,', 'ppqd', '‘sq', '"', 'ʇ{'].map((t) => [t, 30]))
    expect(plausibility(good)).toBeGreaterThan(0.8)
    expect(plausibility(bad)).toBeLessThan(0.5)
    expect(plausibility(raw([]))).toBe(0)
  })

  it('flips only when the confidence AND the plausibility both agree', () => {
    const words = (n: number, conf: number, t = 'harbour'): RawOcr =>
      raw(Array.from({ length: n }, () => [t, conf] as [string, number]))
    const asIs = bandReading(words(12, 40, 'ɥ|,'))
    expect(shouldFlip(asIs, bandReading(words(12, 90)))).toBe(true)
    // Confidence only (both read as words).
    expect(shouldFlip(bandReading(words(12, 40)), bandReading(words(12, 90)))).toBe(false)
    // Plausibility only.
    expect(shouldFlip(bandReading(words(12, 80, 'ɥ|,')), bandReading(words(12, 90)))).toBe(false)
    // Too few words.
    expect(shouldFlip(bandReading(words(9, 40, 'ɥ|,')), bandReading(words(9, 90)))).toBe(false)
  })

  it('rotation Δ = (θ_detected − r_edit) mod 360', () => {
    const cases: [Orientation, Orientation, Orientation][] = [
      [0, 0, 0],
      [90, 0, 90],
      [90, 90, 0],
      [180, 90, 90],
      [0, 270, 90],
      [270, 90, 180]
    ]
    for (const [d, e, x] of cases) expect(rotationDelta(d, e)).toBe(x)
  })
})
