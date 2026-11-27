import { describe, expect, it } from 'vitest'
import { compileQuery, findAll, normalizeQuery, normalizeSegments, type Segment } from './normalize'

const norm = (...segs: Array<string | Segment>): string =>
  normalizeSegments(segs.map((s) => (typeof s === 'string' ? { str: s, hasEOL: false } : s))).text
const line = (str: string): Segment => ({ str, hasEOL: true })

/** Every [start, end) match of `query` in the normalized segments. */
function matches(query: string, ...segs: Array<string | Segment>): string[] {
  const n = normalizeSegments(
    segs.map((s) => (typeof s === 'string' ? { str: s, hasEOL: false } : s))
  )
  const re = compileQuery(normalizeQuery(query))
  if (!re) return []
  const pairs = findAll(n.text, re, 100)
  const out: string[] = []
  for (let i = 0; i < pairs.length; i += 2) out.push(n.text.slice(pairs[i], pairs[i + 1]))
  return out
}

/** The raw text a normalized range maps back to (synthetic units skipped). */
function rawOf(segs: Segment[], ns: number, ne: number): string {
  const n = normalizeSegments(segs)
  const raw = segs.map((s) => s.str).join('')
  let lo = Infinity
  let hi = -Infinity
  for (let i = ns; i < ne; i++) {
    if (n.srcStart[i] < 0) continue
    lo = Math.min(lo, n.srcStart[i])
    hi = Math.max(hi, n.srcEnd[i])
  }
  return raw.slice(lo, hi)
}

