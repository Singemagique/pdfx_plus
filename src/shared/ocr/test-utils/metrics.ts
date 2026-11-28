// OCR evaluation metrics (DESIGN.md §3.9.2). Test-only, engine-free, DOM-free: pure functions over
// strings and boxes, so the tier-0 suite pins them with textbook cases and the tier-1/2 harnesses
// (later PRs) feed them engine output.
//
// Conventions, fixed once so every number means the same thing:
// - Text is compared after Unicode NFC. "Characters" are extended grapheme clusters from
//   `Intl.Segmenter('und', { granularity: 'grapheme' })` (OCR-D's definition), so "é" written as
//   e + U+0301, a ZWJ emoji family and a flag each count as one character.
// - Edit distance is unit-cost Levenshtein. Where several alignments share the minimal distance, the
//   one with the MOST matches is chosen (lexicographic tie-break), so S/D/I/C are well defined: for
//   gt "ab" vs hyp "ba" that is D=1, I=1, C=1 (not S=2, C=0).
// - Boxes are axis-aligned `{ x, y, w, h }` in one shared frame (the synth GT uses the PDF visual
//   frame: bottom-left origin, points, `y` = lower edge). IoU doesn't care which frame, only that
//   both sides use the same one.

/** Axis-aligned box. In the GT frame `(x, y)` is the lower-left corner. */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

// ---------------------------------------------------------------------------------------------
// Text normalisation and segmentation

const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' })

/** The extended grapheme clusters of `s` after NFC. */
export function graphemes(s: string): string[] {
  const out: string[] = []
  for (const { segment } of segmenter.segment(s.normalize('NFC'))) out.push(segment)
  return out
}

/** BOM (U+FEFF) and the bidi controls: LRM, RLM, ALM, LRE..RLO, LRI..PDI. */
const INVISIBLE_MARKS = /[﻿‎‏؜‪-‮⁦-⁩]/g

/**
 * The OCR-D-style text normalisation used by the "normalised" variants, applied in this order:
 * 1. Unicode NFC.
 * 2. Delete U+FEFF (BOM / ZWNBSP) and the bidi marks and controls U+200E, U+200F, U+061C,
 *    U+202A–U+202E and U+2066–U+2069.
 * 3. Replace every run of whitespace (JS `\s`: all Unicode White_Space plus U+FEFF, which is already
 *    gone) with one U+0020, then trim both ends.
 * Case, punctuation, quotes, dashes, ligature code points and diacritics are all KEPT: this is the
 * strict variant. A search-equivalent variant is the Find harness's job (it uses the app's own
 * `search/normalize.ts`).
 */
export function normalizeOcrD(s: string): string {
  return s.normalize('NFC').replace(INVISIBLE_MARKS, '').replace(/\s+/g, ' ').trim()
}

/** Leading or trailing Unicode punctuation (\p{P}) of a token. */
const EDGE_PUNCT = /^\p{P}+|\p{P}+$/gu

/**
 * Words for WER and bag-of-words: `normalizeOcrD`, split on spaces, strip leading and trailing
 * Unicode punctuation (\p{P}) from each token, drop tokens that become empty. Inner punctuation
 * stays ("don't", "2026-11-27", "3.50"). This approximates OCR-D's UAX #29-based word definition
 * with a rule that is easy to reproduce by hand.
 */
