import { useLayoutEffect, useRef } from 'react'
import type { DocEntry } from '../types'
import type { CanvasLayout } from './layout'
import type { FitFocus } from './use-auto-fit'

/**
 * The first document (in collection order) that was imported between `prev` and `next`: an id not
 * present before that brings at least one page not present before. That covers open, drop and
 * paste-as-new-document, while a page dragged out into a new document between two others — a new
 * doc id, but every page already on the canvas — is a move, not an import, and must not re-fit.
 */
export function findImportedDoc(
  prev: readonly DocEntry[],
  next: readonly DocEntry[]
): string | null {
  const prevDocs = new Set(prev.map((d) => d.id))
  let prevPages: Set<string> | null = null
  for (const doc of next) {
    if (prevDocs.has(doc.id)) continue
    prevPages ??= new Set(prev.flatMap((d) => d.pages.map((p) => p.id)))
    const seen = prevPages
    if (doc.pages.length === 0 || doc.pages.some((p) => !seen.has(p.id))) return doc.id
  }
  return null
}

/**
 * Compare the docs being rendered with the last COMMITTED docs and, when documents were imported,
 * return a fresh focus on the first new one (its top in `layout`). It is non-null for exactly the
 * render that introduces the documents; the canvas keys its animated fit on the object's identity.
 */
export function useImportFocus(docs: DocEntry[], layout: CanvasLayout): FitFocus | null {
  const committed = useRef<DocEntry[] | null>(null)
  const lastFocus = useRef<{ docs: DocEntry[]; focus: FitFocus | null } | null>(null)
  let focus: FitFocus | null = null
  if (committed.current && committed.current !== docs) {
    // Memoised per `docs` so a re-render before commit (e.g. StrictMode) hands back the same object.
    if (lastFocus.current?.docs === docs) focus = lastFocus.current.focus
    else {
      const id = findImportedDoc(committed.current, docs)
      const item = id ? layout.items.find((i) => i.doc.id === id) : undefined
      focus = item ? { y: item.y } : null
      lastFocus.current = { docs, focus }
    }
  }
  useLayoutEffect(() => {
    committed.current = docs
  })
  return focus
}
