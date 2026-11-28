// Textbook cases for the OCR metrics, every expected value worked out by hand (the comment beside
// each one shows the arithmetic).

import { describe, expect, it } from 'vitest'

import {
  alignStats,
  bagOfWordsError,
  boxScores,
  cer,
  cerNormalised,
  copyFidelity,
  findScores,
  fromTopLeft,
  graphemes,
  iou,
  kendallTau,
  matchBoxes,
  ned,
  normalizeOcrD,
  percentile,
  readingOrderTau,
  wer,
  words,
  type Box,
  type FindHit
} from './metrics'

const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}' // man ZWJ woman ZWJ girl: one grapheme
const COUPLE = '\u{1F468}‍\u{1F469}'
const FLAG_DE = '\u{1F1E9}\u{1F1EA}'

describe('graphemes', () => {
  it('counts extended grapheme clusters after NFC', () => {
    expect(graphemes('')).toEqual([])
    expect(graphemes('abc')).toEqual(['a', 'b', 'c'])
    expect(graphemes('café')).toEqual(['c', 'a', 'f', 'é']) // NFC composes é
    expect(graphemes('q̇')).toEqual(['q̇']) // no precomposed form: still 1
    expect(graphemes(FAMILY)).toHaveLength(1) // 8 UTF-16 units
    expect(graphemes(`a${FLAG_DE}b`)).toHaveLength(3)
    expect(graphemes('東京都')).toHaveLength(3)
    expect(graphemes('Người')).toHaveLength(5)
  })
})

describe('normalizeOcrD and words', () => {
  it('drops BOM and bidi marks, collapses whitespace, keeps case and punctuation', () => {
    expect(normalizeOcrD('﻿  Hello,‎\t\nWorld!  ')).toBe('Hello, World!')
    expect(normalizeOcrD('a‫b⁦c؜d')).toBe('abcd')
    expect(normalizeOcrD('café')).toBe('café')
  })

  it('splits on whitespace and strips edge punctuation only', () => {
    expect(words('«Bonjour», dit-il.')).toEqual(['Bonjour', 'dit-il'])
    expect(words("don't 2026-11-27 $3.50 ...")).toEqual(["don't", '2026-11-27', '$3.50'])
    expect(words(' \n ')).toEqual([])
  })
})

describe('alignStats (lexicographic: min distance, then max matches)', () => {
  it('kitten → sitting', () => {
    // k→s (S), e→i (S), +g (I); matches i,t,t,n. S=2 D=0 I=1 C=4.
    expect(alignStats([...'kitten'], [...'sitting'])).toMatchObject({
      s: 2,
      d: 0,
      i: 1,
      c: 4,
      distance: 3,
      rate: 3 / 6,
      rateNormalised: 3 / 7
    })
  })

  it('prefers D+I with a match over two substitutions', () => {
    // "ab" vs "ba": distance 2 either way; best keeps one match: D=1 I=1 C=1.
    expect(alignStats(['a', 'b'], ['b', 'a'])).toMatchObject({
      s: 0,
      d: 1,
      i: 1,
      c: 1,
      distance: 2,
      rate: 1,
      rateNormalised: 2 / 3
    })
  })

  it('breaks ties toward matches on the deletion branch too', () => {
    // "aab" vs "baa": +b, a, a, −b keeps two matches (S=0 D=1 I=1 C=2), not b/a a/a a/b (S=2 C=1).
    expect(alignStats([...'aab'], [...'baa'])).toMatchObject({ s: 0, d: 1, i: 1, c: 2 })
    expect(alignStats([...'bba'], [...'abb'])).toMatchObject({ s: 0, d: 1, i: 1, c: 2 })
  })
})