describe('normalizeSegments', () => {
  it('folds case', () => {
    expect(norm('Hello WORLD')).toBe('hello world')
  })

  it('strips diacritics, composed or decomposed', () => {
    expect(norm('café')).toBe('cafe')
    expect(norm('CAFÉ')).toBe('cafe')
    expect(norm('café')).toBe('cafe')
    expect(norm('naïve Ångström')).toBe('naive angstrom')
  })

  it('maps a decomposed letter back over both raw units', () => {
    const n = normalizeSegments([{ str: 'café!', hasEOL: false }])
    expect(n.text).toBe('cafe!')
    expect([n.srcStart[3], n.srcEnd[3]]).toEqual([3, 5])
    expect([n.srcStart[4], n.srcEnd[4]]).toEqual([5, 6])
  })

  it('applies compatibility forms (full-width)', () => {
    expect(norm('ＡＢＣ１２３')).toBe('abc123')
  })

  it('expands ligatures, both letters mapping to the one raw char', () => {
    const n = normalizeSegments([{ str: 'ﬁle ﬂow', hasEOL: false }])
    expect(n.text).toBe('file flow')
    expect([n.srcStart[0], n.srcEnd[0], n.srcStart[1], n.srcEnd[1]]).toEqual([0, 1, 0, 1])
    expect(matches('file', 'the ﬁle')).toEqual(['file'])
  })

  it('folds a dotted capital I to i, consistently on both sides', () => {
    expect(norm('İstanbul')).toBe('istanbul')
    expect(matches('istanbul', 'İSTANBUL')).toHaveLength(1)
    expect(matches('İstanbul', 'istanbul')).toHaveLength(1)
  })

  it('drops a soft hyphen mid-word', () => {
    expect(norm('exam­ple')).toBe('example')
  })

  it('joins a word split by a soft hyphen at the line end', () => {
    expect(norm(line('exam­'), 'ple')).toBe('example')
  })

  it('joins a word split by a hard hyphen at the line end, keeping the maps consistent', () => {
    const segs = [line('the exam-'), { str: 'ple here', hasEOL: false }]
    const n = normalizeSegments(segs)
    expect(n.text).toBe('the example here')
    expect(n.srcStart.length).toBe(n.text.length)
    expect(n.srcEnd.length).toBe(n.text.length)
    const at = n.text.indexOf('example')
    expect(rawOf(segs, at, at + 'example'.length)).toBe('exam-ple')
    // The "p" maps into the second item.
    expect(n.srcStart[at + 4]).toBe('the exam-'.length)
  })

  it('keeps a hyphen in the middle of a line', () => {
    expect(norm('well-known')).toBe('well-known')
  })

  it('matches "well-known" against a broken and an inline hyphenation', () => {
    expect(matches('well-known', line('a well-'), 'known fact')).toEqual(['wellknown'])
    expect(matches('well-known', 'a well-known fact')).toEqual(['well-known'])
    expect(matches('Well-Known', 'WELL-KNOWN')).toHaveLength(1)
  })

  it('matches a range split at its hyphen', () => {
    expect(matches('2019-2020', line('from 2019-'), '2020 on')).toHaveLength(1)
  })

  it('keeps the space of a free-standing dash at the line end', () => {
    expect(norm(line('word -'), 'next')).toBe('word - next')
  })

  it('turns a plain line break into a space', () => {
    expect(norm(line('foo'), 'bar')).toBe('foo bar')
    expect(matches('foo bar', line('foo'), 'bar')).toEqual(['foo bar'])
  })

  it('joins CJK lines without a space', () => {
    expect(norm(line('東京'), '大学')).toBe('東京大学')
  })

  it('collapses and trims whitespace (spaces, tabs, NBSP)', () => {
    expect(norm('  a \t  b  ')).toBe('a b')
    expect(norm('a', '   ', 'b')).toBe('a b')
  })

  it('treats an empty item carrying only hasEOL as a break', () => {
    expect(norm('foo', { str: '', hasEOL: true }, 'bar')).toBe('foo bar')
    expect(norm('exam-', { str: '', hasEOL: true }, 'ple')).toBe('example')
  })

  it('honours breakBefore', () => {
    expect(norm('exam-', { str: 'ple', hasEOL: false, breakBefore: true })).toBe('example')
    expect(norm('foo', { str: 'bar', hasEOL: false, breakBefore: true })).toBe('foo bar')
  })

  it('marks the space standing in for a line break as synthetic', () => {
    const n = normalizeSegments([line('foo'), { str: 'bar', hasEOL: false }])
    expect(n.srcStart[3]).toBe(-1)
    expect(n.srcEnd[3]).toBe(-1)
  })

  it('maps a match spanning two items back to both raw ranges', () => {
    const segs: Segment[] = [
      { str: 'Hel', hasEOL: false },
      { str: 'lo world', hasEOL: false }
    ]
    const n = normalizeSegments(segs)
    expect(Array.from(n.itemStarts)).toEqual([0, 3])
    expect(n.text).toBe('hello world')
    expect(rawOf(segs, 0, 5)).toBe('Hello')
    expect(n.srcStart[2]).toBe(2)
    expect(n.srcStart[3]).toBe(3)
  })
})

describe('compileQuery / findAll', () => {
  it('is null for a blank query', () => {
    expect(compileQuery(normalizeQuery(''))).toBeNull()
    expect(compileQuery(normalizeQuery('   '))).toBeNull()
  })

  it('keeps a lone hyphen literal (no zero-length matches)', () => {
    const re = compileQuery(normalizeQuery('-'))!
    expect(re.source).toBe('-')
    expect(Array.from(findAll('a-b-c', re, 10))).toEqual([1, 2, 3, 4])
  })

  it('escapes regex metacharacters', () => {
    expect(matches('a.b', 'aXb a.b')).toEqual(['a.b'])
    expect(matches('(x)', '(x) x')).toEqual(['(x)'])
  })

  it('never loops on a zero-length pattern', () => {
    expect(Array.from(findAll('abc', /x?/gu, 10))).toEqual([])
  })

  it('respects its limit', () => {
    const re = compileQuery('a')!
    expect(findAll('aaaaaa', re, 3).length).toBe(6)
  })
})
