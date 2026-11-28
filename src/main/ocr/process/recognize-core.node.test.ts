// The recognize thread's pipeline (DESIGN.md §3.4.3–§3.4.6) with a scripted engine: the pass
// plan (pass 1, the 0°/180° band test, Retry A, Retry B, the 3-recognition budget), the geometry
// it reports back (pad, quarter turns, deskew), the adaptive request and the reuse call, and the
// failure shapes the coordinator's policy reads.

import { describe, expect, it } from 'vitest'

import {
  TESS_CORE7,
  TESS_CORE7_PLACEHOLDER,
  calibrate,
  thresholdsFor
} from '../../../shared/ocr/calibration'
import {
  TessError,
  type TessErrorKind,
  type TessParams
} from '../../../shared/ocr/engine/tess-core'
import type { GrayImage } from '../../../shared/ocr/engine/types'
import { HocrError } from '../../../shared/ocr/hocr'
import { applyAffine, rotateBilinear } from '../../../shared/ocr/preprocess/geometry'
import { decodeEntry, readEntryById } from '../test-utils/ocr-cache'
import { hocr, readWays, seeingEngine, textLines, turned, words } from '../test-utils/seeing-engine'
import { isOomShaped } from './coordinator'
import {
  ADAPTIVE_SKIP,
  ADAPTIVE_XH,
  MAX_PASSES,
  SPARSE_RATIO,
  adaptiveRequest,
  adaptiveSkip,
  calibratedMean,
  describeRecognizeError,
  passScore,
  recognizePage,
  recognizeRawPass1,
  type RecognizeEngine
} from './recognize-core'

const blank = (w = 400, h = 300): GrayImage => ({
  width: w,
  height: h,
  data: new Uint8Array(w * h).fill(255)
})

/** 600 separate 4×4 marks on a 600 × 400 page: 600 ink components. */
function marks(): GrayImage {
  const img = blank(600, 400)
  for (let k = 0; k < 600; k++) {
    const x = 10 + (k % 40) * 14
    const y = 20 + Math.floor(k / 40) * 24
    for (let dy = 0; dy < 4; dy++) img.data.fill(0, (y + dy) * 600 + x, (y + dy) * 600 + x + 4)
  }
  return img
}

/** An engine that answers each call from `script(params, call index)`. */
function scripted(script: (p: TessParams, i: number, img: GrayImage) => string): {
  engine: RecognizeEngine
  calls: { params: TessParams; width: number; height: number }[]
} {
  const calls: { params: TessParams; width: number; height: number }[] = []
  return {
    calls,
    engine: {
      recognize: (img, params) => {
        calls.push({ params, width: img.width, height: img.height })
        return { hocr: script(params, calls.length - 1, img) }
      }
    }
  }
}

const GOOD = hocr([words(8, 96), words(8, 96), words(8, 96)])

