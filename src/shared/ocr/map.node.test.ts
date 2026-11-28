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
  XHEIGHT_EM,
  charEdges,
  dropReason,
  lineOrientation,
  lineSizePx,
  mapRawOcr,
  mapRawOcrPage,
  nativeOverlap,
  noXHeightScript,
  pixelToOverlay,
  splitWideGaps,
  type MapContext
} from './map'
import { decodeEntry, readEntryById } from './test-utils/ocr-replay'
import { loadNodeSynthDeps } from './test-utils/node-deps'
import { iou } from './test-utils/metrics'
import { emBox, scorePage } from './test-utils/ocr-eval'
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
    // xh 25 px / XHEIGHT_EM (0.56) = 44.6 px em = 10.7 pt (within the clamp [34, 68] px).
    expect(l.size).toBeCloseTo((25 / XHEIGHT_EM) * 0.24, 6)
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

  it('a snapped line keeps every word on its OWN baseline (only the angle snaps)', () => {
    // 0.01 < tan 1°: angle 0. The last word starts 800 px right of the first, so its baseline is
    // 8 px (1.92 pt) lower on screen; a shared y would put it off its ink by that much.
    const p = mapRawOcrPage(
      raw(
        line([word('first', 100, 200), word('last', 900, 1000, 95, 108, 142)], {
          baseline: { slope: 0.01, intercept: -8 }
        })
      ),
      CTX
    )
    const [a, b] = p.lines[0].words
    expect(p.lines[0].angle).toBe(0)
    expect(a.y).toBeCloseTo(180 - 126 * 0.24, 6)
    expect(b.y).toBeCloseTo(180 - (126 + 0.01 * 800) * 0.24, 6)
    expect(a.y - b.y).toBeCloseTo(1.92, 6)
    // Horizontal: the width is the box's run along x.
    expect(b.w).toBeCloseTo(100 * 0.24, 6)
  })
})

