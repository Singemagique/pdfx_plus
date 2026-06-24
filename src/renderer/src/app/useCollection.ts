import { useCallback, useRef, useState } from 'react'
import * as docOps from './doc-ops/docs'
import * as pageOps from './doc-ops/pages'
import * as moveOps from './doc-ops/move'
import { useClipboard } from './useClipboard'
import type { SelectedTarget } from './selection'
import type { PageRef } from './types'
import type { DocEntry, PageEntry } from '../types'

export function useCollection(flash: (message: string) => void) {
  const [docs, setDocs] = useState<DocEntry[]>([])
  const [selected, setSelected] = useState<PageRef | null>(null)
  const docsRef = useRef(docs)
  docsRef.current = docs

  const { copySelected, pasteAfterSelected } = useClipboard(
    docs,
    selected,
    setDocs,
    setSelected,
    flash
  )

  const selectPage = useCallback((docId: string, pageId: string) => {
    setSelected({ docId, pageId })
  }, [])

  const clearSelection = useCallback(() => setSelected(null), [])

  const removeDoc = useCallback((id: string) => {
    setDocs((prev) => docOps.removeDoc(prev, id))
    setSelected((sel) => (sel?.docId === id ? null : sel))
  }, [])

  const renameDoc = useCallback((id: string, name: string) => {
    setDocs((prev) => docOps.renameDoc(prev, id, name))
  }, [])

  const moveDoc = useCallback((id: string, direction: -1 | 1) => {
    setDocs((prev) => docOps.reorderDoc(prev, id, direction))
  }, [])

  const deletePage = useCallback(
    (target: PageRef) => {
      const doc = docs.find((d) => d.id === target.docId)
      const index = doc?.pages.findIndex((p) => p.id === target.pageId) ?? -1
      if (!doc || index === -1) return
      const pages = doc.pages.filter((p) => p.id !== target.pageId)
      const neighbor = pages[Math.min(index, pages.length - 1)]
      setDocs((prev) =>
        prev.map((d) => (d.id === doc.id ? { ...d, pages } : d)).filter((d) => d.pages.length > 0)
      )
      setSelected(neighbor ? { docId: doc.id, pageId: neighbor.id } : null)
    },
    [docs]
  )

  const insertPagesAfter = useCallback((target: SelectedTarget, entries: PageEntry[]) => {
    if (entries.length === 0) return
    setDocs((prev) => pageOps.insertPagesAfter(prev, target.doc.id, target.index, entries))
    setSelected({ docId: target.doc.id, pageId: entries[entries.length - 1].id })
  }, [])

  const appendPagesToDoc = useCallback((docId: string, entries: PageEntry[]) => {
    if (entries.length === 0) return
    setDocs((prev) => pageOps.appendPages(prev, docId, entries))
    setSelected({ docId, pageId: entries[entries.length - 1].id })
  }, [])

  const insertPagesIntoDoc = useCallback((docId: string, index: number, entries: PageEntry[]) => {
    if (entries.length === 0) return
    setDocs((prev) => pageOps.insertPagesIntoDoc(prev, docId, index, entries))
    setSelected({ docId, pageId: entries[entries.length - 1].id })
  }, [])

  const movePageInto = useCallback((source: PageRef, targetDocId: string, index: number) => {
    setDocs((prev) => moveOps.movePageInto(prev, source, targetDocId, index))
    setSelected({ docId: targetDocId, pageId: source.pageId })
  }, [])

  const movePageToNewDoc = useCallback((source: PageRef, docIndex: number) => {
    const newDocId = crypto.randomUUID()
    setDocs((prev) => moveOps.movePageToNewDoc(prev, source, docIndex, newDocId))
    setSelected({ docId: newDocId, pageId: source.pageId })
  }, [])

  const spliceDocsAfter = useCallback((anchorDocId: string | null, newDocs: DocEntry[]) => {
    if (newDocs.length === 0) return
    setDocs((prev) => docOps.spliceDocsAfter(prev, anchorDocId, newDocs))
    const last = newDocs[newDocs.length - 1]
    setSelected({ docId: last.id, pageId: last.pages[last.pages.length - 1].id })
  }, [])

  return {
    docs,
    setDocs,
    docsRef,
    selected,
    setSelected,
    selectPage,
    clearSelection,
    removeDoc,
    renameDoc,
    moveDoc,
    deletePage,
    copySelected,
    pasteAfterSelected,
    insertPagesAfter,
    appendPagesToDoc,
    insertPagesIntoDoc,
    movePageInto,
    movePageToNewDoc,
    spliceDocsAfter
  }
}

export type Collection = ReturnType<typeof useCollection>