describe('recognizePage: pass plan', () => {
  it('runs pass 1 (PSM 3, Otsu, the page DPI) on the padded copy and stops when it reads well', () => {
    const { engine, calls } = scripted(() => GOOD)
    let t = 0
    const out = recognizePage(engine, blank(), 300, { now: () => (t += 10), returnHocr: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].params).toMatchObject({
      tessedit_pageseg_mode: 3,
      thresholding_method: 0,
      user_defined_dpi: 300,
      hocr_char_boxes: 1,
      preserve_interword_spaces: 1
    })
    // The 16 px white pad, undone by toSource.
    expect([calls[0].width, calls[0].height]).toEqual([432, 332])
    expect(applyAffine(out.toSource, 16, 16)).toEqual([0, 0])
    expect(out.chosen).toBe('pass1')
    expect(out.orientation).toBe(0)
    expect(out.plan).toEqual({ quarterTurns: 0, skewDeg: 0 })
    expect(out.passes).toEqual([{ id: 'pass1', ms: 10, words: 24, score: passScore(out.raw) }])
    expect(out.hocr).toEqual([GOOD])
    expect(out.recognitions).toHaveLength(1)
    expect(recognizePage(engine, blank(), 300).hocr).toBeUndefined()
  })

  it('a doubtful pass 1 runs the band test; both signals agreeing flips the copy and reruns pass 1', () => {
    const garbage = hocr([words(12, 30, "'p3]"), words(12, 30, 'ʎ}s|')])
    const { engine, calls } = scripted((p, i) => {
      if (i === 0) return garbage // pass 1: upside down
      if (p.tessedit_pageseg_mode === 6) return i === 1 ? garbage : GOOD // band as is, flipped
      return GOOD // pass 1 again on the flipped copy
    })
    const out = recognizePage(engine, blank(), 300)
    expect(out.passes.map((p) => p.id)).toEqual(['pass1', 'band', 'band-flipped', 'pass1-flipped'])
    // The band is the middle quarter of the padded copy.
    expect(calls[1]).toMatchObject({ width: 432, height: 83 })
    expect(out.orientation).toBe(180)
    expect(out.chosen).toBe('pass1-flipped')
    expect(out.stats.flipped).toBe(true)
    // toSource maps the flipped copy's corner back to the opposite corner of the raster.
    expect(applyAffine(out.toSource, 16, 16)).toEqual([400, 300])
  })

  it('confidence alone never flips (the flipped band reads no more like text)', () => {
    const { engine } = scripted((p, i) =>
      i === 0 || (p.tessedit_pageseg_mode === 6 && i === 1)
        ? hocr([words(12, 40)])
        : hocr([words(12, 90)])
    )
    const out = recognizePage(engine, blank(), 300)
    expect(out.stats.orientationChecked).toBe(true)
    expect(out.stats.flipped).toBe(false)
    expect(out.orientation).toBe(0)
  })

  it('Retry A (Sauvola) when the calibrated mean is under the retry threshold; the better is kept', () => {
    const low = hocr([words(8, 50), words(8, 50)])
    const { engine, calls } = scripted((p) =>
      p.tessedit_pageseg_mode === 6 ? low : p.thresholding_method === 2 ? GOOD : low
    )
    const out = recognizePage(engine, blank(), 300, { calibration: TESS_CORE7_PLACEHOLDER })
    // Neither band read reads well, so the quarter band test runs too (and does not turn).
    expect(out.passes.map((p) => p.id)).toEqual([
      'pass1',
      'band',
      'band-flipped',
      'band-quarter',
      'band-quarter-flipped',
      'sauvola'
    ])
    expect(calls[5].params.thresholding_method).toBe(2)
    expect(out.chosen).toBe('sauvola')
    expect(out.recipe).toEqual({ psm: 3, thresholding: 2 })
  })

  it('Retry B (PSM 11) when the OCR chars are under 30% of the ink components', () => {
    // 600 separate 4×4 marks; the engine reads one word.
    const img = blank(600, 400)
    for (let k = 0; k < 600; k++) {
      const x = 10 + (k % 40) * 14
      const y = 20 + Math.floor(k / 40) * 24
      for (let dy = 0; dy < 4; dy++) img.data.fill(0, (y + dy) * 600 + x, (y + dy) * 600 + x + 4)
    }
    const { engine, calls } = scripted((p) =>
      p.tessedit_pageseg_mode === 11 ? hocr([words(20, 92, 'mark')]) : hocr([words(1, 96, 'one')])
    )
    const out = recognizePage(engine, img, 300)
    expect(out.stats.ink).toBe(600)
    expect(calls.map((c) => c.params.tessedit_pageseg_mode)).toEqual([3, 11])
    expect(out.chosen).toBe('sparse')
  })

  it('keeps pass 1 when the Sauvola retry reads worse (§3.4.5: keep the higher Σ conf × chars)', () => {
    const low = hocr([words(8, 50), words(8, 50)])
    const worse = hocr([words(4, 50)])
    const { engine } = scripted((p) => (p.thresholding_method === 2 ? worse : low))
    const out = recognizePage(engine, blank(), 300, { calibration: TESS_CORE7_PLACEHOLDER })
    expect(out.passes.map((p) => p.id)).toContain('sauvola')
    expect(out.chosen).toBe('pass1')
    expect(out.recipe).toEqual({ psm: 3, thresholding: 0 })
    expect(out.raw.lines).toHaveLength(2)
  })

  it('keeps pass 1 when the PSM 11 retry reads worse', () => {
    const { engine } = scripted((p) =>
      p.tessedit_pageseg_mode === 11 ? hocr([words(1, 90, 'on')]) : hocr([words(1, 96, 'one')])
    )
    const out = recognizePage(engine, marks(), 300)
    expect(out.passes.map((p) => p.id)).toEqual(['pass1', 'sparse'])
    expect(out.chosen).toBe('pass1')
    expect(out.recipe).toEqual({ psm: 3, thresholding: 0 })
  })

  it('Retry B fires just under 30% of the ink components, not just over', () => {
    expect(SPARSE_RATIO).toBe(0.3)
    // 600 components: 24 × 7 = 168 chars (28%) retries; 26 × 7 = 182 (30.3%) does not.
    for (const [n, retried] of [
      [24, true],
      [26, false]
    ] as const) {
      const { engine } = scripted(() => hocr([words(n, 96)]))
      const out = recognizePage(engine, marks(), 300)
      expect(out.stats.ink).toBe(600)
      expect(
        out.passes.some((p) => p.id === 'sparse'),
        String(n)
      ).toBe(retried)
    }
  })

  it('Retry A fires just under the shipped retry threshold, not at it', () => {
    const retry = thresholdsFor(TESS_CORE7).retry
    // The highest whole raw confidence whose calibrated value is under the threshold.
    let r = 0
    while (calibrate(TESS_CORE7, r + 1)! < retry) r++
    for (const [conf, retried] of [
      [r, true],
      [r + 1, false]
    ] as const) {
      const { engine } = scripted(() => hocr([words(8, conf), words(8, conf)]))
      const out = recognizePage(engine, blank(), 300)
      expect(
        out.passes.some((p) => p.id === 'sauvola'),
        `raw ${conf}`
      ).toBe(retried)
    }
  })

  it('the calibrated mean is weighted by chars, not words', () => {
    const raw = {
      lines: [
        {
          kind: 'ocr_line' as const,
          bbox: { x0: 0, y0: 0, x1: 1, y1: 1 },
          baseline: null,
          xHeight: 0,
          size: 0,
          words: [
            { text: 'a', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 }, conf: 0 },
            { text: 'abcdefghi', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 }, conf: 100 }
          ]
        }
      ],
      meanConf: 50,
      confSource: 'word' as const
    }
    expect(calibratedMean(raw, TESS_CORE7_PLACEHOLDER)).toBeCloseTo(0.9, 12)
  })

  it('never runs more than MAX_PASSES full-page recognitions (band reads aside)', () => {
    const img = blank(600, 400)
    for (let k = 0; k < 600; k++) {
      const x = 10 + (k % 40) * 14
      const y = 20 + Math.floor(k / 40) * 24
      for (let dy = 0; dy < 4; dy++) img.data.fill(0, (y + dy) * 600 + x, (y + dy) * 600 + x + 4)
    }
    // Upside down, low confidence and sparse: flip, Sauvola, and PSM 11 would be a fourth.
    const garbage = hocr([words(12, 30, "'p3]")])
    const { engine } = scripted((p, i) => {
      if (i === 0) return garbage
      if (p.tessedit_pageseg_mode === 6) return i === 1 ? garbage : GOOD
      return hocr([words(2, 40)])
    })
    const out = recognizePage(engine, img, 300, { calibration: TESS_CORE7_PLACEHOLDER })
    const full = out.passes.filter((p) => !p.id.startsWith('band'))
    expect(full.map((p) => p.id)).toEqual(['pass1', 'pass1-flipped', 'sauvola'])
    expect(full.length).toBe(MAX_PASSES)
  })

  it('a malformed hOCR fails the page', () => {
    expect(() => recognizePage({ recognize: () => ({ hocr: '<div>' }) }, blank(), 300)).toThrow()
  })
})

