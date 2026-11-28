// The strict hOCR parser (DESIGN.md §3.4.6) on REAL Tesseract output recorded into the replay
// cache (all four line classes, ocrx_cinfo char boxes, carea/par lang, baseline and x-metrics,
// separators and photos), plus hand-made edge cases and every refusal.

import { describe, expect, it } from 'vitest'

import { decodeEntry, readEntryById } from './test-utils/ocr-replay'
import { HocrError, hocrToRaw, lineXHeight, parseHocr, type HocrLine } from './hocr'

const recorded = (id: string): string => decodeEntry(readEntryById(id))
const allLines = (src: string): HocrLine[] =>
  parseHocr(src).areas.flatMap((a) => a.pars.flatMap((p) => p.lines))

const mini = (
  body: string,
  line = "title='bbox 10 10 90 30; baseline 0.01 -4; x_size 20; x_descenders 4; x_ascenders 5'"
) =>
  `<div class='ocr_page' id='page_1' title='image "unknown"; bbox 0 0 100 100; ppageno 0'>
   <div class='ocr_carea' id='block_1_1' title="bbox 10 10 90 30">
    <p class='ocr_par' id='par_1_1' lang='eng' title="bbox 10 10 90 30">
     <span class='ocr_line' id='line_1_1' ${line}>${body}</span>
    </p>
   </div>
  </div>`

describe('parseHocr on recorded engine output', () => {
  it('clean300: every line, word and char box, in reading order', () => {
    const page = parseHocr(recorded('clean300'))
    expect(page.bbox).toEqual({ x0: 0, y0: 0, x1: 1800, y1: 750 })
    expect(page.areas).toHaveLength(1)
    const lines = allLines(recorded('clean300'))
    expect(lines).toHaveLength(9)
    const first = lines[0]
    expect(first.kind).toBe('ocr_line')
    expect(first.bbox).toEqual({ x0: 101, y0: 100, x1: 1654, y1: 134 })
    expect(first.baseline).toEqual({ slope: -0.001, intercept: 0 })
    expect(first.xSize).toBeCloseTo(42.442314)
    expect(first.xDescenders).toBeCloseTo(9.4423141)
    expect(first.xAscenders).toBe(8)
    expect(lineXHeight(first)).toBeCloseTo(25, 5)
    expect(first.words[0]).toMatchObject({
      text: 'The',
      bbox: { x0: 101, y0: 100, x1: 177, y1: 134 },
      conf: 96
    })
    expect(first.words[0].chars.map((c) => c.text)).toEqual(['T', 'h', 'e'])
    expect(first.words[0].chars[0].bbox).toEqual({ x0: 101, y0: 100, x1: 127, y1: 133 })
    expect(first.words[0].chars[0].conf).toBeCloseTo(99.496841)
    const words = lines.flatMap((l) => l.words)
    expect(words).toHaveLength(116)
    for (const w of words) expect(w.chars.map((c) => c.text).join('')).toBe(w.text)
    expect(parseHocr(recorded('clean300')).areas[0].pars[0].lang).toBe('eng')
  })

  it('all four line classes are lines (Tesseract 5)', () => {
    const kinds = (id: string): string[] => [...new Set(allLines(recorded(id)).map((l) => l.kind))]
    expect(kinds('hocr-header')).toEqual(expect.arrayContaining(['ocr_line', 'ocr_header']))
    expect(kinds('hocr-caption')).toEqual(expect.arrayContaining(['ocr_line', 'ocr_caption']))
    expect(kinds('hocr-textfloat')).toEqual(expect.arrayContaining(['ocr_line', 'ocr_textfloat']))
    for (const id of ['hocr-header', 'hocr-caption', 'hocr-textfloat'])
      for (const l of allLines(recorded(id))) {
        expect(l.words.length, id).toBeGreaterThan(0)
        expect(l.xSize, id).not.toBeNull()
      }
    // The recorded header is a real line of text with words and char boxes.
    const header = allLines(recorded('hocr-header')).find((l) => l.kind === 'ocr_header')!
    expect(header.words.map((w) => w.text).join(' ')).toMatch(/printer/)
    const caption = allLines(recorded('hocr-caption')).find((l) => l.kind === 'ocr_caption')!
    expect(caption.words.map((w) => w.text).join(' ')).toMatch(/Figure/)
  })

  it('skips separators and photos (no text), keeps every carea', () => {
    const table = parseHocr(recorded('numbers-table'))
    expect(table.skippedBlocks).toBe(13)
    expect(parseHocr(recorded('hocr-caption')).skippedBlocks).toBe(1)
    expect(parseHocr(recorded('hocr-textfloat')).areas).toHaveLength(24)
  })

  it('reads a page whose lines have no baseline (vertical text on rot90page)', () => {
    const lines = allLines(recorded('rot90page'))
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((l) => l.baseline === null)).toBe(true)
  })

  it('every recorded entry parses and flattens', () => {
    for (const id of ['clean300', 'skew2', 'twocol', 'smallprint6pt', 'latin-diacritics']) {
      const raw = hocrToRaw(parseHocr(recorded(id)))
      expect(raw.confSource).toBe('word')
      expect(raw.meanConf).toBeGreaterThan(50)
      for (const l of raw.lines)
        for (const w of l.words) if (w.chars) expect(w.chars).toHaveLength([...w.text].length)
    }
  })
})

