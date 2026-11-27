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
 * return a focus on the first new one (its top in `layout`). It is non-null for exactly the renders
 * that introduce documents; the canvas keys its animated fit on the object's identity.
 *
 * One import operation can commit several times — a multi-file open adds each file as it finishes
 * loading. While `busy` (and in the commit that clears it, which can carry the last file) every
 * later import of the batch hands back the SAME focus object as its first, so the view stays on the
 * batch's first document instead of chasing each file down the column.
 */
export function useImportFocus(
  docs: DocEntry[],
  layout: CanvasLayout,
  busy = false
): FitFocus | null {
  const committed = useRef<{ docs: DocEntry[]; busy: boolean } | null>(null)
  const lastFocus = useRef<{ docs: DocEntry[]; focus: FitFocus | null } | null>(null)
  const batch = useRef<FitFocus | null>(null)
  let focus: FitFocus | null = null
  if (committed.current && committed.current.docs !== docs) {
    // Memoised per `docs` so a re-render before commit (e.g. StrictMode) hands back the same object.
    if (lastFocus.current?.docs === docs) focus = lastFocus.current.focus
    else {
      const inBatch = busy || committed.current.busy
      const id = findImportedDoc(committed.current.docs, docs)
      if (id && inBatch && batch.current) focus = batch.current
      else {
        const item = id ? layout.items.find((i) => i.doc.id === id) : undefined
        focus = item ? { y: item.y } : null
        if (focus && inBatch) batch.current = focus
      }
      lastFocus.current = { docs, focus }
    }
  }
  useLayoutEffect(() => {
    committed.current = { docs, busy }
    if (!busy) batch.current = null
  })
  return focus
}