describe('recognizePage: geometry', () => {
  it('detects a skew, deskews the copy, and maps its pixels back with the inverse rotation', () => {
    // Text-like bars tilted by 3°.
    const img = blank(1200, 600)
    for (let y = 80; y < 520; y += 40)
      for (let x = 80; x < 1100; x += 70)
        for (let dy = 0; dy < 14; dy++)
          img.data.fill(0, (y + dy) * 1200 + x, (y + dy) * 1200 + x + 56)
    const tilted = rotateBilinear({ ...img, data: img.data }, 3).image
    const { engine, calls } = scripted(() => GOOD)
    const out = recognizePage(engine, tilted, 300)
    expect(Math.abs(out.plan.skewDeg - 3)).toBeLessThanOrEqual(0.1)
    expect(out.stats.skew.applied).toBe(true)
    // The deskewed copy is bigger than the input (nothing cropped) and padded.
    expect(calls[0].width).toBeGreaterThan(tilted.width)
    // The copy's centre maps to the raster's centre.
    const [cx, cy] = applyAffine(out.toSource, calls[0].width / 2, calls[0].height / 2)
    expect(Math.abs(cx - tilted.width / 2)).toBeLessThan(0.01)
    expect(Math.abs(cy - tilted.height / 2)).toBeLessThan(0.01)
  })

  it('turns a page whose text runs vertically a quarter turn clockwise', () => {
    const img = blank(600, 1200)
    for (let x = 80; x < 520; x += 40)
      for (let y = 80; y < 1100; y += 70)
        for (let dx = 0; dx < 14; dx++)
          for (let dy = 0; dy < 56; dy++) img.data[(y + dy) * 600 + x + dx] = 0
    const { engine, calls } = scripted(() => GOOD)
    const out = recognizePage(engine, img, 300)
    expect(out.plan.quarterTurns).toBe(1)
    expect(out.orientation).toBe(90)
    expect([calls[0].width, calls[0].height]).toEqual([1232, 632])
  })

  it('a page both turned and tilted: the copy’s ink maps back onto the raster’s ink', () => {
    // Vertical "lines" of bars, then tilted by 3°: a quarter turn AND a deskew (compose order).
    const img = blank(700, 1200)
    for (let x = 80; x < 620; x += 40)
      for (let y = 80; y < 1100; y += 70)
        for (let dx = 0; dx < 14; dx++)
          for (let dy = 0; dy < 56; dy++) img.data[(y + dy) * 700 + x + dx] = 0
    const tilted = rotateBilinear({ ...img, data: img.data }, 3).image
    let seen: GrayImage | null = null
    const { engine } = scripted((_p, _i, copy) => {
      seen ??= { width: copy.width, height: copy.height, data: copy.data.slice() }
      return GOOD
    })
    const out = recognizePage(engine, tilted, 300)
    expect(out.plan.quarterTurns).toBe(1)
    expect(Math.abs(out.plan.skewDeg)).toBeGreaterThan(2)
    const copy = seen!
    let inked = 0
    let onInk = 0
    for (let y = 0; y < copy.height; y += 3)
      for (let x = 0; x < copy.width; x += 3) {
        if (copy.data[y * copy.width + x] >= 64) continue
        inked++
        const [sx, sy] = applyAffine(out.toSource, x + 0.5, y + 0.5)
        const px = Math.floor(sx)
        const py = Math.floor(sy)
        if (px < 0 || py < 0 || px >= tilted.width || py >= tilted.height) continue
        if (tilted.data[py * tilted.width + px] < 160) onInk++
      }
    expect(inked).toBeGreaterThan(1000)
    expect(onInk / inked).toBeGreaterThan(0.97)
  })
})

