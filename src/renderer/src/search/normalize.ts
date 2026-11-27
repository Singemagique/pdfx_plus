// Search normalization with an offset map back to the raw text.
//
// Both the page text and the query go through normalizeSegments, so the two sides follow exactly
// the same rules: case folding, compatibility forms (NFKC: ligatures, full-width forms), diacritics
// stripped (NFD, non-spacing marks removed), soft hyphens and other format characters dropped,
// whitespace collapsed, and words split across a line end (by a hyphen or a soft hyphen) joined
// back together. Every normalized UTF-16 unit remembers the raw [start, end) range it came from, so
// a match in the normalized string can be drawn over the glyphs it came from.

/** One run of raw text: a pdf.js text item (or the query, as a single segment). */
export interface Segment {
  str: string
  /** The run is followed by a line break. */
  hasEOL: boolean
  /** A line break precedes this run (a baseline jump pdf.js did not flag with hasEOL). */
  breakBefore?: boolean
}

export interface NormalizedText {
  /** The searchable text. */
  text: string
  /** Per unit of `text`: the GLOBAL raw offset it starts at (raw = every segment's str
   *  concatenated), or -1 for a synthetic space standing in for a line break. */
  srcStart: Int32Array
  /** Per unit of `text`: the raw offset it ends at (exclusive), -1 for synthetic units. */
  srcEnd: Int32Array
  /** The raw offset each segment's str starts at. */
  itemStarts: Int32Array
}

const MARK = /\p{M}/u
const NON_SPACING = /\p{Mn}/gu
const FORMAT = /\p{Cf}/u
const SPACE = /\s/u
const WORD = /[\p{L}\p{N}]/u
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const SOFT_HYPHEN = '­'

/** Combining marks all sit at U+0300 or above, so plain Latin text never reaches the regex. */
const isMark = (cp: number): boolean => cp >= 0x300 && MARK.test(String.fromCodePoint(cp))

/**
 * Where the cluster starting at `i` in `str` ends: one code point plus any combining marks after
 * it. This is the unit normalizeSegments maps, so a normalized unit's raw end can be recomputed
 * from its start (PageText keeps only the starts).
 */
export function clusterEnd(str: string, i: number): number {
  const first = str.codePointAt(i)
  if (first === undefined) return i
  let j = i + (first > 0xffff ? 2 : 1)
  while (j < str.length) {
    const cp = str.codePointAt(j)!
    if (!isMark(cp)) break
    j += cp > 0xffff ? 2 : 1
  }
  return j
}

/**
 * Normalize one grapheme-ish cluster (a base code point plus its combining marks). Working per
 * cluster keeps the offset map exact, and keeps the result independent of the neighbouring text.
 * The trailing NFC only recomposes what NFD split apart without a mark to strip (Hangul syllables),
 * so the normalized text stays compact.
 */
function normalizeCluster(cluster: string): string {
  if (cluster.length === 1 && cluster.charCodeAt(0) < 0x80) return cluster.toLowerCase()
  return cluster
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(NON_SPACING, '')
    .normalize('NFC')
}

/** Normalize text runs into a searchable string plus its map back to raw offsets. */
export function normalizeSegments(segments: readonly Segment[]): NormalizedText {
  // Output code points (so a popped hyphen and the "char before last" are cheap to reach) and the
  // per-UTF-16-unit source maps.
  const out: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  const itemStarts = new Int32Array(segments.length)

  let pendingSpace = false
  let spaceStart = -1
  let spaceEnd = -1
  let pendingBreak = false
  let softHyphen = false

  const emit = (ch: string, s: number, e: number): void => {
    out.push(ch)
    for (let u = 0; u < ch.length; u++) {
      starts.push(s)
      ends.push(e)
    }
  }

  const emitReal = (ch: string, s: number, e: number): void => {
    if (pendingBreak) {
      const last = out[out.length - 1]
      if (softHyphen) {
        // "exam­⏎ple": the soft hyphen marked a word split at the line end.
      } else if (
        last === '-' &&
        out.length >= 2 &&
        WORD.test(out[out.length - 2]) &&
        WORD.test(ch)
      ) {
        // "exam-⏎ple" → "example". The query side makes interior hyphens optional, so
        // "well-known" still finds a line-broken "well-⏎known".
        out.pop()
        starts.pop()
        ends.pop()
      } else if (last !== undefined && CJK.test(last) && CJK.test(ch)) {
        // CJK lines wrap without a space between them.
      } else {
        emit(' ', -1, -1)
      }
    } else if (pendingSpace) {
      emit(' ', spaceStart, spaceEnd)
    }
    emit(ch, s, e)
    pendingSpace = false
    pendingBreak = false
    softHyphen = false
  }

  let g = 0
  segments.forEach((seg, k) => {
    if (seg.breakBefore && out.length > 0) {
      pendingBreak = true
      pendingSpace = false
    }
    itemStarts[k] = g
    const str = seg.str
    let i = 0
    while (i < str.length) {
      // One cluster: a base code point plus any following marks (a leading run of marks with no
      // base forms a cluster of its own).
      const cs = i
      i = clusterEnd(str, i)
      const s = g + cs
      const e = g + i
      const norm = normalizeCluster(str.slice(cs, i))
      for (const raw of norm) {
        let ch = raw
        if (FORMAT.test(ch)) {
          if (ch === SOFT_HYPHEN) softHyphen = true
          continue
        }
        if (ch === '‐' || ch === '‑') ch = '-'
        if (SPACE.test(ch)) {
          if (out.length > 0 && !pendingBreak && !pendingSpace) {
            pendingSpace = true
            spaceStart = s
            spaceEnd = e
          }
          continue
        }
        emitReal(ch, s, e)
      }
    }
    g += str.length
    if (seg.hasEOL && out.length > 0) {
      pendingBreak = true
      pendingSpace = false
    }
  })

  return {
    text: out.join(''),
    srcStart: Int32Array.from(starts),
    srcEnd: Int32Array.from(ends),
    itemStarts
  }
}

/** The normalized form of a typed query ('' when it has nothing searchable). */
export function normalizeQuery(raw: string): string {
  return normalizeSegments([{ str: raw, hasEOL: false }]).text
}

const META = /[.*+?^${}()|[\]\\/]/

/**
 * A global regex for a normalized query, or null when it is empty. Interior hyphens (a non-space,
 * non-hyphen character on both sides) become optional, matching a hyphenated word that was split
 * at a line end and joined back without its hyphen.
 */
export function compileQuery(norm: string): RegExp | null {
  if (!norm) return null
  const chars = Array.from(norm)
  let pattern = ''
  chars.forEach((ch, i) => {
    if (ch === '-') {
      const before = chars[i - 1]
      const after = chars[i + 1]
      const solid = (c: string | undefined): boolean => c !== undefined && c !== ' ' && c !== '-'
      pattern += solid(before) && solid(after) ? '-?' : '-'
      return
    }
    pattern += META.test(ch) ? `\\${ch}` : ch
  })
  return new RegExp(pattern, 'gu')
}

/** Every match of `re` in `text`, as [start, end) pairs, at most `limit` of them. */
export function findAll(text: string, re: RegExp, limit: number): Int32Array {
  const out: number[] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while (out.length / 2 < limit && (m = re.exec(text)) !== null) {
    const end = m.index + m[0].length
    if (end === m.index) {
      re.lastIndex = m.index + 1
      continue
    }
    out.push(m.index, end)
  }
  re.lastIndex = 0
  return Int32Array.from(out)
}
