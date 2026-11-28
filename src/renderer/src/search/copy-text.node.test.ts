import { describe, expect, it } from 'vitest'
import { pageCopyText } from './copy-text'
import { buildPageText, type PageTextItem } from './extract'
import { filterRedacted } from './redact-filter'

const VT = [1, 0, 0, -1, 0, 792]

function item(str: string, x: number, y: number, extra: Partial<PageTextItem> = {}): PageTextItem {
  return {
    str,
    t: [10, 0, 0, 10, x, y],
    width: str.length * 5,
    height: 10,
    ascent: 0.8,
    descent: -0.2,
    vertical: false,
    rtl: false,
    mono: true,
    hasEOL: false,
    ...extra
  }
}

describe('pageCopyText', () => {
  it('one line per hasEOL, single spaces, line ends trimmed', () => {
    const text = pageCopyText([
      item('Hello   world ', 50, 700, { hasEOL: true }),
      item(' second', 50, 686),
      item('\tline  ', 90, 686, { hasEOL: true })
    ])
    expect(text).toBe('Hello world\nsecond line')
  })

  it('breaks a line where the baseline jumps without a hasEOL (as buildPageText does)', () => {
    expect(pageCopyText([item('first', 50, 700), item('second', 50, 680)])).toBe('first\nsecond')
    // A superscript is not a new line.
    expect(pageCopyText([item('x', 50, 700), item('2', 55, 703)])).toBe('x2')
  })

  it('never writes a blank line (an all-space or fully redacted line is dropped)', () => {
    const items = [
      item('top', 50, 700, { hasEOL: true }),
      item('secret', 50, 680, { hasEOL: true }),
      item('   ', 50, 660, { hasEOL: true }),
      item('bottom', 50, 640, { hasEOL: true })
    ]
    const redacted = filterRedacted(items, [{ x: 40, y: 792 - 690, w: 60, h: 12 }], VT)
    expect(pageCopyText(redacted)).toBe('top\nbottom')
  })

  it('keeps a space the PDF has between CJK characters, as Find does (one space)', () => {
    // A name, and a heading with an IDEOGRAPHIC SPACE (U+3000).
    const items = [
      item('山田 太郎', 50, 700, { hasEOL: true }),
      item('第1章　概要', 50, 680, { hasEOL: true })
    ]
    expect(pageCopyText(items)).toBe('山田 太郎\n第1章 概要')
    // Copy shows what Find finds: the same spaces in the searched text.
    const norm = buildPageText(items, VT).norm
    expect(norm).toContain('山田 太郎')
    expect(norm).toContain('第1章 概要')
    // A non-BMP Han character before a space; a run of spaces is one.
    expect(pageCopyText([item('𠀋 字   Tokyo 한국어 문서', 50, 700)])).toBe(
      '𠀋 字 Tokyo 한국어 문서'
    )
  })

  it('adds no space between items that have none (recognised CJK words)', () => {
    const items = [item('東京', 50, 700), item('都庁', 60, 700), item('と', 70, 700)]
    expect(pageCopyText(items)).toBe('東京都庁と')
  })

  it('a vertical column of items with no hasEOL is one line (as buildPageText)', () => {
    const v = (str: string, y: number): PageTextItem =>
      item(str, 100, y, { vertical: true, width: 10, height: 20 })
    const items = [v('ab', 700), v('cd', 680)]
    expect(pageCopyText(items)).toBe('abcd')
    expect(buildPageText(items, VT).norm).toBe('abcd')
  })

  it('keeps a hyphen at a line end (the copy is not the folded search text)', () => {
    expect(pageCopyText([item('exam-', 50, 700, { hasEOL: true }), item('ple', 50, 686)])).toBe(
      'exam-\nple'
    )
  })
})