describe('recognizePage: orientation (§3.4.5), with an engine that sees the pixels', () => {
  it('the seeing engine tells the ways up apart (test self-check)', () => {
    const page = blank(600, 300)
    textLines(page, [60, 120])
    expect(readWays(page)).toEqual(['upright', 'upright'])
    expect(readWays(turned(page, 2))).toEqual(['flipped', 'flipped'])
    const sideways = readWays(turned(page, 1))
    expect(sideways.length).toBeGreaterThan(0)
    expect(sideways.every((w) => w === 'unreadable')).toBe(true)
  })

  it('reads the band where the text is: an upside-down short letter flips', () => {
    // Text only in the top 30% of the upright page, i.e. the bottom of the upside-down one: a
    // fixed central band reads nothing there.
    const page = blank(600, 900)
    textLines(page, [60, 100, 140, 180, 220, 260])
    const { engine } = seeingEngine()
    const out = recognizePage(engine, turned(page, 2), 300)
    expect(out.stats.band!.asIs.words).toBeGreaterThan(0)
    expect(out.orientation).toBe(180)
    expect(out.chosen).toBe('pass1-flipped')
  })

  it('a logo across the middle does not take the band from the text under it', () => {
    const page = blank(600, 900)
    for (let y = 300; y < 560; y++) page.data.fill(0, y * 600 + 120, y * 600 + 480)
    textLines(page, [760, 800])
    const { engine } = seeingEngine()
    const out = recognizePage(engine, turned(page, 2), 300)
    expect(out.stats.band!.flipped.words).toBeGreaterThanOrEqual(16)
    expect(out.orientation).toBe(180)
  })

  it('keeps pass 1 when the turned pass scores lower (a fold-over mailer)', () => {
    // Upright lines above and below an upside-down block that fills the band.
    const page = blank(600, 1000)
    textLines(page, [40, 80, 120, 860, 900, 940])
    const block = blank(600, 220)
    textLines(block, [20, 60, 100, 140, 180])
    page.data.set(turned(block, 2).data, 390 * 600)
    expect(readWays(page).filter((w) => w === 'flipped')).toHaveLength(5)
    const { engine } = seeingEngine()
    const out = recognizePage(engine, page, 300)
    const ids = out.passes.map((p) => p.id)
    expect(ids.slice(0, 4)).toEqual(['pass1', 'band', 'band-flipped', 'pass1-flipped'])
    const score = (id: string): number => out.passes.find((p) => p.id === id)!.score
    expect(score('pass1-flipped')).toBeLessThan(score('pass1'))
    expect(out.chosen).toBe('pass1')
    expect(out.orientation).toBe(0)
    expect(out.stats.flipped).toBe(false)
    expect(out.plan.quarterTurns).toBe(0)
  })

  it('tries the edit rotation first: a page the user already turned reads in one pass', () => {
    const page = blank(600, 900)
    textLines(page, [60, 100, 140])
    const { engine } = seeingEngine()
    const out = recognizePage(engine, turned(page, 2), 300, { prior: 180 })
    expect(out.passes.map((p) => p.id)).toEqual(['pass1'])
    expect(out.orientation).toBe(180)
  })

  it('the prior picks 270 over 90 on a page whose lines run vertically', () => {
    const page = blank(600, 900)
    textLines(page, [60, 100, 140, 180, 220])
    const sideways = turned(page, 1) // upright after three quarter turns clockwise: θ = 270
    const { engine } = seeingEngine()
    const plain = recognizePage(engine, sideways, 300)
    expect(plain.orientation).toBe(270)
    expect(plain.passes.length).toBeGreaterThan(1) // read at 90 first, then flipped
    const out = recognizePage(engine, sideways, 300, { prior: 270 })
    expect(out.passes.map((p) => p.id)).toEqual(['pass1'])
    expect(out.orientation).toBe(270)
  })

  it('a prior across the 90° test’s axis is not tried (a sideways read can look perfect)', () => {
    const page = blank(600, 900)
    textLines(page, [60, 100, 140, 180, 220])
    for (const prior of [90, 270] as const) {
      const { engine } = seeingEngine()
      const out = recognizePage(engine, page, 300, { prior })
      expect(
        out.passes.map((p) => p.id),
        String(prior)
      ).toEqual(['pass1'])
      expect(out.orientation, String(prior)).toBe(0)
    }
  })
})