describe('hocrToRaw', () => {
  it('carries lang, x-height, size, angle, kind and char boxes', () => {
    const raw = hocrToRaw(
      parseHocr(
        mini(
          `<span class='ocrx_word' id='w' title='bbox 10 10 40 30; x_wconf 91'><span class='ocrx_cinfo' title='x_bboxes 10 10 20 30; x_conf 99'>a</span><span class='ocrx_cinfo' title='x_bboxes 21 10 40 30; x_conf 98'>b</span></span>`,
          "title='bbox 10 10 90 30; baseline 0.01 -4; x_size 20; x_descenders 4; x_ascenders 5; textangle 90'"
        )
      )
    )
    expect(raw.lines).toEqual([
      {
        kind: 'ocr_line',
        bbox: { x0: 10, y0: 10, x1: 90, y1: 30 },
        baseline: { slope: 0.01, intercept: -4 },
        xHeight: 11,
        size: 20,
        angle: 90,
        descenders: 4,
        lang: 'eng',
        words: [
          {
            text: 'ab',
            bbox: { x0: 10, y0: 10, x1: 40, y1: 30 },
            conf: 91,
            chars: [
              { x0: 10, y0: 10, x1: 20, y1: 30 },
              { x0: 21, y0: 10, x1: 40, y1: 30 }
            ]
          }
        ]
      }
    ])
    expect(raw.meanConf).toBe(91)
  })

  it('decodes entities; drops char boxes when a symbol is several code points', () => {
    const raw = hocrToRaw(
      parseHocr(
        mini(
          `<span class='ocrx_word' id='w' title='bbox 10 10 40 30; x_wconf 50'><span class='ocrx_cinfo' title='x_bboxes 10 10 20 30'>&amp;</span><span class='ocrx_cinfo' title='x_bboxes 21 10 40 30'>e&#769;</span></span>`
        )
      )
    )
    const w = raw.lines[0].words[0]
    expect(w.text).toBe('&é')
    expect(w.chars).toBeUndefined()
  })

  it('reads words without char boxes (hocr_char_boxes 0) and with <strong>/<em>', () => {
    const raw = hocrToRaw(
      parseHocr(
        mini(
          `<span class='ocrx_word' id='a' title='bbox 10 10 40 30; x_wconf 80'>caf&#233;</span> <span class='ocrx_word' id='b' title='bbox 50 10 80 30; x_wconf 70'><strong>x&lt;y</strong></span>`
        )
      )
    )
    expect(raw.lines[0].words.map((w) => w.text)).toEqual(['café', 'x<y'])
    expect(raw.meanConf).toBe(75)
  })

  it('a page with no words has no confidence', () => {
    const raw = hocrToRaw(parseHocr(mini('')))
    expect(raw).toEqual({
      lines: [expect.objectContaining({ words: [] })],
      meanConf: null,
      confSource: 'none'
    })
  })
})

