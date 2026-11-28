// The triage messages of the OCR port protocol (DESIGN.md §3.3.1, §3.4.1): the renderer's
// `triage` request and the coordinator's `triaged` answer, validated as strictly as the rest.

import { describe, expect, it } from 'vitest'

import {
  JPX_REFUSALS,
  PAGE_CLASSES,
  PAGE_REASONS,
  TRIAGE_WORD_LIMITS,
  parseFromOcr,
  parseOcrToMain,
  parseToOcr,
  type TriagePage
} from './protocol'

const page = (over: Partial<TriagePage> = {}): TriagePage => ({
  index: 0,
  pageClass: 'near-scanned',
  renderDpi: 300,
  raster: { width: 2550, height: 3300 },
  effectiveDpi: 200,
  bitsPerPixel: 1,
  imageOrigin: false,
  nativeWords: [{ t: 'Page', x0: 10, y0: 770, x1: 30, y1: 780 }],
  ...over
})

const triaged = (pages: unknown[], done = true): unknown => ({
  triaged: { src: 's1', pages, done }
})

describe('triage messages', () => {
  it('accepts a request for all pages or a list, and refuses paths and junk', () => {
    expect(parseToOcr({ triage: { src: 's1' } })).toEqual({ triage: { src: 's1' } })
    expect(parseToOcr({ triage: { src: 's1', pages: [0, 3] } })).toEqual({
      triage: { src: 's1', pages: [0, 3] }
    })
    expect(() => parseToOcr({ triage: { src: 'C:\\x.pdf' } })).toThrow(/token/)
    expect(() => parseToOcr({ triage: { src: 's1', pages: [-1] } })).toThrow()
    expect(() => parseToOcr({ triage: { src: 's1', all: true } })).toThrow(/unknown key/)
  })

  it('accepts every class, refusal and the failure shape', () => {
    for (const pageClass of PAGE_CLASSES)
      expect(() => parseFromOcr(triaged([page({ pageClass })]))).not.toThrow()
    for (const refused of JPX_REFUSALS)
      expect(() => parseFromOcr(triaged([page({ refused })]))).not.toThrow()
    const failed: TriagePage = {
      index: 4,
      pageClass: null,
      failure: 'raster-crash',
      renderDpi: null,
      raster: null,
      effectiveDpi: null,
      bitsPerPixel: null,
      imageOrigin: false
    }
    expect(parseFromOcr(triaged([failed], false))).toEqual(triaged([failed], false))
    expect(PAGE_REASONS).toContain('image-format')
  })

  it("main's activity message carries an optional triage flag", () => {
    const a = { busy: false, done: 0, total: 0 }
    expect(parseOcrToMain({ activity: a })).toEqual({ activity: a })
    expect(parseOcrToMain({ activity: { ...a, triage: true } })).toEqual({
      activity: { ...a, triage: true }
    })
    expect(() => parseOcrToMain({ activity: { ...a, triage: 1 } })).toThrow()
  })

  it('refuses unknown classes, keys, oversize words and out-of-range numbers', () => {
    const bad: unknown[] = [
      page({ pageClass: 'photo' as never }),
      { ...page(), extra: 1 },
      page({ refused: 'jpx-huge' as never }),
      page({ nativeWords: [{ t: '', x0: 0, y0: 0, x1: 1, y1: 1 }] }),
      page({
        nativeWords: [{ t: 'x'.repeat(TRIAGE_WORD_LIMITS.length + 1), x0: 0, y0: 0, x1: 1, y1: 1 }]
      }),
      page({ nativeWords: [{ t: 'ok', x0: Number.NaN, y0: 0, x1: 1, y1: 1 }] }),
      page({ renderDpi: 0 }),
      page({ bitsPerPixel: 0 }),
      page({ failure: 'oops' as never })
    ]
    for (const p of bad) expect(() => parseFromOcr(triaged([p])), JSON.stringify(p)).toThrow()
    expect(() => parseFromOcr({ triaged: { src: 's1', pages: [] } })).toThrow(/done/)
  })
})