describe('recognizePage: the quarter-turn band test (a sideways page the 90° test missed)', () => {
  // A blank raster: the 90° test sees no lines, so the copy is read as is (turns 0).
  const answer = (good: boolean): string =>
    good ? hocr([words(8, 90), words(8, 90)]) : hocr([words(12, 30, '3.1'), words(12, 30, 'l1')])
  const ids = ['pass1', 'band', 'band-flipped', 'band-quarter', 'band-quarter-flipped']

  it('turns to whichever quarter reads well, if the turned pass then scores higher', () => {
    for (const [goodAt, theta] of [
      [3, 90],
      [4, 270]
    ] as const) {
      const { engine } = scripted((_p, i) => answer(i === goodAt || i === 5))
      const out = recognizePage(engine, blank(), 300)
      expect(out.passes.map((p) => p.id).slice(0, 6)).toEqual([...ids, 'pass1-turned'])
      expect(out.orientation, String(goodAt)).toBe(theta)
      expect(out.chosen).toBe('pass1-turned')
      expect(out.stats.flipped).toBe(true)
    }
  })

  it('keeps pass 1 when the turned pass scores lower', () => {
    const { engine } = scripted((_p, i) =>
      i === 3 ? answer(true) : i === 5 ? hocr([words(2, 40)]) : answer(false)
    )
    const out = recognizePage(engine, blank(), 300)
    expect(out.passes.map((p) => p.id).slice(0, 6)).toEqual([...ids, 'pass1-turned'])
    expect(out.chosen).toBe('pass1')
    expect(out.orientation).toBe(0)
    expect(out.stats.flipped).toBe(false)
  })

  it('needs both signals: +15 confidence with 10 words, and a band that reads like text', () => {
    const at = (quarter: string): string[] =>
      recognizePage(
        scripted((_p, i) => (i === 3 ? quarter : answer(false))).engine,
        blank(),
        300
      ).passes.map((p) => p.id)
    // Sideways reads at conf 30: 45 turns, 44 does not; 9 words do not; garbage at 90 does not.
    expect(at(hocr([words(10, 45)]))).toContain('pass1-turned')
    expect(at(hocr([words(10, 44)]))).not.toContain('pass1-turned')
    expect(at(hocr([words(9, 90)]))).not.toContain('pass1-turned')
    expect(at(hocr([words(10, 90, "'p3]")]))).not.toContain('pass1-turned')
  })

  it('does not run when a 0°/180° read already reads well', () => {
    const { engine } = scripted((p, i) =>
      i === 0
        ? answer(false)
        : p.tessedit_pageseg_mode === 6 && i === 1
          ? answer(true)
          : answer(false)
    )
    const out = recognizePage(engine, blank(), 300)
    expect(out.passes.map((p) => p.id)).not.toContain('band-quarter')
  })
})

