// Mapping RawOcr (image px) → the overlay frame, the §3.4.6 filter and text cleaning, the packed
// result (DESIGN.md §3.4.6, §3.5.1), and the calibration placeholder. Hand-made inputs for the
// exact numbers, then a replayed clean300 recording against its ground truth.

import { describe, expect, it } from 'vitest'

import {
  RAW_THRESHOLDS,
  TESS_CORE7_PLACEHOLDER,
  assertCalibrationTable,
  calibrate
} from './calibration'
import { ENGINE_ID, PIPELINE_VERSION } from './engine/tess-core'
import type { RawLine, RawOcr, RawWord } from './engine/types'
import { hocrToRaw, parseHocr } from './hocr'
import {
  CJK_CHAR_EM,
  charEdges,
  dropReason,
  lineSizePx,
  mapRawOcr,
  mapRawOcrPage,
  noXHeightScript,
  type MapContext
} from './map'
import { decodeEntry, readEntryById } from './test-utils/ocr-replay'
import { loadNodeSynthDeps } from './test-utils/node-deps'
import { scorePage } from './test-utils/ocr-eval'
import { synthesize } from './test-utils/synth'
import { unpack, wordCount } from './types'

const CTX: MapContext = {
  page: { width: 432, height: 180 },
  raster: { width: 1800, height: 750 },
  renderDpi: 300,
  engineId: ENGINE_ID,
  dataHashes: { eng: 'a'.repeat(64) },
  langs: ['eng'],
  pipelineVersion: PIPELINE_VERSION,
  pageClass: 'scanned',
  calibration: TESS_CORE7_PLACEHOLDER
}

const word = (
  text: string,
  x0: number,
  x1: number,
  conf: number | null = 95,
  y0 = 100,
  y1 = 134
): RawWord => ({
  text,
  bbox: { x0, y0, x1, y1 },
  conf
})

const line = (words: RawWord[], over: Partial<RawLine> = {}): RawLine => ({
  kind: 'ocr_line',
  bbox: { x0: 100, y0: 100, x1: 1000, y1: 134 },
  baseline: { slope: 0, intercept: -8 },
  xHeight: 25,
  size: 42,
  words,
  ...over
})

const raw = (...lines: RawLine[]): RawOcr => ({ lines, meanConf: 90, confSource: 'word' })

describe('mapRawOcrPage geometry', () => {
  it('maps px to pt (72/300) with the y axis flipped, anchored on the baseline', () => {
    const p = mapRawOcrPage(raw(line([word('Hello', 100, 220), word('world', 250, 400)])), CTX)
    expect(p.lines).toHaveLength(1)
    const [l] = p.lines
    expect(l.angle).toBe(0)
    // xh 25 px / 0.5 = 50 px em = 12 pt (within the clamp [34, 68] px).
    expect(l.size).toBeCloseTo(12, 6)
    const [a, b] = l.words
    expect(a.x).toBeCloseTo(24, 6)
    // Baseline = bbox.y1 + intercept = 126 px → 180 − 126 · 0.24 = 149.76 pt.
    expect(a.y).toBeCloseTo(149.76, 5)
    expect(a.w).toBeCloseTo(28.8, 5)
    expect(b.x).toBeCloseTo(60, 6)
    expect(b.y).toBe(a.y)
    expect(a.conf).toBe(95)
    expect(a.confCal).toBeCloseTo(0.95, 6)
    expect(p).toMatchObject({
      v: 1,
      engineId: ENGINE_ID,
      langs: ['eng'],
      renderDpi: 300,
      physDpi: 300,
      orientation: 0,
      skewDeg: 0,
      status: 'ok',
      confSource: 'word'
    })
  })

  it('uses the raster size, not the nominal DPI, for the scale (pixel-cap rounding)', () => {
    const p = mapRawOcrPage(raw(line([word('Hi', 0, 100)])), {
      ...CTX,
      raster: { width: 1799, height: 749 }
    })
    expect(p.lines[0].words[0].w).toBeCloseTo((100 * 432) / 1799, 5)
  })

  it('snaps |angle| < 1° to 0 and keeps steeper baselines as a rotation', () => {
    const flat = mapRawOcrPage(
      raw(line([word('a', 100, 200)], { baseline: { slope: -0.017, intercept: 0 } })),
      CTX
    )
    expect(flat.lines[0].angle).toBe(0)
    // 2° rising to the right on screen is slope −tan 2° in image px (y down) → +2° CCW.
    const s = -Math.tan((2 * Math.PI) / 180)
    const tilted = mapRawOcrPage(
      raw(line([word('abc', 100, 400, 95, 80, 140)], { baseline: { slope: s, intercept: 0 } })),
      CTX
    )
    expect((tilted.lines[0].angle * 180) / Math.PI).toBeCloseTo(2, 6)
    const w = tilted.lines[0].words[0]
    // Along the baseline: 300 px / cos 2° at 0.24 pt/px.
    expect(w.w).toBeCloseTo((300 * 0.24) / Math.cos((2 * Math.PI) / 180), 4)
  })

  it('falls back to the word bottom when a line has no baseline', () => {
    const p = mapRawOcrPage(raw(line([word('a', 100, 200)], { baseline: null })), CTX)
    expect(p.lines[0].words[0].y).toBeCloseTo(180 - 134 * 0.24, 6)
  })
})

