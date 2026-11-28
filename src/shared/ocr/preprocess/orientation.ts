// Page orientation (DESIGN.md §3.4.5): two independent signals must agree before a page is turned.
//
// 1. The 90° test needs no engine: on the 1/4-scale binary copy, the sharpness of the row profile
//    (Σ squared differences of adjacent row sums) against that of the column profile. Lines of
//    text make the profile across them crisp; a ratio > 1.5 means the lines run vertically. Each
//    side is taken at its best shear within the deskew sweep (skew.ts), not unsheared: a page
//    skewed by 2° smears its row profile enough that the plain columns look sharper [measured:
//    skew2, skew5 and photoLike all read as vertical with unsheared profiles].
// 2. 0° vs 180° (and so 90° vs 270°): the engine reads a band (~25% of the height, placed on the
//    text: `textBand`) both ways with PSM 6; the band is flipped only when BOTH the mean
//    confidence rises by ≥ 15 (with ≥ 10 words) AND the plausibility score below rises by ≥ 0.25.
//    When neither way reads well, a band of the copy turned a quarter is read both ways too (the
//    90° test misses narrow pages of short lines: receipts, labels; recognize-core.ts
//    `quarterWins`). Recognize-core keeps any turn only if pass 1 on the turned copy then scores
//    higher than pass 1 did.
//
// The rotation Δ the UI offers ("Page 9 looks sideways — Rotate?") is the detected clockwise
// rotation that makes the intrinsic render upright, less the edit rotation the page already shows.

import type { RawOcr } from '../engine/types'
import { rotateQuarterCW } from './geometry'
import { histogram, otsu, type Gray } from './image'
import { findSkew, type SkewResult } from './skew'

export type Orientation = 0 | 90 | 180 | 270

/** Row- vs column-profile sharpness ratio above which the text runs vertically. */
export const VERTICAL_RATIO_NUM = 3
export const VERTICAL_RATIO_DEN = 2
/** The 0/180 decision's two thresholds. */
export const FLIP_CONF_DELTA = 15
export const FLIP_MIN_WORDS = 10
export const FLIP_PLAUSIBILITY_DELTA = 0.25
/** The band read both ways: the middle quarter of the page's height. */
export const BAND_NUM = 1
export const BAND_DEN = 4
/** The band leaves the centre only for a window with more than 5/4 of the centre's ink edges. */
export const BAND_MOVE_NUM = 5
export const BAND_MOVE_DEN = 4

export interface ProfileTest {
  /** The row profile's best sharpness, and the skew it was found at. */
  rows: SkewResult
  /** The same for the column profile (the mask turned a quarter). */
  cols: SkewResult
  /** cols > 1.5 × rows: the text lines run vertically (turn the page a quarter). */
  vertical: boolean
}

/** The 90° test's comparison: the column profile is over 1.5× sharper than the row profile. */
export function isVertical(rowsScore: number, colsScore: number): boolean {
  return VERTICAL_RATIO_DEN * colsScore > VERTICAL_RATIO_NUM * rowsScore
}

/** The 90° test on a 1/4-scale binary mask (1 = ink). */
export function profileTest(mask: Uint8Array, w: number, h: number): ProfileTest {
  const rows = findSkew(mask, w, h)
  const t = rotateQuarterCW({ width: w, height: h, data: mask }, 1).image
  const cols = findSkew(t.data, t.width, t.height)
  return { rows, cols, vertical: isVertical(rows.score, cols.score) }
}

/**
 * Where the band test reads: the `bandH` rows of `img` with the most ink edges (white-to-ink
 * steps along each row, at the page's Otsu threshold), so the band lies on the text wherever it
 * is. The design says "a central band"; a fixed centre reads nothing on a short letter, a label
 * or a page whose middle is a logo, and then never flips [measured, PR6 review: rot180-short-letter
 * and rot180-logo kept orientation 0 with 0 words in both band reads]. A solid logo or a rule has
 * two edges per row, a line of text dozens. The centre is kept unless a window has over 5/4 of
 * its edges (ties go to the window nearest the centre), so a page with no ink or with text all the
 * way down still reads the design's central band. Returns the band's first row.
 */
export function textBand(img: Gray, bandH: number): number {
  const { width: w, height: h, data } = img
  const n = Math.min(h, Math.max(1, bandH))
  const t = otsu(histogram(img))
  const rows = new Float64Array(h)
  for (let y = 0; y < h; y++) {
    const o = y * w
    let k = 0
    for (let x = 1; x < w; x++) if (data[o + x] < t && data[o + x - 1] >= t) k++
    rows[y] = k
  }
  const centre = (h - n) >> 1
  let sum = 0
  for (let y = 0; y < n; y++) sum += rows[y]
  let best = 0
  let bestSum = sum
  let centreSum = centre === 0 ? sum : 0
  const off = (y: number): number => (y > centre ? y - centre : centre - y)
  for (let y0 = 1; y0 + n <= h; y0++) {
    sum += rows[y0 + n - 1] - rows[y0 - 1]
    if (y0 === centre) centreSum = sum
    if (sum > bestSum || (sum === bestSum && off(y0) < off(best))) {
      best = y0
      bestSum = sum
    }
  }
  // The design's central band stays unless the text is clearly elsewhere (25% more edges).
  return BAND_MOVE_DEN * bestSum > BAND_MOVE_NUM * centreSum ? best : centre
}

