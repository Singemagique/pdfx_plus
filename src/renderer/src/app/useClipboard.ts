import { useCallback, useRef } from 'react'
import { freshPageCopy, insertPastedPage } from './doc-ops/pages'
import type { PageRef } from './types'
import type { DocEntry, PageEntry } from '../types'

export function useClipboard(
  docs: DocEntry[],
  selected: PageRef | null,
  setDocs: React.Dispatch<React.SetStateAction<DocEntry[]>>,
  setSelected: (sel: PageRef | null) => void,
  flash: (message: string) => void
) {
  const clipboardRef = useRef<PageEntry | null>(null)

  const copySelected = useCallback(() => {
    if (!selected) return
    const page = docs
      .find((d) => d.id === selected.docId)
      ?.pages.find((p) => p.id === selected.pageId)
    if (!page) return
    clipboardRef.current = page
    void window.api.clearClipboard()
    flash('Page copied — ⌘V pastes it after the selected page')
  }, [docs, selected, flash])

  const pasteAfterSelected = useCallback(() => {
    const clip = clipboardRef.current
    if (!clip || !selected) return
    // freshPageCopy gives the paste an independent pageKey — otherwise it shares the original's key
    // and edits/rotations/redactions apply to both (see freshPageCopy). Matches duplicatePage.
    const pasted = freshPageCopy(clip)
    setDocs((prev) => insertPastedPage(prev, selected, pasted))
    setSelected({ docId: selected.docId, pageId: pasted.id })
  }, [selected, setDocs, setSelected])

  return { copySelected, pasteAfterSelected }
}
