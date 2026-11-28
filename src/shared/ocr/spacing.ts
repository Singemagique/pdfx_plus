// Whether two adjacent OCR words are separated by a space (DESIGN.md §3.6.1, §3.7.5). One function
// decides it for both consumers, so Find before export (`to-page-text.ts`, which emits a ' ' item)
// and the exported text layer (`ocr-layer.ts`, which writes a U+0020) can never disagree: a
// multi-character CJK word that the engine split in two is found by the same query either way.
//
// The rule: no space when BOTH sides are "no-space" CJK — Han, kana, CJK symbols and punctuation,
// fullwidth and halfwidth forms — or when a Hangul syllable meets one of those (Korean mixed with
// Hanja). Korean words are space-separated, so Hangul next to Hangul keeps its space, and so does
// every other pair (Latin, digits, Cyrillic, … and any CJK–non-CJK boundary).

/** How a code point takes part in the spacing rule. */
export type SpaceClass = 'cjk' | 'hangul' | 'other'

const HANGUL = /\p{Script=Hangul}/u
const CJK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}]/u

/** Blocks of script-Common characters that CJK text uses as part of its own run. */
const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x2e80, 0x2fdf], // CJK Radicals Supplement, Kangxi Radicals
  [0x2ff0, 0x2fff], // Ideographic Description Characters
  [0x3000, 0x303f], // CJK Symbols and Punctuation (、。「」〇 …)
  [0x3040, 0x30ff], // Hiragana, Katakana (incl. ー and ・, which are script Common)
  [0x3190, 0x31ff], // Kanbun, Bopomofo Extended, CJK Strokes, Katakana Phonetic Extensions
  [0x3200, 0x33ff], // Enclosed CJK Letters and Months, CJK Compatibility
  [0xfe10, 0xfe1f], // Vertical Forms
  [0xfe30, 0xfe4f], // CJK Compatibility Forms
  [0xff00, 0xff9f], // Fullwidth ASCII variants, halfwidth CJK punctuation and katakana
  [0xffe0, 0xffef] // Fullwidth signs, halfwidth forms
]

/** The spacing class of one code point. */
export function spaceClass(cp: number): SpaceClass {
  const ch = String.fromCodePoint(cp)
  // Halfwidth Hangul (U+FFA0..FFDC) is script Hangul; test it before the fullwidth block.
  if (HANGUL.test(ch)) return 'hangul'
  if (CJK_SCRIPT.test(ch)) return 'cjk'
  for (const [lo, hi] of CJK_RANGES) if (cp >= lo && cp <= hi) return 'cjk'
  return 'other'
}

function lastCodePoint(s: string): number | undefined {
  if (s.length === 0) return undefined
  const lo = s.charCodeAt(s.length - 1)
  if (lo >= 0xdc00 && lo <= 0xdfff && s.length > 1) {
    const hi = s.charCodeAt(s.length - 2)
    if (hi >= 0xd800 && hi <= 0xdbff) return s.codePointAt(s.length - 2)
  }
  return lo
}

type WordLike = string | { t: string }
const textOf = (w: WordLike): string => (typeof w === 'string' ? w : w.t)

/**
 * True when a space separates `prev` and `next` (whole words, in reading order). Looks only at the
 * last code point of `prev` and the first of `next`. An empty side always gets its space: it can
 * only come from a caller bug, and a spurious space is the harmless failure.
 */
export function needsSpaceBetween(prev: WordLike, next: WordLike): boolean {
  const a = lastCodePoint(textOf(prev))
  const b = textOf(next).codePointAt(0)
  if (a === undefined || b === undefined) return true
  const ca = spaceClass(a)
  const cb = spaceClass(b)
  if (ca === 'other' || cb === 'other') return true
  return ca === 'hangul' && cb === 'hangul'
}