const TOKEN_RE = /^[\p{L}\p{N}][\p{L}\p{N}'’.,:/-]*$/u
const DIGIT_RE = /\p{N}/u
const UPPER_RE = /\p{Lu}/u
const LOWER_RE = /\p{Ll}/u
/** All-caps words longer than this are not counted as words (upside-down lowercase reads as caps). */
const MAX_CAPS_WORD = 4

/**
 * A token that reads like a word or a number: the design's pattern, and (an addition, measured
 * necessary) a regular letter case and no letters mixed with digits. Tesseract reads upside-down
 * Courier as tokens like `SIASTT`, `pajueyl`, `9SYJ`, `AJIoAS`: they pass the pattern and
 * have Latin vowel ratios, scoring 0.88 against 0.96 the right way up [measured, PR6 tier 1:
 * rot180page in Courier]; case and digit mixing tell them apart.
 */
export function wordLike(t: string): boolean {
  if (!TOKEN_RE.test(t)) return false
  const letters = [...t].filter((ch) => LETTER_RE.test(ch))
  if (letters.length === 0) return true
  if (DIGIT_RE.test(t)) return false
  const rest = letters.slice(1)
  if (!rest.some((ch) => UPPER_RE.test(ch))) return true // lower or Capitalised
  return !rest.some((ch) => LOWER_RE.test(ch)) && letters.length <= MAX_CAPS_WORD
}
const LETTER_RE = /\p{L}/u
const LATIN_RE = /[A-Za-z]/
const VOWEL_RE = /[aeiouyAEIOUY]/
/** The vowel share of Latin letters in running text of the bundled languages is ~0.35–0.45. */
const VOWEL_TARGET = 0.4

/**
 * How much a recognition reads like text, 0..1: the share of tokens that look like words or
 * numbers, averaged 2:1 with a vowel score when the letters are mostly Latin (upside-down Latin reads
 * as consonant clusters and punctuation). For other scripts only the token share counts.
 */
export function plausibility(raw: RawOcr): number {
  let tokens = 0
  let good = 0
  let letters = 0
  let latin = 0
  let vowels = 0
  for (const l of raw.lines)
    for (const w of l.words) {
      const t = w.text.normalize('NFC')
      if (t.length === 0) continue
      tokens++
      if (wordLike(t)) good++
      for (const ch of t) {
        if (!LETTER_RE.test(ch)) continue
        letters++
        if (LATIN_RE.test(ch)) {
          latin++
          if (VOWEL_RE.test(ch)) vowels++
        }
      }
    }
  if (tokens === 0) return 0
  const share = good / tokens
  if (letters === 0 || 2 * latin < letters) return share
  const ratio = vowels / latin
  const off = ratio > VOWEL_TARGET ? ratio - VOWEL_TARGET : VOWEL_TARGET - ratio
  const vowelScore = Math.max(0, 1 - off / VOWEL_TARGET)
  // The token share counts double: the vowel ratio of upside-down Latin is often close to normal
  // (0.85–0.95 on the monospace rot180page seeds [measured]); its tokens are not.
  return (2 * share + vowelScore) / 3
}

export interface BandReading {
  words: number
  /** Mean raw word confidence (0 when no word has one). */
  meanConf: number
  plausibility: number
}

export function bandReading(raw: RawOcr): BandReading {
  let words = 0
  let sum = 0
  let n = 0
  for (const l of raw.lines)
    for (const w of l.words) {
      if (w.text.trim().length === 0) continue
      words++
      if (w.conf !== null && w.conf >= 0) {
        sum += w.conf
        n++
      }
    }
  return { words, meanConf: n > 0 ? sum / n : 0, plausibility: plausibility(raw) }
}

/** Flip only if both signals agree that the turned band reads better (§3.4.5). */
export function shouldFlip(asIs: BandReading, flipped: BandReading): boolean {
  return (
    flipped.words >= FLIP_MIN_WORDS &&
    flipped.meanConf - asIs.meanConf >= FLIP_CONF_DELTA &&
    flipped.plausibility - asIs.plausibility >= FLIP_PLAUSIBILITY_DELTA
  )
}

/** `Δ = (θ_detected − r_edit) mod 360`: the extra clockwise turn the page needs on screen. */
export function rotationDelta(detected: Orientation, editRotation: Orientation): Orientation {
  return ((((detected - editRotation) % 360) + 360) % 360) as Orientation
}