export function words(s: string): string[] {
  const n = normalizeOcrD(s)
  if (n === '') return []
  const out: string[] = []
  for (const tok of n.split(' ')) {
    const t = tok.replace(EDGE_PUNCT, '')
    if (t !== '') out.push(t)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Edit distance

/** Counts from an optimal alignment of `gt` against `hyp`. */
export interface EditStats {
  /** Substitutions, deletions (in gt, missing from hyp), insertions (extra in hyp), matches. */
  s: number
  d: number
  i: number
  c: number
  /** s + d + i. */
  distance: number
  nGt: number
  nHyp: number
  /** distance / nGt (OCR-D CER/WER; can exceed 1). nGt = 0: 0 if hyp is empty too, else Infinity. */
  rate: number
  /** distance / (s + d + i + c), bounded to [0, 1] (OCR-D's normalised rate). 0 when both empty. */
  rateNormalised: number
}

/**
 * Levenshtein alignment over two token sequences, minimising the distance and then maximising the
 * matches. O(n·m) time, O(m) memory.
 */
export function alignStats(gt: readonly string[], hyp: readonly string[]): EditStats {
  const n = gt.length
  const m = hyp.length
  // Per cell: cost and match count of the best alignment of gt[0..i) with hyp[0..j).
  let cost = new Int32Array(m + 1)
  let match = new Int32Array(m + 1)
  let nextCost = new Int32Array(m + 1)
  let nextMatch = new Int32Array(m + 1)
  for (let j = 0; j <= m; j++) cost[j] = j
  for (let i = 1; i <= n; i++) {
    nextCost[0] = i
    nextMatch[0] = 0
    const g = gt[i - 1]
    for (let j = 1; j <= m; j++) {
      const same = g === hyp[j - 1]
      // Diagonal (match or substitution).
      let bc = cost[j - 1] + (same ? 0 : 1)
      let bm = match[j - 1] + (same ? 1 : 0)
      // Deletion (gt[i-1] unmatched).
      const dc = cost[j] + 1
      const dm = match[j]
      if (dc < bc || (dc === bc && dm > bm)) {
        bc = dc
        bm = dm
      }
      // Insertion (hyp[j-1] unmatched).
      const ic = nextCost[j - 1] + 1
      const im = nextMatch[j - 1]
      if (ic < bc || (ic === bc && im > bm)) {
        bc = ic
        bm = im
      }
      nextCost[j] = bc
      nextMatch[j] = bm
    }
    ;[cost, nextCost] = [nextCost, cost]
    ;[match, nextMatch] = [nextMatch, match]
  }
  const distance = cost[m]
  const c = match[m]
  // n = S + D + C, m = S + I + C, distance = S + D + I.
  const s = n - c + (m - c) - distance
  const d = n - c - s
  const i = m - c - s
  return {
    s,
    d,
    i,
    c,
    distance,
    nGt: n,
    nHyp: m,
    rate: n === 0 ? (distance === 0 ? 0 : Infinity) : distance / n,
    rateNormalised: distance === 0 ? 0 : distance / (distance + c)
  }
}

/** Grapheme CER, naive: NFC only, nothing else touched (whitespace counts as characters). */
export function cer(gt: string, hyp: string): EditStats {
  return alignStats(graphemes(gt), graphemes(hyp))
}

/** Grapheme CER after `normalizeOcrD` on both sides (read `rateNormalised` for OCR-D's CER_n). */
export function cerNormalised(gt: string, hyp: string): EditStats {
  return alignStats(graphemes(normalizeOcrD(gt)), graphemes(normalizeOcrD(hyp)))
}

/** WER over `words()` tokens. `rate` = (S+D+I)/N_gt, `rateNormalised` = OCR-D's bounded form. */
export function wer(gt: string, hyp: string): EditStats {
  return alignStats(words(gt), words(hyp))
}

/**
 * Normalised edit distance: graphemes(NFC) edit distance / max(len_gt, len_hyp); 0 when both are
 * empty. Spaces COUNT. This is NOT PaddleOCR's `norm_edit_dis`, which (a) strips spaces before
 * comparing by default and (b) reports 1 − mean(NED) as a similarity; never compare the two numbers
 * directly.
 */
export function ned(gt: string, hyp: string): number {
  const st = cer(gt, hyp)
  const denom = Math.max(st.nGt, st.nHyp)
  return denom === 0 ? 0 : st.distance / denom
}

/**
 * Bag-of-words error (OCR-D): Σ_w |count_gt(w) − count_hyp(w)| / (n_gt + n_hyp) over `words()`
 * tokens; 0 when both are empty. Ignores order and line segmentation.
 */
export function bagOfWordsError(gt: string, hyp: string): number {
  const counts = new Map<string, number>()
  const g = words(gt)
  const h = words(hyp)
  for (const w of g) counts.set(w, (counts.get(w) ?? 0) + 1)
  for (const w of h) counts.set(w, (counts.get(w) ?? 0) - 1)
  let diff = 0
  for (const v of counts.values()) diff += Math.abs(v)
  const total = g.length + h.length
  return total === 0 ? 0 : diff / total
}

// ---------------------------------------------------------------------------------------------
// Boxes

/** Intersection over union of two axis-aligned boxes (0 if either has no area). */
export function iou(a: Box, b: Box): number {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  if (ix <= 0 || iy <= 0) return 0
  const inter = ix * iy
  const union = a.w * a.h + b.w * b.h - inter
  return union <= 0 ? 0 : inter / union
}

export interface BoxMatch {
  gt: number
  hyp: number
  iou: number
}

export interface MatchOptions {
  /** Strict lower bound: a pair matches only if IoU > threshold. Default 0.5. */
  threshold?: number
  /**
   * 'iou' (default): consider all pairs from the highest IoU down (ties: lower gt index, then lower
   * hyp index), taking a pair when neither side is matched yet. 'index': PaddleOCR's /ICDAR-2015's
   * order — gt in index order, each taking the first unmatched hyp in index order above threshold.
   */
  order?: 'iou' | 'index'
}

/** Greedy one-to-one matching of hyp boxes to gt boxes at IoU > threshold. */
export function matchBoxes(
  gt: readonly Box[],
  hyp: readonly Box[],
  opts: MatchOptions = {}
): BoxMatch[] {
  const threshold = opts.threshold ?? 0.5
  const out: BoxMatch[] = []
  const gtUsed = new Uint8Array(gt.length)
  const hypUsed = new Uint8Array(hyp.length)
  if ((opts.order ?? 'iou') === 'index') {
    for (let g = 0; g < gt.length; g++) {
      for (let h = 0; h < hyp.length; h++) {
        if (hypUsed[h]) continue
        const v = iou(gt[g], hyp[h])
        if (v > threshold) {
          hypUsed[h] = 1
          out.push({ gt: g, hyp: h, iou: v })
          break
        }
      }
    }
    return out
  }
  const pairs: BoxMatch[] = []
  for (let g = 0; g < gt.length; g++)
    for (let h = 0; h < hyp.length; h++) {
      const v = iou(gt[g], hyp[h])
      if (v > threshold) pairs.push({ gt: g, hyp: h, iou: v })
    }
  pairs.sort((a, b) => b.iou - a.iou || a.gt - b.gt || a.hyp - b.hyp)
  for (const p of pairs) {
    if (gtUsed[p.gt] || hypUsed[p.hyp]) continue
    gtUsed[p.gt] = 1
    hypUsed[p.hyp] = 1
    out.push(p)
  }
  return out.sort((a, b) => a.gt - b.gt)
}

/**
 * Linear-interpolated percentile (the "type 7" / numpy default): sorted v, position p·(n−1).
 * null for an empty list.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const pos = p * (s.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.min(lo + 1, s.length - 1)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

export interface BoxScores {
  matched: number
  nGt: number
  nHyp: number
  /** matched / nHyp; 1 when nHyp = 0 (vacuous). */
  precision: number
  /** matched / nGt; 1 when nGt = 0 (vacuous). */
  recall: number
  /** Harmonic mean of precision and recall; 0 when both are 0. */
  hmean: number
  /** Median and 10th percentile of the matched pairs' IoU (null when nothing matched). */
  medianIou: number | null
  p10Iou: number | null
  matches: BoxMatch[]
}

/** Detection-style box scores at IoU > threshold (default 0.5) with greedy one-to-one matching. */
export function boxScores(gt: readonly Box[], hyp: readonly Box[], opts?: MatchOptions): BoxScores {
  const matches = matchBoxes(gt, hyp, opts)
  const k = matches.length
  const precision = hyp.length === 0 ? 1 : k / hyp.length
  const recall = gt.length === 0 ? 1 : k / gt.length
  const hmean = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  const ious = matches.map((m) => m.iou)
  return {
    matched: k,
    nGt: gt.length,
    nHyp: hyp.length,
    precision,
    recall,
    hmean,
    medianIou: percentile(ious, 0.5),
    p10Iou: percentile(ious, 0.1),
    matches
  }
}

// ---------------------------------------------------------------------------------------------
// Reading order

/**
 * Kendall's τ of a sequence of DISTINCT ranks against ascending order:
 * τ = (concordant − discordant) / (n(n−1)/2) = 1 − 4·inversions / (n(n−1)).
 * 1 = same order, −1 = reversed. n < 2 gives 1. O(n log n) (merge-sort inversion count).
 */
export function kendallTau(seq: readonly number[]): number {
  const n = seq.length
  if (n < 2) return 1
  if (new Set(seq).size !== n) throw new Error('kendallTau: ranks must be distinct')
  let a = Array.from(seq)
  let b = new Array<number>(n)
  let inversions = 0
  for (let width = 1; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += 2 * width) {
      const mid = Math.min(lo + width, n)
      const hi = Math.min(lo + 2 * width, n)
      let i = lo
      let j = mid
      let k = lo
      while (i < mid && j < hi) {
        if (a[i] <= a[j]) b[k++] = a[i++]
        else {
          inversions += mid - i
          b[k++] = a[j++]
        }
      }
      while (i < mid) b[k++] = a[i++]
      while (j < hi) b[k++] = a[j++]
    }
    ;[a, b] = [b, a]
  }
  return 1 - (4 * inversions) / (n * (n - 1))
}

