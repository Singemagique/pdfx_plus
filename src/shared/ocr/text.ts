// Character-level rules shared by the OCR post-processing and the text layer (DESIGN.md §3.4.6,
// §3.7.4): which code points may reach a ToUnicode CMap, and which advance 1000 instead of 500.

const LIGATURES = /[ﬀ-ﬆ]/g
const WHITESPACE = /\s+/gu
// Default-ignorables (ZWSP, ZWJ, soft hyphen, variation selectors, U+FEFF, …), C0/C1 controls
// (U+0000 included) and the noncharacters (U+FFFE, U+FFFF, U+FDD0..FDEF, U+xFFFE/xFFFF).
const DROPPED = /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Noncharacter_Code_Point}]/gu

/** Drop unpaired UTF-16 surrogates (a lone half cannot be written to a ToUnicode CMap). */
function dropLoneSurrogates(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        out += s[i] + s[i + 1]
        i++
      }
      continue
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue
    out += s[i]
  }
  return out
}

/**
 * A word's text as the layer and Find may carry it: NFC; the Latin ligatures U+FB00..FB06 expanded
 * ("ﬁ" → "fi", so Find and every extractor see plain letters); default-ignorables, controls,
 * noncharacters and lone surrogates dropped; whitespace runs collapsed to one space and trimmed.
 * Every remaining code point is > 0 and none is U+FEFF or U+FFFE (§3.7.4, veraPDF 6.2.11.7.2).
 */
export function cleanOcrText(t: string): string {
  return (
    dropLoneSurrogates(t)
      .replace(LIGATURES, (l) => l.normalize('NFKC'))
      .normalize('NFC')
      // U+FEFF is both \s and default-ignorable: drop it before whitespace becomes a space.
      .replace(/﻿/g, '')
      .replace(WHITESPACE, ' ')
      .replace(DROPPED, '')
      .replace(/ {2,}/g, ' ')
      .trim()
  )
}

/**
 * Code points whose UAX #11 East Asian Width is Wide or Fullwidth, as ranges. A compact table of
 * the W/F blocks, not the full property: it covers the ideographs, kana, Hangul, CJK punctuation,
 * fullwidth forms and the wide emoji blocks. Anything it misses gets the narrow 500 advance, which
 * only makes a stretched word's `Tz` larger.
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e], // CJK radicals … CJK Symbols and Punctuation (not U+303F, which is narrow)
  [0x3041, 0x33ff], // kana, Bopomofo, Hangul Compatibility Jamo, Kanbun, enclosed, compatibility
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // Vertical Forms
  [0xfe30, 0xfe6f], // CJK Compatibility Forms, Small Form Variants
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18aff], // Tangut
  [0x1b000, 0x1b2ff], // Kana Supplement / Extended, Nushu
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f2ff], // Enclosed Ideographic Supplement
  [0x1f300, 0x1f64f], // pictographs, emoticons (W in Unicode 15; a few are N, harmless here)
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], // CJK Extensions B..F, Compatibility Supplement
  [0x30000, 0x3fffd] // CJK Extensions G, H
]

/** True when `cp` is East Asian Wide or Fullwidth (it then advances a full em, 1000 units). */
export function isWideCodePoint(cp: number): boolean {
  let lo = 0
  let hi = WIDE_RANGES.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [a, b] = WIDE_RANGES[mid]
    if (cp < a) hi = mid - 1
    else if (cp > b) lo = mid + 1
    else return true
  }
  return false
}