describe('rotated lines (textangle, or vertical text without a baseline)', () => {
  // A 9 pt label reading bottom to top: Tesseract's textangle-90 shape (no baseline, words in
  // reading order, cinfo boxes degenerate at x = 0).
  const rot = (over: Partial<RawLine> = {}, words?: RawWord[]): RawLine =>
    line(
      words ?? [
        {
          text: 'Rain',
          bbox: { x0: 56, y0: 620, x1: 84, y1: 700 },
          conf: 96,
          chars: [0, 1, 2, 3].map((i) => ({ x0: 0, y0: 600 + i, x1: 0, y1: 600 + i }))
        },
        { text: 'delayed', bbox: { x0: 56, y0: 480, x1: 91, y1: 600 }, conf: 96 }
      ],
      {
        bbox: { x0: 56, y0: 100, x1: 91, y1: 700 },
        baseline: null,
        angle: 90,
        descenders: 7,
        xHeight: 21,
        size: 35,
        ...over
      }
    )

  it('textangle 90: up the page, anchored at each box bottom on the descender-side baseline', () => {
    const p = mapRawOcrPage(raw(rot()), CTX)
    const [l] = p.lines
    expect(l.angle).toBeCloseTo(Math.PI / 2, 12)
    // x-height 21 px / XHEIGHT_EM = 37.5 px, within [35, 70] (the line box WIDTH, not its 600 px
    // height).
    expect(l.size).toBeCloseTo((21 / XHEIGHT_EM) * 0.24, 6)
    const [a, b] = l.words
    expect(a).toMatchObject({ t: 'Rain' })
    expect(a.x).toBeCloseTo((91 - 7) * 0.24, 6)
    expect(a.y).toBeCloseTo(180 - 700 * 0.24, 6)
    expect(a.w).toBeCloseTo(80 * 0.24, 6)
    expect(b.x).toBeCloseTo(a.x, 9)
    expect(b.y).toBeCloseTo(180 - 600 * 0.24, 6)
    expect(b.w).toBeCloseTo(120 * 0.24, 6)
    // Degenerate cinfo boxes are never used: the layer spaces the word evenly.
    expect(a.chars).toBeUndefined()
    // The em box covers the word's ink box (x 56..84 px, y 620..700 px).
    const em = emBox(a, l)
    expect(em.x).toBeLessThanOrEqual(56 * 0.24)
    expect(em.x + em.w).toBeGreaterThanOrEqual(84 * 0.24)
    expect(em.y).toBeCloseTo(180 - 700 * 0.24, 6)
    expect(em.y + em.h).toBeCloseTo(180 - 620 * 0.24, 6)
  })

  it('textangle 270: down the page from each box top, baseline on the left side', () => {
    const p = mapRawOcrPage(
      raw(
        rot({ angle: 270 }, [
          { text: 'down', bbox: { x0: 56, y0: 100, x1: 84, y1: 200 }, conf: 96 },
          { text: 'here', bbox: { x0: 56, y0: 220, x1: 84, y1: 300 }, conf: 96 }
        ])
      ),
      CTX
    )
    const [l] = p.lines
    expect(l.angle).toBeCloseTo(-Math.PI / 2, 12)
    expect(l.words.map((w) => [w.x, w.y, w.w].map((v) => +v.toFixed(4)))).toEqual([
      [(56 + 7) * 0.24, 180 - 100 * 0.24, 100 * 0.24].map((v) => +v.toFixed(4)),
      [(56 + 7) * 0.24, 180 - 220 * 0.24, 80 * 0.24].map((v) => +v.toFixed(4))
    ])
  })

  it('textangle 180: right to left from each box right edge, char edges from that edge', () => {
    const w: RawWord = {
      text: 'ab',
      bbox: { x0: 300, y0: 100, x1: 340, y1: 134 },
      conf: 95,
      // Reading order: 'a' is the RIGHT box.
      chars: [
        { x0: 322, y0: 100, x1: 340, y1: 134 },
        { x0: 300, y0: 100, x1: 318, y1: 134 }
      ]
    }
    const p = mapRawOcrPage(
      raw(line([w], { baseline: null, angle: 180, descenders: 8, bbox: w.bbox })),
      CTX
    )
    const [l] = p.lines
    expect(l.angle).toBeCloseTo(Math.PI, 12)
    const [a] = l.words
    expect(a.x).toBeCloseTo(340 * 0.24, 6)
    expect(a.y).toBeCloseTo(180 - 108 * 0.24, 6)
    expect(a.w).toBeCloseTo(40 * 0.24, 6)
    // The boundary is the gap's midpoint (320 px), 20 px from the start edge.
    expect([...a.chars!].map((v) => +v.toFixed(4))).toEqual([0, 4.8, 9.6])
  })

  it('a tall line with neither baseline nor textangle is vertical: top to bottom unless it runs up', () => {
    const down = rot({ angle: undefined }, [
      { text: 'x', bbox: { x0: 56, y0: 100, x1: 84, y1: 200 }, conf: 96 },
      { text: 'y', bbox: { x0: 56, y0: 220, x1: 84, y1: 300 }, conf: 96 }
    ])
    expect(lineOrientation(down)).toBe(270)
    expect(lineOrientation({ ...down, words: [...down.words].reverse() })).toBe(90)
    expect(lineOrientation(rot({ angle: undefined }))).toBe(90)
    // Wide lines without a baseline stay horizontal (the word-bottom fallback).
    expect(lineOrientation(line([word('a', 100, 200)], { baseline: null }))).toBe(0)
    const p = mapRawOcrPage(raw(down), CTX)
    expect(p.lines[0].angle).toBeCloseTo(-Math.PI / 2, 12)
    // Distinct words, distinct places (the old mapping put every word of such a line on one point).
    const ys = p.lines[0].words.map((w) => w.y)
    expect(new Set(ys).size).toBe(2)
  })

  it('an oblique textangle is dropped, never mapped as if horizontal', () => {
    expect(lineOrientation(rot({ angle: 45 }))).toBeNull()
    expect(lineOrientation(rot({ angle: 90.5 }))).toBeNull()
    expect(lineOrientation(rot({ angle: -90 }))).toBe(270)
    expect(lineOrientation(rot({ angle: 450 }))).toBe(90)
    expect(mapRawOcrPage(raw(rot({ angle: 45 })), CTX).lines).toEqual([])
  })

  it('the filter measures a vertical word ACROSS the line (a long word is not "tall")', () => {
    const long: RawWord = {
      text: 'temperature',
      bbox: { x0: 56, y0: 100, x1: 84, y1: 500 },
      conf: 96
    }
    const short: RawWord = { text: 'a', bbox: { x0: 60, y0: 520, x1: 80, y1: 540 }, conf: 96 }
    expect(dropReason(long, 'temperature', 24, true)).toBeNull()
    expect(dropReason(long, 'temperature', 24)).toBe('tall')
    expect(mapRawOcrPage(raw(rot({}, [short, long])), CTX).lines[0].words.map((w) => w.t)).toEqual([
      'a',
      'temperature'
    ])
  })
})

