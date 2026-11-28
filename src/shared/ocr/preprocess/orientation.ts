// Page orientation (DESIGN.md §3.4.5): two independent signals must agree before a page is turned.
//
// 1. The 90° test needs no engine: on the 1/4-scale binary copy, the sharpness of the row profile
//    (Σ squared differences of adjacent row sums) against that of the column profile. Lines of
//    text make the profile across them crisp; a ratio > 1.5 means the lines run vertically. Each
//    side is taken at its best shear within the deskew sweep (skew.ts), not unsheared: a page
//    skewed by 2° smears its row profile enough that the plain columns look sharper [measured:
//    skew2, skew5 and photoLike all read as vertical with unsheared profiles].
// 2. 0° vs 180° (and so 90° vs 270°): the engine reads a central band (~25% of the height) both
//    ways with PSM 6; the band is flipped only when BOTH the mean confidence rises by ≥ 15 (with
//    ≥ 10 words) AND the plausibility score below rises by ≥ 0.25.
//
// The rotation Δ the UI offers ("Page 9 looks sideways — Rotate?") is the detected clockwise
// rotation that makes the intrinsic render upright, less the edit rotation the page already shows.

import type { RawOcr } from '../engine/types'
import { rotateQuarterCW } from './geometry'
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

export interface ProfileTest {
  /** The row profile's best sharpness, and the skew it was found at. */
  rows: SkewResult
  /** The same for the column profile (the mask turned a quarter). */
  cols: SkewResult
  /** cols > 1.5 × rows: the text lines run vertically (turn the page a quarter). */
  vertical: boolean
}

/** The 90° test on a 1/4-scale binary mask (1 = ink). */
export function profileTest(mask: Uint8Array, w: number, h: number): ProfileTest {
  const rows = findSkew(mask, w, h)
  const t = rotateQuarterCW({ width: w, height: h, data: mask }, 1).image
  const cols = findSkew(t.data, t.width, t.height)
  return {
    rows,
    cols,
    vertical: VERTICAL_RATIO_DEN * cols.score > VERTICAL_RATIO_NUM * rows.score
  }
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
