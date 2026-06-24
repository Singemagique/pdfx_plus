import { dedupeNames, uniqueDocName } from '../names'
import type { DocEntry } from '../../types'

export function removeDoc(docs: DocEntry[], id: string): DocEntry[] {
  return docs.filter((d) => d.id !== id)
}

export function renameDoc(docs: DocEntry[], id: string, name: string): DocEntry[] {
  const taken = new Set(docs.filter((d) => d.id !== id).map((d) => d.name))
  return docs.map((d) => (d.id === id ? { ...d, name: uniqueDocName(name, taken) } : d))
}

export function reorderDoc(docs: DocEntry[], id: string, direction: -1 | 1): DocEntry[] {
  const index = docs.findIndex((d) => d.id === id)
  const target = index + direction
  if (index === -1 || target < 0 || target >= docs.length) return docs
  const next = [...docs]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

export function spliceDocsAfter(
  docs: DocEntry[],
  anchorDocId: string | null,
  newDocs: DocEntry[]
): DocEntry[] {
  let at = anchorDocId === null ? 0 : docs.findIndex((d) => d.id === anchorDocId) + 1
  if (anchorDocId !== null && at === 0) at = docs.length
  at = Math.max(0, Math.min(docs.length, at))
  const deduped = dedupeNames(docs, newDocs)
  return [...docs.slice(0, at), ...deduped, ...docs.slice(at)]
}