describe('cer', () => {
  it('handles empty strings', () => {
    expect(cer('', '')).toMatchObject({ distance: 0, rate: 0, rateNormalised: 0 })
    expect(cer('', 'abc')).toMatchObject({ i: 3, rate: Infinity, rateNormalised: 1 })
    expect(cer('abc', '')).toMatchObject({ d: 3, rate: 1, rateNormalised: 1 })
  })

  it('all wrong', () => {
    expect(cer('abc', 'xyz')).toMatchObject({ s: 3, c: 0, rate: 1, rateNormalised: 1 })
  })

  it('can exceed 100% when the output adds text', () => {
    expect(cer('ab', 'abxyz').rate).toBe(3 / 2)
  })

  it('counts a combining sequence as one character', () => {
    expect(cer('café', 'café').distance).toBe(0) // same after NFC
    expect(cer('q̇x', 'qx')).toMatchObject({ s: 1, distance: 1, rate: 1 / 2 }) // q̇ → q
  })

  it('counts an emoji ZWJ sequence and a flag as one character each', () => {
    // a·👨‍👩‍👧·b vs a·👨‍👩·b: one substitution in 3.
    expect(cer(`a${FAMILY}b`, `a${COUPLE}b`)).toMatchObject({ s: 1, rate: 1 / 3 })
    expect(cer(`${FLAG_DE}x`, 'x')).toMatchObject({ d: 1, rate: 1 / 2 })
  })

  it('CJK', () => {
    // 東京都 → 東京: one deletion of 3; normalised 1/(1+2).
    expect(cer('東京都', '東京')).toMatchObject({ d: 1, rate: 1 / 3, rateNormalised: 1 / 3 })
  })

  it('naive keeps whitespace and marks; the OCR-D variant normalises them away', () => {
    expect(cer('a  b', 'a b')).toMatchObject({ d: 1, rate: 1 / 4 })
    expect(cerNormalised('a  b', 'a b').distance).toBe(0)
    expect(cer('x‏y', 'xy')).toMatchObject({ d: 1, rate: 1 / 3 })
    expect(cerNormalised('x‏y', 'xy').distance).toBe(0)
    expect(cerNormalised('Hello\nWorld', 'Hello World ').distance).toBe(0)
    // Case and punctuation are kept: H→h and the dropped "!" both count (2 of 6).
    expect(cerNormalised('Hello!', 'hello')).toMatchObject({ s: 1, d: 1, rate: 2 / 6 })
  })
})

describe('wer', () => {
  it('substitution, deletion, insertion', () => {
    // The→the only (the final "." is stripped): 1 of 4.
    expect(wer('The quick brown fox.', 'the quick brown  fox')).toMatchObject({ s: 1, rate: 1 / 4 })
    // a b c d vs a x c: b→x (S), d deleted (D): 2/4; normalised 2/(2+2).
    expect(wer('a b c d', 'a x c')).toMatchObject({
      s: 1,
      d: 1,
      i: 0,
      c: 2,
      rate: 0.5,
      rateNormalised: 0.5
    })
    // one +extra two: 1 insertion, 2 matches: rate 1/2, normalised 1/3.
    expect(wer('one two', 'one extra two')).toMatchObject({
      i: 1,
      rate: 1 / 2,
      rateNormalised: 1 / 3
    })
  })

  it('a "HelloWorld" join costs a substitution and a deletion', () => {
    expect(wer('Hello World', 'HelloWorld')).toMatchObject({ s: 1, d: 1, rate: 1 })
  })

  it('empty cases', () => {
    expect(wer('', '').rate).toBe(0)
    expect(wer('', 'x').rate).toBe(Infinity)
    expect(wer('x y', '').rate).toBe(1)
  })
})

describe('bagOfWordsError', () => {
  it('ignores order', () => {
    expect(bagOfWordsError('a b c', 'c b a')).toBe(0)
  })
  it('counts multiset differences over n_gt + n_hyp', () => {
    // a: 2−1, b: 1−2 → |1| + |−1| = 2 over 3 + 3.
    expect(bagOfWordsError('a a b', 'a b b')).toBe(2 / 6)
    // all wrong: 2 + 2 over 4.
    expect(bagOfWordsError('a b', 'x y')).toBe(1)
  })
  it('empty cases', () => {
    expect(bagOfWordsError('', '')).toBe(0)
    expect(bagOfWordsError('a', '')).toBe(1)
  })
})

describe('ned', () => {
  it('is distance / max length over graphemes, spaces included', () => {
    expect(ned('abc', 'abd')).toBe(1 / 3)
    expect(ned('', '')).toBe(0)
    expect(ned('', 'xyz')).toBe(1)
    expect(ned('abc', 'xyz')).toBe(1)
    expect(ned('東京都', '東京')).toBe(1 / 3)
    // PaddleOCR's norm_edit_dis would strip the space and score this as a perfect match.
    expect(ned('ab', 'a b')).toBe(1 / 3)
  })
})

