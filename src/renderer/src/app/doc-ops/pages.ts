import { uniqueDocName } from '../names'
import type { DocEntry, PageEntry } from '../../types'
import type { PageRef } from '../types'

export function insertPastedPage(
  docs: DocEntry[],
  selected: PageRef,
  pasted: PageEntry
): DocEntry[] {
  return docs.map((doc) => {
    if (doc.id !== selected.docId) return doc
    const index = doc.pages.findIndex((p) => p.id === selected.pageId)
    if (index === -1) return doc
    const pages = [...doc.pages]
    pages.splice(index + 1, 0, pasted)
    return { ...doc, pages }
  })
}

export function insertPagesAfter(
  docs: DocEntry[],
  docId: string,
  index: number,
  entries: PageEntry[]
): DocEntry[] {
  return docs.map((d) =>
    d.id === docId
      ? { ...d, pages: [...d.pages.slice(0, index + 1), ...entries, ...d.pages.slice(index + 1)] }
      : d
  )
}

export function appendPages(docs: DocEntry[], docId: string, entries: PageEntry[]): DocEntry[] {
  return docs.map((d) => (d.id === docId ? { ...d, pages: [...d.pages, ...entries] } : d))
}

export function insertPagesIntoDoc(
  docs: DocEntry[],
  docId: string,
  index: number,
  entries: PageEntry[]
): DocEntry[] {
  if (!docs.some((d) => d.id === docId)) {
    const name = uniqueDocName('Untitled', new Set(docs.map((d) => d.name)))
    return [...docs, { id: crypto.randomUUID(), name, pages: entries }]
  }
  return docs.map((d) => {
    if (d.id !== docId) return d
    const clamped = Math.max(0, Math.min(d.pages.length, index))
    return { ...d, pages: [...d.pages.slice(0, clamped), ...entries, ...d.pages.slice(clamped)] }
  })
}
