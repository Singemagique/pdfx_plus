// The full-view banner (DESIGN.md §3.8 "Full-view banner"), in the full-view bar: on a scanned
// page whose text is not recognised, "This page is a scanned image. Recognize its text to search it
// and to make exported PDFs searchable. [Recognize 12 pages] [Just this page] [Not now]"; while the
// document's pages run, "Recognizing text… page 5 of 12 [Stop]". At most once per document per
// session: App remembers the documents it was shown for (`seen`, useBannerSeen), and marks one when
// it is answered, or when full view closes or moves to another document after showing it.
// It sits in the bar's own strip, never lower over the page: the top of the page stays readable
// and reachable by the edit tools while the question is open. Not a live region (the toolbar
// pill's throttled region announces progress).

import { useEffect, useRef } from 'react'
import { useOcrStore, useOcrSummary } from '../../ocr/OcrContext'
import { useFocusRescue } from './focus-rescue'

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
  const box = useRef<HTMLDivElement | null>(null)
  // [Recognize…] turns into [Stop]; [Stop] and [Not now] take the banner away: focus goes to what
  // replaced the button, else to the full-view scroller (where the page keys work).
  useFocusRescue(
    box,
    () =>
      box.current?.querySelector<HTMLElement>('button') ??
      document.querySelector<HTMLElement>('.full-view .full-scroll')
  )
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
      <div ref={box} className="ocr-banner running">
        <span className="ocr-banner-text" aria-hidden="true">
          Recognizing text… page {Math.min(run.done + 1, run.total)} of {run.total}
        </span>
        <span className="sr-only">Recognizing text in this document</span>
        <span className="ocr-banner-actions">
          <button
            className="btn glass"
            onClick={() => {
              store.cancel()
              onDone(docId)
            }}
          >
            Stop
          </button>
        </span>
      </div>
    )
  }
  const n = doc.unrecognized.length
  const copy = `${BANNER_COPY.title} ${BANNER_COPY.body}`
  return (
    <div ref={box} className="ocr-banner">
      {/* One line in the bar; the full sentence stays in the DOM (and its tooltip) when the
          window is too narrow to show it all. */}
      <span className="ocr-banner-text" title={copy}>
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
