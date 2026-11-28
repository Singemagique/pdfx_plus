// Test-only: scripted engines for the recognize pipeline (recognize-core.ts), engine-free.
//
// - `hocr` / `words`: a minimal Tesseract-shaped hOCR for scripted answers.
// - `seeingEngine`: an engine that LOOKS at the pixels it is given, just enough to tell which way
//   up a line of `textLines` ink is, so the orientation logic (band placement, flips, quarter
//   turns, the edit-rotation prior) runs against real geometry instead of a call-index script.

import type { TessParams } from '../../../shared/ocr/engine/tess-core'
import type { GrayImage } from '../../../shared/ocr/engine/types'
import { rotateQuarterCW } from '../../../shared/ocr/preprocess/geometry'
import type { RecognizeEngine } from '../process/recognize-core'

export interface W {
  t: string
  conf: number
}

/** A minimal Tesseract-shaped hOCR: one line per entry, words 60 px wide, 30 px tall. */
export function hocr(lines: W[][], xh = 20): string {
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

export const words = (n: number, conf: number, t = 'harbour'): W[] =>
  Array.from({ length: n }, () => ({ t, conf }))

export const blankGray = (w: number, h: number): GrayImage => ({
  width: w,
  height: h,
  data: new Uint8Array(w * h).fill(255)
})

/**
 * Lines of text-like ink: 12 px tall letters 6 px wide (2 px apart, 5 per word, 10 px between
 * words), each word's first letter an ascender rising 8 px above the line. `ys` are the lines'
 * top-of-x-height rows; the lines run from `x0` to `x1`.
 */
export function textLines(img: GrayImage, ys: number[], x0 = 40, x1 = img.width - 40): void {
  for (const y of ys)
    for (let x = x0; x + 40 <= x1; x += 50)
      for (let k = 0; k < 5; k++) {
        const top = k === 0 ? y - 8 : y
        for (let r = top; r < y + 12; r++)
          img.data.fill(0, r * img.width + x + k * 8, r * img.width + x + k * 8 + 6)
      }
}

/** `img` turned clockwise by `turns` quarter turns. */
export const turned = (img: GrayImage, turns: 1 | 2 | 3): GrayImage =>
  rotateQuarterCW({ width: img.width, height: img.height, data: img.data }, turns).image

export type Way = 'upright' | 'flipped' | 'unreadable'

/**
 * Each run of inked rows is a line: 16–26 rows tall with its ascenders on top = upright, below =
 * upside down; any other run of 4+ rows (a logo, a line the band cut, sideways letters) is
 * unreadable.
 */
export function readWays(img: GrayImage): Way[] {
  const rows = new Array<number>(img.height).fill(0)
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) if (img.data[y * img.width + x] < 128) rows[y]++
  const out: Way[] = []
  for (let y = 0; y < img.height; ) {
    if (rows[y] === 0) {
      y++
      continue
    }
    let e = y
    while (e < img.height && rows[e] > 0) e++
    const len = e - y
    if (len >= 16 && len <= 26) {
      const top = rows.slice(y, y + 5).reduce((a, b) => a + b, 0)
      const bottom = rows.slice(e - 5, e).reduce((a, b) => a + b, 0)
      out.push(top < bottom ? 'upright' : 'flipped')
    } else if (len >= 4) out.push('unreadable')
    y = e
  }
  return out
}

/**
 * hOCR for what `readWays` sees: 8 good words (conf 96) per upright line, 8 garbage tokens
 * (conf 30) per upside-down one, 6 (conf 20) per unreadable run.
 */
export function seeingEngine(): { engine: RecognizeEngine; calls: TessParams[] } {
  const calls: TessParams[] = []
  return {
    calls,
    engine: {
      recognize: (img, params) => {
        calls.push(params)
        const lines = readWays(img).map((w) =>
          w === 'upright'
            ? words(8, 96)
            : w === 'flipped'
              ? words(8, 30, "'p3]")
              : words(6, 20, 'ʎ}s|')
        )
        return { hocr: hocr(lines) }
      }
    }
  }
}