describe('boxes', () => {
  const b = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h })

  it('iou', () => {
    expect(iou(b(0, 0, 2, 2), b(1, 1, 2, 2))).toBe(1 / 7) // ∩ 1, ∪ 4 + 4 − 1
    expect(iou(b(0, 0, 2, 2), b(0, 0, 2, 2))).toBe(1)
    expect(iou(b(0, 0, 2, 2), b(2, 0, 2, 2))).toBe(0) // touching
    expect(iou(b(0, 0, 0, 2), b(0, 0, 0, 2))).toBe(0) // no area
  })

  it('box scores: precision, recall, hmean, median/p10 IoU', () => {
    const gt = [b(0, 0, 10, 10), b(20, 0, 10, 10)]
    const hyp = [b(1, 0, 10, 10), b(25, 0, 10, 10), b(100, 100, 5, 5)]
    // gt0/hyp0: ∩ 90, ∪ 110 → 9/11 (match). gt1/hyp1: ∩ 50, ∪ 150 → 1/3 (no match).
    const s = boxScores(gt, hyp)
    expect(s.matched).toBe(1)
    expect(s.precision).toBe(1 / 3)
    expect(s.recall).toBe(1 / 2)
    expect(s.hmean).toBeCloseTo(0.4, 12) // 2·(1/3)(1/2)/(1/3 + 1/2)
    expect(s.medianIou).toBe(9 / 11)
    expect(s.p10Iou).toBe(9 / 11)
  })

  it('needs IoU strictly above the threshold', () => {
    // b(0,0,10,10) vs b(0,0,10,20): ∩ 100, ∪ 200 → exactly 0.5, which does not count.
    expect(boxScores([b(0, 0, 10, 10)], [b(0, 0, 10, 20)]).matched).toBe(0)
    expect(boxScores([b(0, 0, 10, 10)], [b(0, 0, 10, 20)], { order: 'index' }).matched).toBe(0)
  })

  it('greedy by IoU vs PaddleOCR index order', () => {
    const gt = [b(0, 0, 10, 10), b(4, 0, 10, 10)]
    const hyp = [b(3, 0, 10, 10)]
    // gt0/hyp0: ∩ 70, ∪ 130 = 7/13 > 0.5; gt1/hyp0: ∩ 90, ∪ 110 = 9/11.
    expect(matchBoxes(gt, hyp)).toEqual([{ gt: 1, hyp: 0, iou: 9 / 11 }])
    expect(matchBoxes(gt, hyp, { order: 'index' })).toEqual([{ gt: 0, hyp: 0, iou: 7 / 13 }])
  })

  it('one-to-one: a hyp box is used once', () => {
    const s = boxScores([b(0, 0, 10, 10), b(0, 0, 10, 10)], [b(0, 0, 10, 10)])
    expect(s.matched).toBe(1)
    expect(s.recall).toBe(0.5)
  })

  it('one-to-one: a gt box is used once (duplicate hyp boxes)', () => {
    for (const order of ['iou', 'index'] as const)
      expect(
        boxScores([b(0, 0, 10, 10)], [b(0, 0, 10, 10), b(0, 0, 10, 10)], { order })
      ).toMatchObject({ matched: 1, precision: 0.5, recall: 1 })
  })

  it('empty cases', () => {
    expect(boxScores([], [])).toMatchObject({ precision: 1, recall: 1, hmean: 1, medianIou: null })
    expect(boxScores([b(0, 0, 1, 1)], [])).toMatchObject({ precision: 1, recall: 0, hmean: 0 })
    expect(boxScores([], [b(0, 0, 1, 1)])).toMatchObject({ precision: 0, recall: 1, hmean: 0 })
  })

  it('percentile (linear interpolation)', () => {
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2.5) // position 1.5
    expect(percentile([4, 1, 3, 2], 0.1)).toBeCloseTo(1.3, 12) // position 0.3
    expect(percentile([7], 0.1)).toBe(7)
    expect(percentile([], 0.5)).toBeNull()
  })

  it('fromTopLeft flips a page-px rect into the bottom-left frame', () => {
    expect(fromTopLeft(b(10, 20, 30, 5), 100)).toEqual(b(10, 75, 30, 5))
  })
})