/**
 * Reading-order τ of engine output: match hyp boxes (in the engine's output order) one-to-one to
 * GT boxes (in GT reading order) at IoU > 0.5, then τ over the matched GT indices taken in hyp
 * order. Unmatched words are ignored here (they show up in box recall instead).
 */
export function readingOrderTau(
  gt: readonly Box[],
  hypInOutputOrder: readonly Box[],
  opts?: MatchOptions
): { tau: number; matched: number } {
  const matches = matchBoxes(gt, hypInOutputOrder, opts)
  const seq = [...matches].sort((a, b) => a.hyp - b.hyp).map((m) => m.gt)
  return { tau: kendallTau(seq), matched: seq.length }
}

// ---------------------------------------------------------------------------------------------
// Copy fidelity

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let n = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) n++
  return n
}

function countRegex(haystack: string, re: RegExp): number {
  return (haystack.match(re) ?? []).length
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export interface CopyFidelity {
  /** The text a perfect copy yields: words joined by one space, lines by one "\n". */
  expected: string
  /**
   * "HelloWorld" joins: for each distinct concatenation a+b of two adjacent words on one GT line,
   * how many more times it occurs in the copy than in `expected` (capped at the number of such GT
   * pairs), summed.
   */
  joins: number
  /** Adjacent same-line GT words found separated by whitespace that holds ≥ 1 "\n" (same rule). */
  breaksWithinLine: number
  /** The subset of those whose whitespace holds ≥ 2 "\n" (a blank line inside a line). */
  doubleNewlinesWithinLine: number
  /** Runs of whitespace with ≥ 2 newlines anywhere in the copy (`expected` has none). */
  blankLineRuns: number
  /** Naive grapheme CER of the copy against `expected` (spaces and newlines count). */
  cer: EditStats
}

/**
 * Copy-fidelity checks of copied page text against the GT lines (each an array of words in
 * reading order). The copy is NFC-normalised first; "\r\n" counts as "\n".
 */
export function copyFidelity(
  gtLines: readonly (readonly string[])[],
  copied: string
): CopyFidelity {
  const lines = gtLines.map((ws) => ws.map((w) => w.normalize('NFC')))
  const expected = lines.map((ws) => ws.join(' ')).join('\n')
  const copy = copied.normalize('NFC').replace(/\r\n?/g, '\n')
  const pairs = new Map<string, { a: string; b: string; n: number }>()
  for (const ws of lines)
    for (let k = 0; k + 1 < ws.length; k++) {
      const key = ws[k] + '\u0000' + ws[k + 1]
      const p = pairs.get(key)
      if (p) p.n++
      else pairs.set(key, { a: ws[k], b: ws[k + 1], n: 1 })
    }
  let joins = 0
  let breaks = 0
  let doubles = 0
  for (const { a, b, n } of pairs.values()) {
    const joined = a + b
    joins += Math.min(
      n,
      Math.max(0, countOccurrences(copy, joined) - countOccurrences(expected, joined))
    )
    const brk = new RegExp(escapeRe(a) + '[^\\S\\n]*\\n\\s*' + escapeRe(b), 'gu')
    breaks += Math.min(n, Math.max(0, countRegex(copy, brk) - countRegex(expected, brk)))
    const dbl = new RegExp(escapeRe(a) + '[^\\S\\n]*\\n[^\\S\\n]*\\n\\s*' + escapeRe(b), 'gu')
    doubles += Math.min(n, Math.max(0, countRegex(copy, dbl) - countRegex(expected, dbl)))
  }
  return {
    expected,
    joins,
    breaksWithinLine: breaks,
    doubleNewlinesWithinLine: doubles,
    blankLineRuns: countRegex(copy, /\n(?:[^\S\n]*\n)+/g),
    cer: cer(expected, copy)
  }
}

// ---------------------------------------------------------------------------------------------
// Find recall and hit-on-target

export interface FindGtWord {
  /** The word as drawn (may carry punctuation, e.g. "dog,"). */
  t: string
  /** Its box in the same frame the search callback reports hits in. */
  box: Box
  /** Page index (default 0). */
  page?: number
}

export interface FindHit {
  page: number
  box: Box
}

/** Runs a search for `query` across the collection and returns every hit rect. */
export type SearchFn = (query: string) => readonly FindHit[] | Promise<readonly FindHit[]>

export interface FindWordResult {
  index: number
  query: string
  /** The query returned at least one hit on this word's page. */
  found: boolean
  /** Some hit on this page has IoU > threshold with the word's box. */
  onTarget: boolean
  /** Matched one-to-one among the hits for this query (duplicates each need their own hit). */
  matchedOneToOne: boolean
  bestIou: number
}

export interface FindScores {
  /** GT words with ≥ minGraphemes graphemes in their query (the denominator). */
  eligible: number
  /** found / eligible (1 when nothing is eligible). */
  recall: number
  /** onTarget / found among found words (1 when nothing was found). */
  hitOnTarget: number
  /** matchedOneToOne / eligible: recall that also needs one on-target hit per occurrence. */
  occurrenceRecall: number
  words: FindWordResult[]
}

export interface FindOptions {
  /** Minimum query length in graphemes. Default 3. */
  minGraphemes?: number
  /** IoU threshold for "on target" (strict >). Default 0.5. */
  threshold?: number
}

/**
 * Find recall and hit-on-target (DESIGN.md §3.9.2) over the GT words, given a search callback.
 * The query for a word is its NFC text with leading/trailing punctuation stripped ("dog," → "dog");
 * words whose query has fewer than `minGraphemes` graphemes are skipped. Each distinct query is
 * searched once. The callback owns query normalisation (the real harness passes the app's Find
 * engine), and must report hits in the GT words' frame.
 */
export async function findScores(
  gtWords: readonly FindGtWord[],
  search: SearchFn,
  opts: FindOptions = {}
): Promise<FindScores> {
  const minG = opts.minGraphemes ?? 3
  const threshold = opts.threshold ?? 0.5
  const byQuery = new Map<string, number[]>()
  gtWords.forEach((w, index) => {
    const q = w.t.normalize('NFC').replace(EDGE_PUNCT, '')
    if (graphemes(q).length < minG) return
    const list = byQuery.get(q)
    if (list) list.push(index)
    else byQuery.set(q, [index])
  })
  const results: FindWordResult[] = []
  for (const [query, indices] of byQuery) {
    const hits = await search(query)
    // One-to-one matching per page between this query's hits and its GT occurrences.
    const pages = new Set(indices.map((i) => gtWords[i].page ?? 0))
    const oneToOne = new Set<number>()
    for (const page of pages) {
      const occ = indices.filter((i) => (gtWords[i].page ?? 0) === page)
      const pageHits = hits.filter((h) => h.page === page)
      for (const m of matchBoxes(
        occ.map((i) => gtWords[i].box),
        pageHits.map((h) => h.box),
        { threshold }
      ))
        oneToOne.add(occ[m.gt])
    }
    for (const index of indices) {
      const w = gtWords[index]
      const pageHits = hits.filter((h) => h.page === (w.page ?? 0))
      let best = 0
      for (const h of pageHits) best = Math.max(best, iou(w.box, h.box))
      results.push({
        index,
        query,
        found: pageHits.length > 0,
        onTarget: best > threshold,
        matchedOneToOne: oneToOne.has(index),
        bestIou: best
      })
    }
  }
  results.sort((a, b) => a.index - b.index)
  const eligible = results.length
  const found = results.filter((r) => r.found).length
  const onTarget = results.filter((r) => r.found && r.onTarget).length
  const oneToOne = results.filter((r) => r.matchedOneToOne).length
  return {
    eligible,
    recall: eligible === 0 ? 1 : found / eligible,
    hitOnTarget: found === 0 ? 1 : onTarget / found,
    occurrenceRecall: eligible === 0 ? 1 : oneToOne / eligible,
    words: results
  }
}

/** A top-left-origin rect (search/geometry `PageRect`, page px at scale 1 = pt) → GT frame box. */
export function fromTopLeft(r: Box, pageHeight: number): Box {
  return { x: r.x, y: pageHeight - r.y - r.h, w: r.w, h: r.h }
}