describe('font size by script', () => {
  it('Latin: x-height / 0.5, clamped to [line ink height, 2× it]', () => {
    const l = line([word('ab', 100, 200)])
    expect(lineSizePx(l, 'ab')).toBeCloseTo(50, 6)
    expect(lineSizePx({ ...l, xHeight: 10 }, 'ab')).toBe(34) // floor: the line box
    expect(lineSizePx({ ...l, xHeight: 40 }, 'ab')).toBe(68) // ceiling: 2× the line box
    expect(lineSizePx({ ...l, xHeight: 0 }, 'ab')).toBe(34) // unknown: the line box
  })

  it('a tilted line box taller than 1.5× its words uses the median word height', () => {
    const tall = line([word('a', 100, 200, 95, 100, 130), word('b', 300, 400, 95, 120, 150)], {
      bbox: { x0: 100, y0: 100, x1: 400, y1: 200 }
    })
    expect(lineSizePx({ ...tall, xHeight: 25 }, 'ab')).toBe(50)
    expect(lineSizePx({ ...tall, xHeight: 5 }, 'ab')).toBe(30)
  })

  it('Han / kana / Hangul / Devanagari: 0.88 × the median char-box height', () => {
    expect(noXHeightScript('漢字かな')).toBe(true)
    expect(noXHeightScript('한국어')).toBe(true)
    expect(noXHeightScript('हिन्दी')).toBe(true)
    expect(noXHeightScript('Latin 漢')).toBe(false)
    const w: RawWord = {
      ...word('漢字', 100, 180, 90, 100, 140),
      chars: [
        { x0: 100, y0: 100, x1: 138, y1: 140 },
        { x0: 142, y0: 102, x1: 180, y1: 140 }
      ]
    }
    const l = line([w], { bbox: { x0: 100, y0: 100, x1: 180, y1: 140 }, xHeight: 0 })
    expect(lineSizePx(l, '漢字')).toBeCloseTo(Math.max(40, CJK_CHAR_EM * 39), 6)
  })
})

describe('filter and text', () => {
  it('drops empty, negative-confidence, noise, tall and extreme-aspect words', () => {
    expect(dropReason(word('', 0, 10), '', 30)).toBe('empty')
    expect(dropReason(word('ab', 0, 10, -1), 'ab', 30)).toBe('negative-conf')
    expect(dropReason(word('ab', 0, 10, 20), 'ab', 30)).toBe('noise')
    expect(dropReason(word('~~~', 0, 30, 20), '~~~', 30)).toBe('noise')
    expect(dropReason(word('abc', 0, 30, 20), 'abc', 30)).toBeNull() // low-confidence real word: kept
    expect(dropReason(word('I', 0, 10, 90, 0, 100), 'I', 30)).toBe('tall')
    expect(dropReason(word('____', 0, 1000, 90, 0, 30), '____', 30)).toBe('aspect')
    expect(dropReason(word('|', 0, 1, 90, 0, 40), '|', 40)).toBe('aspect')
    expect(dropReason(word('ok', 0, 30, null), 'ok', 30)).toBeNull()
  })

  it('cleans text (NFC, ligatures, ignorables) and drops words that clean to nothing', () => {
    const p = mapRawOcrPage(
      raw(line([word('ﬁne', 100, 200), word('​﻿', 220, 260), word('café', 300, 400)])),
      CTX
    )
    expect(p.lines[0].words.map((w) => w.t)).toEqual(['fine', 'café'])
  })

  it('a page with no surviving word is no-text; a low mean is low-confidence', () => {
    expect(mapRawOcrPage(raw(line([word('~', 100, 110, 5)])), CTX).status).toBe('no-text')
    expect(mapRawOcrPage(raw(), CTX)).toMatchObject({
      status: 'no-text',
      lines: [],
      meanConfCal: null,
      confSource: 'none'
    })
    const low = mapRawOcrPage(
      raw(line([word('blurry', 100, 300, 40), word('words', 320, 500, 45)])),
      CTX
    )
    expect(low.status).toBe('low-confidence')
    expect(low.meanConfCal).toBeLessThan(calibrate(TESS_CORE7_PLACEHOLDER, RAW_THRESHOLDS.flag)!)
  })

  it('char edges: n + 1 cumulative boundaries from the cinfo gaps, only for unchanged text', () => {
    const w: RawWord = {
      ...word('abc', 100, 160),
      chars: [
        { x0: 100, y0: 100, x1: 118, y1: 134 },
        { x0: 122, y0: 100, x1: 138, y1: 134 },
        { x0: 142, y0: 100, x1: 160, y1: 134 }
      ]
    }
    const e = charEdges(w, 'abc', 60 * 0.24)!
    expect([...e].map((v) => +v.toFixed(4))).toEqual([0, 4.8, 9.6, 14.4])
    expect(charEdges(w, 'abd', 14.4)).toBeUndefined() // cleaned text differs
    expect(charEdges({ ...w, chars: w.chars!.slice(0, 2) }, 'abc', 14.4)).toBeUndefined()
    expect(charEdges({ ...w, chars: undefined }, 'abc', 14.4)).toBeUndefined()
  })

  it('carries line languages and packs', () => {
    const packed = mapRawOcr(
      raw(
        line([word('Hallo', 100, 200)], { lang: 'deu' }),
        line([word('x1', 100, 200, 95, 200, 234)], { bbox: { x0: 100, y0: 200, x1: 300, y1: 234 } })
      ),
      CTX
    )
    expect(wordCount(packed)).toBe(2)
    expect(packed.lineLang).toEqual(['deu', null])
    expect(unpack(packed).lines[0].lang).toBe('deu')
  })
})

