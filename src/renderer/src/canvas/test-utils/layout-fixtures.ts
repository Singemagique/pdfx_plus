import type { DocEntry, PageEntry } from '../../types'

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