describe('the adaptive pass (§3.4.3)', () => {
  it('asks for x-height 20 px when the median is under 15 px, and never on a reuse call', () => {
    const small = hocr([words(8, 90), words(8, 90)], 12)
    const { engine } = scripted(() => small)
    const out = recognizePage(engine, blank(), 300)
    expect(out.adaptive).toEqual({
      dpi: (300 * ADAPTIVE_XH.target) / 12,
      measured: 12,
      script: 'xheight'
    })
    const reused = recognizePage(engine, blank(), 500, {
      reuse: { plan: out.plan, recipe: { psm: 3, thresholding: 2 } }
    })
    expect(reused.adaptive).toBeNull()
    expect(reused.passes.map((p) => p.id)).toEqual(['adaptive'])
    expect(reused.recipe).toEqual({ psm: 3, thresholding: 2 })
  })

  it('is skipped when 90% of the chars already read at raw confidence ≥ 95', () => {
    const confident = hocr([words(8, 97), words(8, 97)], 12)
    const { engine } = scripted(() => confident)
    expect(adaptiveSkip(recognizePage(engine, blank(), 300).raw)).toBe(true)
    expect(recognizePage(engine, blank(), 300).adaptive).toBeNull()
    // The boundary, on both sides: 9 of 10 words at 95 skips, 8 of 10 does not.
    const mix = (hi: number): string =>
      hocr([[...words(hi, ADAPTIVE_SKIP.raw), ...words(10 - hi, ADAPTIVE_SKIP.raw - 1)]], 12)
    const at = (hi: number) => recognizePage(scripted(() => mix(hi)).engine, blank(), 300)
    expect(ADAPTIVE_SKIP.share).toBe(0.9)
    expect(at(9).adaptive).toBeNull()
    expect(at(8).adaptive).not.toBeNull()
    // Char-weighted: one long word under the bar outweighs ten short ones over it (by words it
    // would be 10 of 11, over the share).
    const long = hocr([[...words(10, 99, 'ab'), { t: 'harbourmaster', conf: 80 }]], 12)
    expect(adaptiveSkip(recognizePage(scripted(() => long).engine, blank(), 300).raw)).toBe(false)
  })

  it('uses the char-box height for scripts without an x-height (target 40 px)', () => {
    const raw = {
      lines: [
        {
          kind: 'ocr_line' as const,
          bbox: { x0: 0, y0: 0, x1: 100, y1: 24 },
          baseline: null,
          xHeight: 0,
          size: 24,
          words: [
            {
              text: '漢字',
              bbox: { x0: 0, y0: 0, x1: 48, y1: 24 },
              conf: 80,
              chars: [
                { x0: 0, y0: 0, x1: 22, y1: 24 },
                { x0: 24, y0: 0, x1: 46, y1: 24 }
              ]
            }
          ]
        }
      ],
      meanConf: 80,
      confSource: 'word' as const
    }
    expect(adaptiveRequest(raw, 300)).toEqual({ dpi: 500, measured: 24, script: 'no-xheight' })
  })
})