describe('calibration placeholder', () => {
  it('is a valid 21-point monotone table marked as a placeholder', () => {
    expect(TESS_CORE7_PLACEHOLDER.points).toHaveLength(21)
    expect(TESS_CORE7_PLACEHOLDER.placeholder).toBe(true)
    expect(() => assertCalibrationTable(TESS_CORE7_PLACEHOLDER)).not.toThrow()
    expect(calibrate(TESS_CORE7_PLACEHOLDER, null)).toBeNull()
    expect(calibrate(TESS_CORE7_PLACEHOLDER, 72.5)).toBeCloseTo(0.725, 9)
    expect(calibrate(TESS_CORE7_PLACEHOLDER, -3)).toBe(0)
    expect(calibrate(TESS_CORE7_PLACEHOLDER, 140)).toBe(1)
    let prev = -1
    for (let r = 0; r <= 100; r += 0.5) {
      const p = calibrate(TESS_CORE7_PLACEHOLDER, r)!
      expect(p).toBeGreaterThanOrEqual(prev)
      prev = p
    }
  })

  it('rejects non-monotone or out-of-range tables', () => {
    const t = (points: [number, number][]) => ({ engineId: 'x', placeholder: false, points })
    expect(() => assertCalibrationTable(t([[0, 0]]))).toThrow()
    expect(() =>
      assertCalibrationTable(
        t([
          [0, 0.5],
          [50, 0.4]
        ])
      )
    ).toThrow()
    expect(() =>
      assertCalibrationTable(
        t([
          [0, 0],
          [0, 0.4]
        ])
      )
    ).toThrow()
    expect(() =>
      assertCalibrationTable(
        t([
          [0, 0],
          [101, 1]
        ])
      )
    ).toThrow()
  })
})

describe('replayed clean300 recording', () => {
  it('maps onto the ground truth: exact text, Find recall 1, boxes on target', async () => {
    const entry = readEntryById('clean300')
    const deps = await loadNodeSynthDeps()
    const { gt, raster } = await synthesize({ preset: 'clean300', seed: 1 }, deps)
    expect(entry.input).toMatchObject({ width: raster.width, height: raster.height, dpi: gt.dpi })
    const page = mapRawOcrPage(hocrToRaw(parseHocr(decodeEntry(entry))), {
      ...CTX,
      page: gt.page,
      raster: gt.raster,
      renderDpi: gt.dpi
    })
    const s = await scorePage(page, gt)
    expect(s.cer).toBe(0)
    expect(s.recall).toBe(1)
    expect(s.hitOnTarget).toBe(1)
    expect(s.hmean).toBeGreaterThan(0.95)
    expect(s.medianIou).toBeGreaterThan(0.75)
    // Every word has char edges (one per code point), monotone, ending at w.
    for (const l of page.lines)
      for (const w of l.words) {
        expect(w.chars, w.t).toBeDefined()
        expect(w.chars!.length).toBe([...w.t].length + 1)
        expect(w.chars![w.chars!.length - 1]).toBeCloseTo(w.w, 4)
        for (let i = 1; i < w.chars!.length; i++)
          expect(w.chars![i]).toBeGreaterThanOrEqual(w.chars![i - 1])
      }
  })
})
