// The DocHeader chip (DESIGN.md §3.8 "DocHeader chip"), per document:
// "Scanned · Recognize text" (one click, remembered settings) → "Recognizing 4 / 12 ✕" with a thin
// bar (✕ stops) → "3 pages need attention" (opens the summary). Gone when everything is fine.

import { useRef, useState } from 'react'
import { useOcrStore, useOcrSummary } from '../../ocr/OcrContext'
import { pagesWord } from '../../ocr/ocr-ui'
import { CloseIcon } from '../icons'
import { OcrSummaryPopover } from './OcrSummaryPopover'

export function OcrDocChip({ docId }: { docId: string }): React.JSX.Element | null {
  const { store, actions } = useOcrStore()
  const { summary, runs } = useOcrSummary()
  const ref = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const doc = summary.byDoc.get(docId)
  if (!store || !doc) return null
  const run = runs.get(docId)
  const stop = (e: React.MouseEvent): void => {
    e.stopPropagation()
    store.cancel()
  }

  let chip: React.JSX.Element | null = null
  if (run) {
    const pct = run.total > 0 ? Math.round((run.done / run.total) * 100) : 0
    chip = (
      <span className="ocr-chip running" role="status">
        <span aria-hidden="true">
          Recognizing {run.done} / {run.total}
        </span>
        <span className="sr-only">Recognizing text in this document</span>
        <button className="ocr-chip-x" aria-label="Stop recognizing text" onClick={stop}>
          <CloseIcon size={11} />
        </button>
        <span className="ocr-chip-bar" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </span>
      </span>
    )
  } else if (doc.held.length > 0) {
    chip = (
      <span className="ocr-chip" role="status">
        Text recognition stopped
        <button
          className="ocr-chip-link"
          onClick={(e) => {
            e.stopPropagation()
            store.resume()
          }}
        >
          Resume
        </button>
      </span>
    )
  } else if (doc.unrecognized.length > 0) {
    chip = (
      <button
        className="ocr-chip action"
        onClick={(e) => {
          e.stopPropagation()
          actions.recognizeNow(doc.unrecognized)
        }}
        title={`Recognize the text of ${pagesWord(doc.unrecognized.length)} — runs on this computer`}
      >
        Scanned · Recognize text
      </button>
    )
  } else if (doc.attention > 0) {
    chip = (
      <button
        ref={ref}
        className="ocr-chip attention"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        {pagesWord(doc.attention)} need{doc.attention === 1 ? 's' : ''} attention
      </button>
    )
  }
  return (
    <>
      {chip}
      {open && doc.attention > 0 && (
        <OcrSummaryPopover anchor={ref.current} docId={docId} onClose={() => setOpen(false)} />
      )}
    </>
  )
}