describe('reading order', () => {
  it('kendallTau', () => {
    expect(kendallTau([0, 1, 2, 3])).toBe(1)
    expect(kendallTau([3, 2, 1, 0])).toBe(-1)
    expect(kendallTau([1, 0, 2, 3])).toBeCloseTo(2 / 3, 12) // 1 inversion: 1 − 4·1/12
    expect(kendallTau([2, 0, 1])).toBeCloseTo(-1 / 3, 12) // 2 inversions: 1 − 8/6
    expect(kendallTau([])).toBe(1)
    expect(kendallTau([5])).toBe(1)
    expect(() => kendallTau([1, 1])).toThrow()
  })

  it('agrees with the O(n²) definition on a longer sequence', () => {
    const seq = [5, 2, 8, 0, 9, 1, 7, 3, 6, 4, 11, 10]
    let conc = 0
    let disc = 0
    for (let i = 0; i < seq.length; i++)
      for (let j = i + 1; j < seq.length; j++) {
        if (seq[i] < seq[j]) conc++
        else disc++
      }
    expect(kendallTau(seq)).toBeCloseTo((conc - disc) / ((seq.length * (seq.length - 1)) / 2), 12)
  })

  it('two columns read straight across', () => {
    // GT order: left-top 0, left-bottom 1, right-top 2, right-bottom 3.
    const gt = [
      { x: 0, y: 10, w: 5, h: 2 },
      { x: 0, y: 0, w: 5, h: 2 },
      { x: 10, y: 10, w: 5, h: 2 },
      { x: 10, y: 0, w: 5, h: 2 }
    ]
    // Output order: 0, 2, 1, 3 → one inversion → τ = 2/3.
    const r = readingOrderTau(gt, [gt[0], gt[2], gt[1], gt[3]])
    expect(r.matched).toBe(4)
    expect(r.tau).toBeCloseTo(2 / 3, 12)
  })
})

describe('copyFidelity', () => {
  const lines = [
    ['Hello', 'World', 'again'],
    ['next', 'line']
  ]

  it('a perfect copy', () => {
    const r = copyFidelity(lines, 'Hello World again\nnext line')
    expect(r).toMatchObject({
      joins: 0,
      breaksWithinLine: 0,
      doubleNewlinesWithinLine: 0,
      blankLineRuns: 0
    })
    expect(r.cer.distance).toBe(0)
    expect(r.expected).toBe('Hello World again\nnext line')
  })

  it('finds HelloWorld joins and blank lines inside a line', () => {
    const r = copyFidelity(lines, 'HelloWorld again\nnext\n\nline')
    expect(r.joins).toBe(1)
    expect(r.breaksWithinLine).toBe(1)
    expect(r.doubleNewlinesWithinLine).toBe(1)
    expect(r.blankLineRuns).toBe(1)
    // 27 graphemes each; the space after Hello deleted, next·␠ → \n (S) + one \n inserted = 3.
    expect(r.cer).toMatchObject({ s: 1, d: 1, i: 1, rate: 3 / 27 })
  })

  it('a single newline inside a line is a break but not a double newline', () => {
    const r = copyFidelity(lines, 'Hello\r\nWorld again\nnext line')
    expect(r).toMatchObject({ joins: 0, breaksWithinLine: 1, doubleNewlinesWithinLine: 0 })
  })

  it('does not flag a concatenation the GT itself contains', () => {
    expect(copyFidelity([['a', 'b'], ['ab']], 'a b\nab').joins).toBe(0)
    // …but caps repeats at the number of GT pairs.
    expect(copyFidelity([['a', 'b']], 'ab ab ab').joins).toBe(1)
  })

  it('an empty page', () => {
    expect(copyFidelity([], '')).toMatchObject({ expected: '', joins: 0, blankLineRuns: 0 })
    expect(copyFidelity([], '').cer.rate).toBe(0)
  })
})

