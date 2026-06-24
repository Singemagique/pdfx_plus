import type { DocEntry } from '../types'
import type { PageRef } from './types'

export interface SelectedTarget {
  doc: DocEntry
  index: number
}

export function findSelectedTarget(
  docs: DocEntry[],
  selected: PageRef | null
): SelectedTarget | null {
  if (!selected) return null
  const doc = docs.find((d) => d.id === selected.docId)
  const index = doc?.pages.findIndex((p) => p.id === selected.pageId) ?? -1
  return doc && index !== -1 ? { doc, index } : null
}
