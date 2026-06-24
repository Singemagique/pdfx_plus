import { uniqueDocName } from '../names'
import type { DocEntry } from '../../types'
import type { PageRef } from '../types'

export function movePageInto(
  docs: DocEntry[],
  source: PageRef,
  targetDocId: string,
  index: number
): DocEntry[] {
  const page = docs.find((d) => d.id === source.docId)?.pages.find((p) => p.id === source.pageId)
  if (!page) return docs
  if (source.docId === targetDocId) {
    const di = docs.findIndex((d) => d.id === targetDocId)
    const doc = docs[di]
    const without = doc.pages.filter((p) => p.id !== source.pageId)
    const to = Math.max(0, Math.min(without.length, index))
    const pages = [...without.slice(0, to), page, ...without.slice(to)]
    if (pages.length === doc.pages.length && pages.every((p, i) => p === doc.pages[i])) return docs
    const next = [...docs]
    next[di] = { ...doc, pages }
    return next
  }
  return docs
    .map((d) => {
      if (d.id === source.docId) {
        return { ...d, pages: d.pages.filter((p) => p.id !== source.pageId) }
      }
      if (d.id === targetDocId) {
        const clamped = Math.max(0, Math.min(d.pages.length, index))
        return { ...d, pages: [...d.pages.slice(0, clamped), page, ...d.pages.slice(clamped)] }
      }
      return d
    })
    .filter((d) => d.pages.length > 0)
}

export function movePageToNewDoc(
  docs: DocEntry[],
  source: PageRef,
  docIndex: number,
  newDocId: string
): DocEntry[] {
  const sdi = docs.findIndex((d) => d.id === source.docId)
  if (sdi === -1) return docs
  const sourceDoc = docs[sdi]
  const page = sourceDoc.pages.find((p) => p.id === source.pageId)
  if (!page) return docs
  const remaining = sourceDoc.pages.filter((p) => p.id !== source.pageId)
  let next = docs.map((d) => (d.id === source.docId ? { ...d, pages: remaining } : d))
  let insertAt = docIndex
  if (remaining.length === 0) {
    next = next.filter((d) => d.id !== source.docId)
    if (sdi < docIndex) insertAt -= 1
  }
  insertAt = Math.max(0, Math.min(next.length, insertAt))
  const name = uniqueDocName(sourceDoc.name, new Set(next.map((d) => d.name)))
  const newDoc: DocEntry = { id: newDocId, name, pages: [page] }
  return [...next.slice(0, insertAt), newDoc, ...next.slice(insertAt)]
}
