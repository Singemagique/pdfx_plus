import type { DocEntry, PageEntry } from '../../types'
import { CARD_PAD_X, PAGE_GAP } from '../layout'

/** A wrap width holding exactly `n` letter pages (216 world px) per row. */
export const wrapForLetterPages = (n: number): number =>
  n * 216 + (n - 1) * PAGE_GAP + 2 * CARD_PAD_X
/** Five letter pages per row: what the default ~1300–1400 css px canvas wraps to. */
export const WRAP_5 = wrapForLetterPages(5)

/** US Letter portrait: 216 world px wide at the 280 px thumbnail height. */
export const LETTER = { width: 612, height: 792 }
/** US Letter landscape: 362 world px wide. */
export const LANDSCAPE = { width: 792, height: 612 }

export function page(id: string, size = LETTER, pageIndex = 0): PageEntry {
  return {
    id,
    source: { id: `src-${id}` } as PageEntry['source'],
    pageIndex,
    width: size.width,
    height: size.height
  }
}

export function doc(id: string, count: number, size = LETTER): DocEntry {
  return {
    id,
    name: `${id}.pdf`,
    pages: Array.from({ length: count }, (_, i) => page(`${id}-p${i}`, size))
  }
}