describe('parseHocr refuses anything else', () => {
  const word = `<span class='ocrx_word' id='w' title='bbox 10 10 40 30; x_wconf 91'>a</span>`
  const bad: Array<[string, string]> = [
    ['empty', ''],
    ['no page', `<div class='ocr_carea' title='bbox 0 0 1 1'></div>`],
    ['unbalanced', mini(word).replace('</p>', '')],
    ['mismatched close', mini(word).replace('</p>', '</span>')],
    ['word without bbox', mini(`<span class='ocrx_word' id='w' title='x_wconf 9'>a</span>`)],
    ['bad number', mini(`<span class='ocrx_word' id='w' title='bbox 1 2 x 4'>a</span>`)],
    ['inverted box', mini(`<span class='ocrx_word' id='w' title='bbox 40 10 10 30'>a</span>`)],
    ['word outside a line', `<div class='ocr_page' title='bbox 0 0 9 9'>${word}</div>`],
    ['unknown class', mini(`<span class='ocrx_bogus'>a</span>`)],
    [
      'unknown entity',
      mini(`<span class='ocrx_word' id='w' title='bbox 10 10 40 30'>&nbsp;</span>`)
    ],
    [
      'surrogate reference',
      mini(`<span class='ocrx_word' id='w' title='bbox 10 10 40 30'>&#xD800;</span>`)
    ],
    [
      'script attribute',
      mini(`<span class='ocrx_word' onclick='x' title='bbox 10 10 40 30'>a</span>`)
    ],
    ['text outside a word', mini('loose text')],
    ['two pages', mini(word) + mini(word)],
    ['bad lang', mini(word).replace("lang='eng'", "lang='../x'")],
    ['unterminated tag', mini(word).slice(0, -3)]
  ]
  for (const [what, src] of bad)
    it(what, () => {
      expect(() => parseHocr(src)).toThrow(HocrError)
    })

  // Each refused for its own reason (the message pins which check fired).
  const cinfo = (x0: number, x1: number, t: string): string =>
    `<span class='ocrx_cinfo' title='x_bboxes ${x0} 10 ${x1} 30; x_conf 99'>${t}</span>`
  const exact: Array<[string, string, RegExp]> = [
    [
      'text between char boxes',
      mini(
        `<span class='ocrx_word' id='w' title='bbox 10 10 40 30'>${cinfo(10, 20, 'a')}X${cinfo(21, 40, 'b')}</span>`
      ),
      /text between char boxes/
    ],
    [
      'attributes on a closing tag',
      mini(`<span class='ocrx_word' id='w' title='bbox 10 10 40 30'>a</span class='x'>`),
      /attributes on a closing tag/
    ],
    [
      'an inline tag between lines',
      mini(word).replace("<span class='ocr_line'", "<b></b><span class='ocr_line'"),
      /unexpected <b>/
    ],
    [
      'a number that overflows to Infinity',
      mini(`<span class='ocrx_word' id='w' title='bbox 10 10 1e999 30'>a</span>`),
      /bad number/
    ],
    ['a bad dir', mini(word).replace("lang='eng'", "lang='eng' dir='up'"), /bad dir/],
    [
      'a word nested in a word',
      mini(
        `<span class='ocrx_word' id='a' title='bbox 10 10 40 30'><span class='ocrx_word' id='b' title='bbox 10 10 40 30'>a</span></span>`
      ),
      /misplaced ocrx_word/
    ]
  ]
  for (const [what, src, why] of exact)
    it(what, () => {
      expect(() => parseHocr(src)).toThrow(HocrError)
      expect(() => parseHocr(src)).toThrow(why)
    })

  it('refuses inputs over the size cap and deep nesting', () => {
    expect(() => parseHocr('x'.repeat(64 * 2 ** 20 + 1))).toThrow(/too large/)
    expect(() => parseHocr(mini('<em>'.repeat(20) + 'a' + '</em>'.repeat(20)))).toThrow(HocrError)
  })
})
