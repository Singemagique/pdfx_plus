import { describe, expect, it } from 'vitest'
import { pageCopyText } from './copy-text'
import type { PageTextItem } from './extract'
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

  it('keeps CJK runs together: no space between two CJK characters, one elsewhere', () => {
    expect(pageCopyText([item('東京 都庁 と Tokyo 한국어 문서', 50, 700)])).toBe(
      '東京都庁と Tokyo 한국어 문서'
    )
    // A non-BMP Han character before the space.
    expect(pageCopyText([item('𠀋 字', 50, 700)])).toBe('𠀋字')
  })

  it('keeps a hyphen at a line end (the copy is not the folded search text)', () => {
    expect(pageCopyText([item('exam-', 50, 700, { hasEOL: true }), item('ple', 50, 686)])).toBe(
      'exam-\nple'
    )
  })
})
