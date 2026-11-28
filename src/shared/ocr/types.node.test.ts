import { describe, expect, it } from 'vitest'

import {
  footprintPad,
  lineCount,
  ocrLines,
  pack,
  packedWord,
  unpack,
  wordCount,
  wordFootprint,
  wordQuad,
  type OcrLine,
  type OcrPage
} from './types'

const page = (lines: OcrPage['lines']): OcrPage => ({
  v: 1,
  engineId: 'tess-lstm/core-7.0.0',
  dataHashes: { eng: 'abc' },
  langs: ['eng', 'deu'],
  pipelineVersion: 3,
  pageClass: 'scanned',
  renderDpi: 300,
  physDpi: 300,
  orientation: 0,
  skewDeg: 0.5,
  meanConfCal: 0.9,
  confSource: 'word',
  status: 'ok',
  lines
})

const SAMPLE = page([
  {
    angle: 0,
    size: 11,
    lang: 'eng',
    words: [
      { t: 'Hello', x: 24, y: 700.5, w: 27.5, conf: 96, confCal: 0.875 },
      { t: 'wörld', x: 55.25, y: 700.5, w: 30, conf: null, confCal: null }
    ]
  },
  {
    angle: 0.25,
    size: 9,
    words: [
      {
        t: '𝐀b',
        x: 24,
        y: 680,
        w: 12,
        conf: 50,
        confCal: 0.375,
        chars: new Float32Array([0, 7, 12])
      }
    ]
  },
  { angle: 0, size: 10, words: [] }
])

describe('pack / unpack', () => {
  it('round-trips every field (Float32 geometry, NaN ⇄ null, chars, line langs)', () => {
    const p = pack(SAMPLE)
    expect(wordCount(p)).toBe(3)
    expect(lineCount(p)).toBe(3)
    expect(p.text).toBe('Hellowörld𝐀b')
    expect([...p.wordOff]).toEqual([0, 5, 10, 13])
    expect([...p.wordLine]).toEqual([0, 2, 3, 3])
    expect(Number.isNaN(p.wordGeom[1 * 5 + 3])).toBe(true)
    expect(p.lineLang).toEqual(['eng', null, null])
    expect([...p.charOff!]).toEqual([0, 0, 0, 3])
    const back = unpack(p)
    expect(back).toEqual(SAMPLE)
    // The packed page has no lines; the unpacked one carries no packed arrays.
    expect('lines' in p).toBe(false)
    expect(Object.keys(back)).not.toContain('wordGeom')
  })

  it('omits the optional side arrays when nothing uses them', () => {
    const p = pack(
      page([{ angle: 0, size: 10, words: [{ t: 'a', x: 1, y: 2, w: 3, conf: 1, confCal: 0 }] }])
    )
    expect(p.lineLang).toBeUndefined()
    expect(p.charEdges).toBeUndefined()
    expect(p.charOff).toBeUndefined()
  })

  it('survives structured clone (what crosses the message port)', () => {
    const p = structuredClone(pack(SAMPLE))
    expect(unpack(p)).toEqual(SAMPLE)
  })

  it('walks lines lazily and reads single words', () => {
    const p = pack(SAMPLE)
    const first = ocrLines(p).next()
    expect(first.done).toBe(false)
    expect((first.value as OcrLine).words.map((w) => w.t)).toEqual(['Hello', 'wörld'])
    expect(packedWord(p, 2).chars).toEqual(new Float32Array([0, 7, 12]))
    expect(packedWord(p, 0).chars).toBeUndefined()
  })

  it('handles an empty page', () => {
    const p = pack(page([]))
    expect(wordCount(p)).toBe(0)
    expect(unpack(p).lines).toEqual([])
  })
})

describe('word footprint', () => {
  it('is the em box about the baseline origin, padded by max(1 pt, 0.15·size)', () => {
    const fp = wordFootprint({ x: 100, y: 200, w: 50 }, { angle: 0, size: 20 })
    expect(fp).toEqual({ x0: 97, y0: 193, x1: 153, y1: 219 })
    // Small text: the 1 pt floor applies.
    const small = wordFootprint({ x: 0, y: 0, w: 10 }, { angle: 0, size: 4 })
    expect(footprintPad(4)).toBe(1)
    expect(small.x0).toBeCloseTo(-1)
    expect(small.y0).toBeCloseTo(-0.8 - 1)
    expect(small.y1).toBeCloseTo(3.2 + 1)
  })

  it('rotates the box about the baseline origin', () => {
    const q = wordQuad({ x: 10, y: 10, w: 30 }, { angle: Math.PI / 2, size: 10 })
    // A 90° CCW line runs up the page; "up" (ascent) points to -x.
    expect(q[0].x).toBeCloseTo(12)
    expect(q[0].y).toBeCloseTo(10)
    expect(q[1].x).toBeCloseTo(12)
    expect(q[1].y).toBeCloseTo(40)
    expect(q[2].x).toBeCloseTo(2)
    expect(q[2].y).toBeCloseTo(40)
    const fp = wordFootprint({ x: 10, y: 10, w: 30 }, { angle: Math.PI / 2, size: 10 })
    expect(fp.x0).toBeCloseTo(2 - 1.5)
    expect(fp.x1).toBeCloseTo(12 + 1.5)
    expect(fp.y0).toBeCloseTo(10 - 1.5)
    expect(fp.y1).toBeCloseTo(40 + 1.5)
  })
})
