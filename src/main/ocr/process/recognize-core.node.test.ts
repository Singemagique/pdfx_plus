// The recognize thread's pipeline (DESIGN.md §3.4.3–§3.4.6) with a scripted engine: the pass
// plan (pass 1, the 0°/180° band test, Retry A, Retry B, the 3-recognition budget), the geometry
// it reports back (pad, quarter turns, deskew), the adaptive request and the reuse call, and the
// failure shapes the coordinator's policy reads.

import { describe, expect, it } from 'vitest'

import { TESS_CORE7, TESS_CORE7_PLACEHOLDER } from '../../../shared/ocr/calibration'
import {
  TessError,
  type TessErrorKind,
  type TessParams
} from '../../../shared/ocr/engine/tess-core'
import type { GrayImage } from '../../../shared/ocr/engine/types'
import { HocrError } from '../../../shared/ocr/hocr'
import { applyAffine, rotateBilinear } from '../../../shared/ocr/preprocess/geometry'
import { decodeEntry, readEntryById } from '../test-utils/ocr-cache'
import { isOomShaped } from './coordinator'
import {
  ADAPTIVE_XH,
  MAX_PASSES,
  adaptiveRequest,
  adaptiveSkip,
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

interface W {
  t: string
  conf: number
}
/** A minimal Tesseract-shaped hOCR: one line per entry, words 60 px wide, 30 px tall. */
function hocr(lines: W[][], xh = 20): string {
  let out = `<div class='ocr_page' id='page_1' title='image "unknown"; bbox 0 0 2000 2000; ppageno 0'>\n`
  out += `<div class='ocr_carea' id='block_1_1' title="bbox 0 0 2000 2000">\n`
  out += `<p class='ocr_par' id='par_1_1' lang='eng' title="bbox 0 0 2000 2000">\n`
  lines.forEach((ws, i) => {
    const y = 100 + i * 50
    out += `<span class='ocr_line' id='line_1_${i}' title="bbox 100 ${y} ${100 + ws.length * 70} ${y + 30}; baseline 0 -6; x_size ${xh + 14}; x_descenders 6; x_ascenders 8">\n`
    ws.forEach((w, k) => {
      const x = 100 + k * 70
      out += `<span class='ocrx_word' id='word_1_${i}_${k}' title='bbox ${x} ${y} ${x + 60} ${y + 30}; x_wconf ${w.conf}'>${w.t}</span>\n`
    })
    out += `</span>\n`
  })
  return out + `</p>\n</div>\n</div>\n`
}

const words = (n: number, conf: number, t = 'harbour'): W[] =>
  Array.from({ length: n }, () => ({ t, conf }))

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
    expect(out.passes.map((p) => p.id)).toEqual(['pass1', 'band', 'band-flipped', 'sauvola'])
    expect(calls[3].params.thresholding_method).toBe(2)
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

  it('is skipped when the first result already reads with high calibrated confidence', () => {
    const confident = hocr([words(8, 97), words(8, 97)], 12)
    const { engine } = scripted(() => confident)
    expect(adaptiveSkip(recognizePage(engine, blank(), 300).raw, TESS_CORE7)).toBe(true)
    expect(recognizePage(engine, blank(), 300).adaptive).toBeNull()
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
