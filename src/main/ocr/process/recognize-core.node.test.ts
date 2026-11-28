// The recognize thread's pass plan (DESIGN.md §3.4.5) with a scripted engine: PR5 runs pass 1
// only (PSM 3, Otsu, at the page's DPI), parses its hOCR and reports per-pass timings and scores;
// a parse failure fails the page.

import { describe, expect, it } from 'vitest'

import { TessError, type TessErrorKind } from '../../../shared/ocr/engine/tess-core'
import { HocrError } from '../../../shared/ocr/hocr'
import { decodeEntry, readEntryById } from '../test-utils/ocr-cache'
import { isOomShaped } from './coordinator'
import {
  describeRecognizeError,
  firstPass,
  nextPass,
  passScore,
  recognizePage,
  type RecognizeEngine
} from './recognize-core'

const IMG = { width: 4, height: 4, data: new Uint8Array(16).fill(255) }

describe('recognizePage', () => {
  it('runs pass 1 with the page DPI and returns the parsed RawOcr', () => {
    const hocr = decodeEntry(readEntryById('clean300'))
    const seen: unknown[] = []
    const engine: RecognizeEngine = {
      recognize: (_img, params) => {
        seen.push(params)
        return { hocr }
      }
    }
    let t = 0
    const out = recognizePage(engine, IMG, 300, { now: () => (t += 10), returnHocr: true })
    expect(seen).toEqual([firstPass(300).params])
    expect(seen[0]).toMatchObject({
      tessedit_pageseg_mode: 3,
      thresholding_method: 0,
      user_defined_dpi: 300
    })
    expect(out.chosen).toBe('pass1')
    expect(out.passes).toEqual([{ id: 'pass1', ms: 10, words: 116, score: passScore(out.raw) }])
    expect(out.raw.lines).toHaveLength(9)
    expect(out.hocr).toEqual([hocr])
    expect(recognizePage(engine, IMG, 300).hocr).toBeUndefined()
  })

  it('stops after pass 1 (retries are PR6)', () => {
    expect(nextPass([{ id: 'pass1', ms: 1, words: 0, score: 0 }], 300)).toBeNull()
  })

  it('a malformed hOCR fails the page', () => {
    expect(() => recognizePage({ recognize: () => ({ hocr: '<div>' }) }, IMG, 300)).toThrow()
  })

  it('what the thread posts for a failure, and whether the coordinator halves n for it', () => {
    // The chain DESIGN §3.9 tier 0 asks for: a WASM OOM (TessError 'oom': rc −1 with empty hOCR,
    // an abort naming an allocation failure, a failed Wasm memory reservation) must arrive
    // OOM-shaped; nothing else may.
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
    // A strict-parse failure is a failed page, never memory; a long message is cut.
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
