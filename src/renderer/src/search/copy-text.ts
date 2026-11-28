// Copy Page Text (DESIGN.md §3.6.3): a page's text for the clipboard, built from the SAME items Find
// searches (engine.getPageText(key).items: native and/or recognised, redaction-filtered), not from
// the folded search string. The Document-menu command and its clipboard IPC arrive later (PR7b/PR8).
//
// - Items in source order; a line ends at every hasEOL and wherever buildPageText sees the baseline
//   jump (the same rule, so Copy and Find agree on lines).
// - Within a line, every whitespace run becomes one space; line ends are trimmed. No space is ever
//   dropped, even between two CJK characters: a space in the items is the PDF's own (a name
//   "山田 太郎", a heading's U+3000) or a redaction's word boundary, and Find searches the same
//   items with it. The CJK no-space rule (shared/ocr/spacing.ts `needsSpaceBetween`) applies where
//   spaces are SYNTHESIZED, upstream: ocr/to-page-text.ts emits no ' ' item between CJK words.
// - One "\n" per line; a line left empty (all whitespace, e.g. fully redacted) is dropped, so the
//   copy never holds a blank line.

import { baselineJumped, type TextItemGeom } from './extract'

const WHITESPACE = /\s+/gu

/** One line's raw text → its copy form (single spaces, trimmed). */
const tidyLine = (raw: string): string => raw.trim().replace(WHITESPACE, ' ')

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