describe('font size by script', () => {
  it('Latin: x-height / XHEIGHT_EM, clamped to [line ink height, 2× it]', () => {
    const l = line([word('ab', 100, 200)])
    expect(lineSizePx(l, 'ab')).toBeCloseTo(25 / XHEIGHT_EM, 6)
    // The PR6 refit (0.56); a context can sweep it (the calibration run).
    expect(XHEIGHT_EM).toBe(0.56)
    expect(lineSizePx(l, 'ab', false, { xHeightEm: 0.5, cjkCharEm: CJK_CHAR_EM })).toBeCloseTo(
      50,
      6
    )
    expect(lineSizePx({ ...l, xHeight: 10 }, 'ab')).toBe(34) // floor: the line box
    expect(lineSizePx({ ...l, xHeight: 40 }, 'ab')).toBe(68) // ceiling: 2× the line box
    expect(lineSizePx({ ...l, xHeight: 0 }, 'ab')).toBe(34) // unknown: the line box
  })

  it('a tilted line box taller than 1.5× its words uses the median word height', () => {
    const tall = line([word('a', 100, 200, 95, 100, 130), word('b', 300, 400, 95, 120, 150)], {
      bbox: { x0: 100, y0: 100, x1: 400, y1: 200 }
    })
    expect(lineSizePx({ ...tall, xHeight: 25 }, 'ab')).toBeCloseTo(25 / XHEIGHT_EM, 9)
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
    // Untrustworthy boxes: degenerate (what rotated lines carry), or outside the word's box.
    const degenerate = w.chars!.map((c) => ({ ...c, x0: 0, x1: 0 }))
    expect(charEdges({ ...w, chars: degenerate }, 'abc', 14.4)).toBeUndefined()
    const outside = w.chars!.map((c, i) => (i === 1 ? { ...c, y0: 900, y1: 934 } : c))
    expect(charEdges({ ...w, chars: outside }, 'abc', 14.4)).toBeUndefined()
    const leftOf = w.chars!.map((c, i) => (i === 0 ? { ...c, x0: 90 } : c))
    expect(charEdges({ ...w, chars: leftOf }, 'abc', 14.4)).toBeUndefined()
    const rightOf = w.chars!.map((c, i) => (i === 2 ? { ...c, x1: 170 } : c))
    expect(charEdges({ ...w, chars: rightOf }, 'abc', 14.4)).toBeUndefined()
    // Within the slack (2 px) they are still used.
    const snug = w.chars!.map((c, i) => (i === 0 ? { ...c, x0: 99 } : c))
    expect(charEdges({ ...w, chars: snug }, 'abc', 14.4)).toBeDefined()
    // Never on a vertical line, whatever the boxes say.
    expect(charEdges(w, 'abc', 14.4, 90)).toBeUndefined()
    expect(charEdges(w, 'abc', 14.4, 270)).toBeUndefined()
  })

  it('the page mean is weighted by characters, so long words count for more', () => {
    // 'abcdefghij' at 70 and 'xyz' at 32: per character (0.7·10 + 0.32·3) / 13 = 0.612 is above
    // the 0.6 flag (ok); a per-word mean, (0.7 + 0.32) / 2 = 0.51, would flag the page.
    const p = mapRawOcrPage(
      raw(line([word('abcdefghij', 100, 400, 70), word('xyz', 420, 500, 32)])),
      CTX
    )
    expect(p.meanConfCal).toBeCloseTo((0.7 * 10 + 0.32 * 3) / 13, 9)
    expect(calibrate(TESS_CORE7_PLACEHOLDER, RAW_THRESHOLDS.flag)).toBeCloseTo(0.6, 9)
    expect(p.status).toBe('ok')
    // Swap the confidences and the same rule flags it: (0.32·10 + 0.7·3) / 13 = 0.408.
    const q = mapRawOcrPage(
      raw(line([word('abcdefghij', 100, 400, 32), word('xyz', 420, 500, 70)])),
      CTX
    )
    expect(q.meanConfCal).toBeCloseTo((0.32 * 10 + 0.7 * 3) / 13, 9)
    expect(q.status).toBe('low-confidence')
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

describe('replayed recordings: sub-1° skew and rotated lines (PR5 review)', () => {
  async function replay(id: string) {
    const deps = await loadNodeSynthDeps()
    const { gt } = await synthesize({ preset: id, seed: 1 }, deps)
    const page = mapRawOcrPage(hocrToRaw(parseHocr(decodeEntry(readEntryById(id)))), {
      ...CTX,
      page: gt.page,
      raster: gt.raster,
      renderDpi: gt.dpi
    })
    return { gt, page, s: await scorePage(page, gt) }
  }

  for (const id of ['skew0p6', 'skewm0p6'])
    it(`${id}: angle snapped to 0, every word still on its own ink`, async () => {
      const { page, s } = await replay(id)
      expect(page.lines.every((l) => l.angle === 0)).toBe(true)
      expect(s.cer).toBe(0)
      // A shared per-line y gave hmean 0.72 / median IoU 0.67 / recall 0.73 at −0.6° [measured].
      expect(s.recall).toBe(1)
      expect(s.hmean).toBeGreaterThan(0.95)
      expect(s.medianIou).toBeGreaterThan(0.78)
    })

  it('margin-label: the textangle-90 labels lie along the margins, each word on its own box', async () => {
    const { gt, page, s } = await replay('margin-label')
    const vertical = page.lines.filter((l) => Math.abs(l.angle - Math.PI / 2) < 1e-9)
    expect(vertical).toHaveLength(2)
    // The left label reads bottom to top and is recognised: word for word on its GT box.
    const [left] = vertical
    const gtLeft = gt.lines.find((l) => l.rotate === 90)!
    expect(left.words.map((w) => w.t).join(' ')).toBe(gtLeft.text)
    left.words.forEach((w, i) => {
      const g = gt.words[gtLeft.words[i]]
      expect(iou(emBox(w, left), g.box), w.t).toBeGreaterThan(0.5)
    })
    // The right one Tesseract reads upside down (garbage text) but places in the right margin.
    const right = vertical[1]
    for (const w of right.words) expect(emBox(w, right).x).toBeGreaterThan(400)
    // The old mapping put every word of a vertical line on one point: hmean 0.906 [measured].
    expect(s.hmean).toBeGreaterThan(0.98)
  })

  it('rot90page: Tesseract lines without baseline or textangle run down the page, uncollapsed', async () => {
    const { page, s } = await replay('rot90page')
    expect(page.lines.length).toBeGreaterThan(0)
    for (const l of page.lines) {
      expect(l.angle).toBeCloseTo(-Math.PI / 2, 12)
      const ys = l.words.map((w) => w.y)
      expect(new Set(ys).size, 'one point per word').toBe(ys.length)
    }
    // Orientation is PR6 (the text is garbage until the page is turned), but every box is in
    // place: 0.07 before (all words of a line on one point) [measured].
    expect(s.hmean).toBeGreaterThan(0.95)
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

describe('PR6 post-processing', () => {
  const charred = (text: string, x0: number, gaps: number[]): RawWord => {
    // One 20 px box per char; gaps[i] px between char i and i + 1.
    const chars: { x0: number; y0: number; x1: number; y1: number }[] = []
    let x = x0
    for (let i = 0; i < [...text].length; i++) {
      chars.push({ x0: x, y0: 100, x1: x + 20, y1: 134 })
      x += 20 + (gaps[i] ?? 2)
    }
    return { text, bbox: { x0, y0: 100, x1: x - (gaps.at(-1) ?? 2), y1: 134 }, conf: 90, chars }
  }

  it('splits a word at a space-wide gap between its char boxes (a missed space)', () => {
    // Words 30 px apart; "€97" has a 24 px gap after the €.
    const l = line([
      charred('Invoice', 100, []),
      charred('€97', 270, [24, 2]),
      charred('due', 400, []),
      charred('today', 500, [])
    ])
    const out = splitWideGaps(l)
    expect(out.words.map((w) => w.text)).toEqual(['Invoice', '€', '97', 'due', 'today'])
    expect(out.words[1].bbox).toEqual({ x0: 270, y0: 100, x1: 290, y1: 134 })
    expect(out.words[2].chars).toHaveLength(2)
    expect(out.words[2].conf).toBe(90)
  })

  it('leaves ordinary words, short lines and words without char boxes alone', () => {
    const l = line([charred('one', 100, []), charred('two', 200, []), charred('six', 300, [])])
    expect(splitWideGaps(l)).toBe(l)
    const k = line([
      charred('alpha', 100, [3, 3, 3, 3]),
      word('beta', 260, 340),
      charred('gamma', 380, []),
      charred('delta', 520, [])
    ])
    expect(splitWideGaps(k)).toBe(k)
  })

  it('an upside-down copy (180° affine) gives lines at angle π, words running right to left', () => {
    const turn: MapContext = {
      ...CTX,
      toOverlay: [-0.24, 0, 0, 0.24, 432, 0],
      orientation: 180
    }
    const p = mapRawOcrPage(raw(line([word('Hello', 100, 220), word('world', 250, 400)])), turn)
    const [l] = p.lines
    expect(l.angle).toBe(Math.PI)
    expect(p.orientation).toBe(180)
    // "Hello" starts at the copy's x = 100 → page x = 432 − 24 and runs left 28.8 pt.
    expect(l.words[0].x).toBeCloseTo(432 - 24, 6)
    expect(l.words[0].w).toBeCloseTo(28.8, 6)
    expect(pixelToOverlay(CTX.page, CTX.raster)).toEqual([0.24, 0, 0, -0.24, 0, 180])
  })

  it('near-scanned: drops OCR words lying mostly on native visible text', () => {
    const l = line([word('Hello', 100, 220), word('world', 250, 400)])
    const base = mapRawOcrPage(raw(l), CTX)
    const [hello, world] = base.lines[0].words
    const quad = { angle: 0, size: base.lines[0].size }
    const box = { x0: hello.x - 1, y0: hello.y - 5, x1: hello.x + hello.w + 1, y1: hello.y + 20 }
    expect(nativeOverlap(hello, quad, [box])).toBeGreaterThan(0.9)
    expect(nativeOverlap(world, quad, [box])).toBe(0)
    const p = mapRawOcrPage(raw(l), { ...CTX, native: [box] })
    expect(p.lines[0].words.map((w) => w.t)).toEqual(['world'])
    // Every word on native text: the line goes.
    const both = { x0: 0, y0: 0, x1: 432, y1: 180 }
    expect(mapRawOcrPage(raw(l), { ...CTX, native: [both] }).lines).toHaveLength(0)
  })
})
