// Recognised words → Find items (DESIGN.md §3.6.1): what search/engine.ts `setSupplement` takes,
// so OCR text is found before export exactly as pdf.js finds the exported layer after it.
//
// - One PageTextItem per word (`width` = its advance, so a whole-word hit is exact), `hasEOL` at
//   each line's end, and a ' ' item between two words ONLY where `needsSpaceBetween` says so: the
//   same function, on the same cleaned text, that decides whether ocr-layer.ts writes a U+0020.
//   Two CJK "words" the engine split apart are therefore one run here, as in the exported layer.
// - The same words as the layer: text through `cleanOcrText`, and a word that cleans to nothing,
//   has no advance or a non-finite position, or sits on a line with no size, is skipped.
// - Items live in the page's pdf.js USER space: overlay-frame points (types.ts: visual page,
//   bottom-left origin, y up) are mapped by inverse(vt) after flipping to the viewport's top-left
//   origin, so native and OCR items share the page's own `vt` and one buildPageText. On an
//   unrotated page t = [s·cos, s·sin, −s·sin, s·cos, x, y]; with an intrinsic /Rotate the two
//   direction vectors turn with the page.
// - Ascent 0.8, descent −0.2 (the layer's em box, OCR_ASCENT / OCR_DESCENT), and `charEdges` from
//   the word's char edges when they still match its text, for exact partial-word highlights.

import { needsSpaceBetween } from '../../../shared/ocr/spacing'
import { cleanOcrText } from '../../../shared/ocr/text'
import { OCR_ASCENT, OCR_DESCENT, ocrLines, type PackedOcrPage } from '../../../shared/ocr/types'
import type { Matrix, PageTextItem } from '../search/extract'

/** The inverse of an affine [a b c d e f] (PDF `cm` order). */
export function invertMatrix(m: readonly number[]): Matrix {
  const [a, b, c, d, e, f] = m
  const det = a * d - b * c
  if (!det || !Number.isFinite(det)) throw new Error('to-page-text: singular viewport transform')
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]
}

/**
 * The page's overlay frame → its pdf.js user space: flip to the viewport's top-left origin
 * (display y = pageHeight − y), then inverse(vt).
 */
export function overlayToUser(vt: readonly number[], pageHeight: number): Matrix {
  const [a, b, c, d, e, f] = invertMatrix(vt)
  // inv(vt) ∘ [1 0 0 −1 0 H]
  return [a, b, -c, -d, c * pageHeight + e, d * pageHeight + f]
}

interface Word {
  t: string
  x: number
  y: number
  w: number
  chars?: Float32Array
}

/** `chars` as charEdges when they fit the cleaned text (one edge per code point, plus one). */
function edgesFor(raw: string, clean: string, chars: Float32Array | undefined, w: number) {
  if (!chars || raw.normalize('NFC') !== clean) return undefined
  if (chars.length !== [...clean].length + 1) return undefined
  for (let i = 1; i < chars.length; i++) if (!(chars[i] >= chars[i - 1])) return undefined
  if (!(chars[chars.length - 1] > 0) || Math.abs(chars[chars.length - 1] - w) > 0.05 * w + 0.5)
    return undefined
  return Float32Array.from(chars)
}

/**
 * The Find items of one recognised page, for a page whose pdf.js viewport transform at scale 1 is
 * `vt` and whose visual height (PageEntry.height) is `pageHeight`.
 */
export function ocrPageTextItems(
  page: PackedOcrPage,
  vt: readonly number[],
  pageHeight: number
): PageTextItem[] {
  const m = overlayToUser(vt, pageHeight)
  const toUser = (x: number, y: number): [number, number] => [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5]
  ]
  const turn = (x: number, y: number): [number, number] => [
    m[0] * x + m[2] * y,
    m[1] * x + m[3] * y
  ]
  const out: PageTextItem[] = []
  for (const line of ocrLines(page)) {
    const s = line.size
    if (!(s > 0) || !Number.isFinite(line.angle)) continue
    const cos = Math.cos(line.angle)
    const sin = Math.sin(line.angle)
    const [ax, ay] = turn(s * cos, s * sin)
    const [ux, uy] = turn(-s * sin, s * cos)
    const words: Word[] = []
    for (const w of line.words) {
      const t = cleanOcrText(w.t)
      if (t && Number.isFinite(w.x) && Number.isFinite(w.y) && Number.isFinite(w.w) && w.w > 0)
        words.push({ t, x: w.x, y: w.y, w: w.w, chars: edgesFor(w.t, t, w.chars, w.w) })
    }
    const item = (str: string, x: number, y: number, width: number): PageTextItem => {
      const [e, f] = toUser(x, y)
      return {
        str,
        t: [ax, ay, ux, uy, e, f],
        width,
        height: s,
        ascent: OCR_ASCENT,
        descent: -OCR_DESCENT,
        vertical: false,
        rtl: false,
        hasEOL: false,
        ocr: true
      }
    }
    words.forEach((w, i) => {
      const it = item(w.t, w.x, w.y, w.w)
      if (w.chars) it.charEdges = w.chars
      out.push(it)
      const next = words[i + 1]
      if (!next) {
        it.hasEOL = true
        return
      }
      if (!needsSpaceBetween(w.t, next.t)) return
      // The space spans the gap along the baseline, from this word's end to the next one's start.
      const along = (next.x - w.x) * cos + (next.y - w.y) * sin
      out.push(item(' ', w.x + w.w * cos, w.y + w.w * sin, Math.max(0, along - w.w)))
    })
  }
  return out
}
