// Copy Page Text (DESIGN.md §3.6.3): a page's text for the clipboard, built from the SAME items Find
// searches (engine.getPageText(key).items: native and/or recognised, redaction-filtered), not from
// the folded search string. The Document-menu command and its clipboard IPC arrive later (PR7b/PR8).
//
// - Items in source order; a line ends at every hasEOL and wherever buildPageText sees the baseline
//   jump (the same rule, so Copy and Find agree on lines).
// - Within a line, every whitespace run becomes one space — or none between two CJK characters
//   that `needsSpaceBetween` (shared/ocr/spacing.ts) keeps together; line ends are trimmed.
// - One "\n" per line; a line left empty (all whitespace, e.g. fully redacted) is dropped, so the
//   copy never holds a blank line.

import { needsSpaceBetween } from '../../../shared/ocr/spacing'
import { baselineJumped, type TextItemGeom } from './extract'

const WHITESPACE = /\s+/gu

/** One line's raw text → its copy form (single spaces with the CJK rule, trimmed). */
function tidyLine(raw: string): string {
  const s = raw.trim()
  return s.replace(WHITESPACE, (_m, offset: number) => {
    const before = String.fromCodePoint(s.codePointAt(offset - 1) ?? 0x20)
    // A low surrogate before the run: read the whole code point.
    const prev =
      offset >= 2 && /[\udc00-\udfff]/.test(s[offset - 1]) ? s.slice(offset - 2, offset) : before
    const next = String.fromCodePoint(s.codePointAt(offset + _m.length) ?? 0x20)
    return needsSpaceBetween(prev, next) ? ' ' : ''
  })
}

/** The copy text of a page's items (see the header). */
export function pageCopyText(items: readonly TextItemGeom[]): string {
  const lines: string[] = []
  let cur = ''
  let prev: TextItemGeom | null = null
  let broke = false
  const endLine = (): void => {
    const line = tidyLine(cur)
    if (line) lines.push(line)
    cur = ''
  }
  for (const it of items) {
    const solid = it.str.trim().length > 0
    if (solid && prev !== null && !broke && !prev.vertical && baselineJumped(prev, it)) endLine()
    cur += it.str
    if (it.hasEOL) endLine()
    if (solid) {
      prev = it
      broke = !!it.hasEOL
    } else if (it.hasEOL) broke = true
  }
  endLine()
  return lines.join('\n')
}
