// The full-view banner (DESIGN.md §3.8 "Full-view banner"), under the full-view bar: on a scanned
// page whose text is not recognised, "This page is a scanned image. Recognize its text to search it
// and to make exported PDFs searchable. [Recognize 12 pages] [Just this page] [Not now]"; while the
// document's pages run, "Recognizing text… page 5 of 12 [Stop]". At most once per document per
// session: App remembers the documents it was shown for (`seen`), and marks one when it is
// answered, or when full view closes or moves to another document after showing it.

import { useEffect } from 'react'
import { useOcrStore, useOcrSummary } from '../../ocr/OcrContext'

export const BANNER_COPY = {
  title: 'This page is a scanned image.',
  body: 'Recognize its text to search it and to make exported PDFs searchable.'
} as const

interface Props {
  docId: string
  pageKey: string | null
  /** Documents the banner was already shown for this session. */
  seen: ReadonlySet<string>
  /** The banner showed for `docId` (it is marked seen when full view leaves it). */
  onShown: (docId: string) => void
  /** Answered: never again for this document this session. */
  onDone: (docId: string) => void
}

export function OcrBanner({
  docId,
  pageKey,
  seen,
  onShown,
  onDone
}: Props): React.JSX.Element | null {
  const { store, actions } = useOcrStore()
  const { summary, runs } = useOcrSummary()
  const doc = summary.byDoc.get(docId)
  const run = runs.get(docId)
  const here = pageKey ? summary.byKey.get(pageKey) : undefined
  const offer =
    !seen.has(docId) && !!doc && !!pageKey && !!here && doc.unrecognized.includes(pageKey)
  const showing = offer || (!!run && !seen.has(docId))
  useEffect(() => {
    if (offer) onShown(docId)
  }, [offer, docId, onShown])
  if (!store || !doc || !showing) return null

  if (run) {
    return (
      <div className="ocr-banner" role="status">
        <span aria-hidden="true">
          Recognizing text… page {Math.min(run.done + 1, run.total)} of {run.total}
        </span>
        <span className="sr-only">Recognizing text in this document</span>
        <button
          className="btn glass"
          onClick={() => {
            store.cancel()
            onDone(docId)
          }}
        >
          Stop
        </button>
      </div>
    )
  }
  const n = doc.unrecognized.length
  return (
    <div className="ocr-banner" role="status">
      <span>
        <strong>{BANNER_COPY.title}</strong> {BANNER_COPY.body}
      </span>
      <span className="ocr-banner-actions">
        {n > 1 && (
          <button
            className="btn glass primary"
            onClick={() => actions.recognizeNow(doc.unrecognized)}
          >
            Recognize {n} pages
          </button>
        )}
        <button
          className={`btn glass${n > 1 ? '' : ' primary'}`}
          onClick={() => pageKey && actions.recognizeNow([pageKey])}
        >
          {n > 1 ? 'Just this page' : 'Recognize this page'}
        </button>
        <button className="btn glass" onClick={() => onDone(docId)}>
          Not now
        </button>
      </span>
    </div>
  )
}