describe('findScores', () => {
  const A = { x: 0, y: 0, w: 30, h: 10 }
  const B = { x: 40, y: 0, w: 30, h: 10 }
  const C = { x: 80, y: 0, w: 10, h: 10 }
  const D = { x: 0, y: 50, w: 30, h: 10 }

  it('recall is per occurrence; hit-on-target is per hit', async () => {
    const gtWords = [
      { t: 'Hello,', box: A },
      { t: 'world', box: B },
      { t: 'to', box: C }, // 2 graphemes: not eligible
      { t: 'world', box: D }, // second occurrence
      { t: 'missing', box: { x: 100, y: 0, w: 30, h: 10 } }
    ]
    const queries: string[] = []
    const hits: Record<string, FindHit[]> = {
      Hello: [{ page: 0, box: { x: 1, y: 0, w: 30, h: 10 } }], // IoU 29/31
      world: [{ page: 0, box: B }]
    }
    const r = await findScores(gtWords, (q) => {
      queries.push(q)
      return hits[q] ?? []
    })
    expect(queries).toEqual(['Hello', 'world', 'missing']) // punctuation stripped, deduplicated
    expect(r.eligible).toBe(4)
    // found: Hello, world(B); world(D) is NOT found by the hit on B → 2 of 4.
    expect(r).toMatchObject({ found: 2, recall: 2 / 4, anyHitOnPage: 3 / 4 })
    // Both hits are on target.
    expect(r).toMatchObject({ hits: 2, onTargetHits: 2, offTargetHits: 0, hitOnTarget: 1 })
    expect(r.words.map((w) => [w.index, w.found, w.anyHitOnPage])).toEqual([
      [0, true, true],
      [1, true, true],
      [3, false, true],
      [4, false, false]
    ])
    expect(r.words[0].bestIou).toBeCloseTo(29 / 31, 12)
  })

  it('a missed word is not found by a hit inside another word, which is a substring hit', async () => {
    const weather = { x: 40, y: 0, w: 42, h: 10 }
    const theInWeather = { x: 46, y: 0, w: 18, h: 10 } // the "the" of "weather"
    const r = await findScores(
      [
        { t: 'the', box: A },
        { t: 'weather', box: weather }
      ],
      (q) => (q === 'the' ? [{ page: 0, box: theInWeather }] : [{ page: 0, box: weather }])
    )
    expect(r.words[0]).toMatchObject({ found: false, anyHitOnPage: true })
    expect(r).toMatchObject({ found: 1, recall: 1 / 2 })
    // The hit is a correct substring match: not on target, not a false positive either.
    expect(r).toMatchObject({ hits: 2, onTargetHits: 1, substringHits: 1, offTargetHits: 0 })
    expect(r.hitOnTarget).toBe(1)
  })

  it('a second occurrence needs its own hit', async () => {
    const r = await findScores(
      [
        { t: 'harbour', box: A },
        { t: 'harbour', box: B }
      ],
      () => [{ page: 0, box: A }]
    )
    expect(r).toMatchObject({ eligible: 2, found: 1, recall: 1 / 2, hitOnTarget: 1 })
  })

  it('false positives and duplicate hits count against hit-on-target', async () => {
    const far = { x: 200, y: 0, w: 30, h: 10 }
    const r = await findScores([{ t: 'harbour', box: A }], () => [
      { page: 0, box: A },
      { page: 0, box: far }, // nowhere near a GT word
      { page: 0, box: A }, // a doubled hit on the one occurrence
      { page: 3, box: A } // a page with no occurrence at all
    ])
    expect(r).toMatchObject({ recall: 1, hits: 4, onTargetHits: 1, offTargetHits: 3 })
    expect(r.hitOnTarget).toBe(1 / 4)
    expect(r.strayHits).toEqual([
      { query: 'harbour', page: 0, box: far },
      { query: 'harbour', page: 0, box: A },
      { query: 'harbour', page: 3, box: A }
    ])
  })

  it('case and diacritic variants are one search, and each copy is an occurrence', async () => {
    const queries: string[] = []
    const r = await findScores(
      [
        { t: 'The', box: A },
        { t: 'the', box: B },
        { t: 'thé', box: D }
      ],
      (q) => {
        queries.push(q)
        return [A, B, D].map((box) => ({ page: 0, box }))
      }
    )
    expect(queries).toEqual(['The'])
    expect(r).toMatchObject({ found: 3, recall: 1, onTargetHits: 3, hitOnTarget: 1 })
  })

  it('on target needs IoU strictly above the threshold', async () => {
    // A vs a hit twice as tall: ∩ 300, ∪ 600 → exactly 0.5.
    const r = await findScores([{ t: 'alpha', box: A }], () => [
      { page: 0, box: { x: 0, y: 0, w: 30, h: 20 } }
    ])
    expect(r).toMatchObject({ found: 0, onTargetHits: 0, offTargetHits: 1, hitOnTarget: 0 })
    expect(r.words[0].bestIou).toBe(0.5)
  })

  it('counts hits only on the word’s own page, and accepts async search', async () => {
    const r = await findScores(
      [
        { t: 'alpha', box: A, page: 1 },
        { t: 'alpha', box: A, page: 0 }
      ],
      async () => [{ page: 1, box: A }]
    )
    expect(r.words.map((w) => [w.found, w.anyHitOnPage])).toEqual([
      [true, true],
      [false, false]
    ])
    expect(r.recall).toBe(1 / 2)
    expect(r.hitOnTarget).toBe(1)
  })

  it('measures eligibility in graphemes', async () => {
    const seen: string[] = []
    await findScores(
      [
        { t: '東京', box: A },
        { t: '東京都', box: A },
        { t: `a${FAMILY}b`, box: A },
        { t: 'été', box: A },
        { t: '(ok)', box: A }
      ],
      (q) => {
        seen.push(q)
        return []
      }
    )
    expect(seen).toEqual(['東京都', `a${FAMILY}b`, 'été'])
  })

  it('nothing eligible', async () => {
    expect(await findScores([], () => [])).toMatchObject({
      eligible: 0,
      recall: 1,
      anyHitOnPage: 1,
      hits: 0,
      hitOnTarget: 1
    })
  })
})