describe('the raw pass-1 test mode and failures', () => {
  it('recognizeRawPass1 runs pass 1 on the raster as given', () => {
    const recorded = decodeEntry(readEntryById('clean300'))
    const { engine, calls } = scripted(() => recorded)
    const out = recognizeRawPass1(engine, blank(1800, 750), 300, true)
    expect(calls).toHaveLength(1)
    expect([calls[0].width, calls[0].height]).toEqual([1800, 750])
    expect(out.raw.lines).toHaveLength(9)
    expect(out.hocr).toEqual([recorded])
  })

  it('what the thread posts for a failure, and whether the coordinator halves n for it', () => {
    const oom = describeRecognizeError(new TessError('oom', 'Recognize returned -1'))
    expect(oom).toEqual({ name: 'OcrOutOfMemory', message: 'out of memory: Recognize returned -1' })
    expect(isOomShaped(oom.name, oom.message)).toBe(true)
    const other: Array<[TessErrorKind, string]> = [
      ['abort', 'RuntimeError'],
      ['exit', 'TessError'],
      ['empty', 'TessError'],
      ['init', 'TessError'],
      ['params', 'TessError']
    ]
    for (const [kind, name] of other) {
      const d = describeRecognizeError(new TessError(kind, 'Aborted(native code called abort())'))
      expect(d, kind).toEqual({ name, message: 'Aborted(native code called abort())' })
      expect(isOomShaped(d.name, d.message), kind).toBe(false)
    }
    const h = describeRecognizeError(new HocrError('x'.repeat(400)))
    expect(h.name).toBe('HocrError')
    expect(h.message).toHaveLength(300)
    expect(isOomShaped(h.name, h.message)).toBe(false)
    expect(describeRecognizeError('boom')).toEqual({ name: 'Error', message: 'non-Error throw' })
  })

  it('scores a pass as Σ(conf × chars)', () => {
    expect(
      passScore({
        lines: [
          {
            kind: 'ocr_line',
            bbox: { x0: 0, y0: 0, x1: 1, y1: 1 },
            baseline: null,
            xHeight: 0,
            size: 0,
            words: [
              { text: 'abc', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 }, conf: 90 },
              { text: 'é', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 }, conf: 50 },
              { text: 'zz', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 }, conf: null }
            ]
          }
        ],
        meanConf: 70,
        confSource: 'word'
      })
    ).toBe(320)
  })
})
