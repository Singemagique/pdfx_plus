// The toolbar's OCR items (DESIGN.md §3.8 "Toolbar"): the Recognize Text glass button, shown only
// while scanned pages wait to be recognised, and the activity pill ("Recognizing text · 37%") that
// opens the job popover (per-document rows, Stop all). The pill is also the OCR live region: it
// announces progress every 10% or every 5 pages (§3.8 "Accessibility"); how a run ended is the
// toast's to say (App's toast region), never twice. None of it touches the App busy flag.
//
// Width: the toolbar is already full at the window's minimum width (720 px), so the two never show
// together (the job popover offers "Recognize Text…" while the pill is up), and below 1000 px both
// fold to their short forms (styles.css).

import { useEffect, useRef, useState } from 'react'
import { useOcrStore, useOcrSummary } from '../../ocr/OcrContext'
import { createAnnouncer, overallProgress, pagesWord } from '../../ocr/ocr-ui'
import { Popover } from './Popover'
import { ScanTextGlyph } from './OcrPageBadge'
import { OcrSummaryPopover } from './OcrSummaryPopover'
import { useFocusRescue } from './focus-rescue'

export const RECOGNIZE_TOOLTIP =
  'Make scanned pages searchable — runs on this computer, nothing is uploaded'

export function OcrToolbarItems({ busy }: { busy: boolean }): React.JSX.Element | null {
  const { store, actions } = useOcrStore()
  const { summary, snapshot, runs } = useOcrSummary()
  const pillRef = useRef<HTMLButtonElement | null>(null)
  const region = useRef<HTMLSpanElement | null>(null)
  const [jobsOpen, setJobsOpen] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)

  const progress = overallProgress(snapshot.batches)
  const crashed = snapshot.batches.some((b) => b.state === 'crashed')
  const running = snapshot.running

  // Throttled announcements (the one OCR progress region; the chip and banner show the same numbers
  // visually and are not live regions).
  const announcer = useRef(createAnnouncer())
  const [said, setSaid] = useState('')
  useEffect(() => {
    const msg = announcer.current.next({ running, done: progress.done, total: progress.total })
    if (msg !== null) setSaid(msg)
  }, [running, progress.done, progress.total])

  // The popover closes when there is nothing left to show in it.
  useEffect(() => {
    if (!running && !crashed) setJobsOpen(false)
  }, [running, crashed])

  // The button turns into the pill (and the pill goes when the work ends): focus follows, to the
  // pill, else to the next toolbar button.
  useFocusRescue(
    region,
    () =>
      pillRef.current ??
      region.current?.parentElement?.querySelector<HTMLElement>('.btn:not(:disabled)')
  )

  if (!store) return null
  const showPill = running || crashed
  const waiting = summary.unrecognized.length > 0
  const showButton = waiting && !showPill
  const pct = Math.round(progress.fraction * 100)
  const docRows = summary.docs.filter((d) => runs.has(d.docId) || d.held.length > 0)

  return (
    <span ref={region} className="ocr-toolbar-items">
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {said}
      </span>
      {showPill && (
        <button
          ref={pillRef}
          className={`ocr-pill${crashed && !running ? ' stopped' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={jobsOpen}
          onClick={() => setJobsOpen((o) => !o)}
          title="Text recognition"
        >
          {running ? (
            <>
              <span className="ocr-pill-bar" aria-hidden="true">
                <span style={{ width: `${pct}%` }} />
              </span>
              <span aria-hidden="true">
                <span className="ocr-pill-long">Recognizing text · </span>
                {pct}%
              </span>
              <span className="sr-only">Recognizing text, {pct} percent. Show details</span>
            </>
          ) : (
            <span>
              <span className="ocr-pill-long">Text recognition stopped</span>
              {/* Shown instead of the long label in a narrow window (one of the two is display:
                  none, so a screen reader reads one). */}
              <span className="ocr-pill-short">Stopped</span>
            </span>
          )}
        </button>
      )}
      {jobsOpen && (
        <Popover
          anchor={pillRef.current}
          label="Text recognition jobs"
          onClose={() => setJobsOpen(false)}
          className="ocr-jobs"
        >
          <h3 className="ocr-popover-title">Text recognition</h3>
          <ul className="ocr-jobs-list">
            {docRows.map((d) => {
              const r = runs.get(d.docId)
              return (
                <li key={d.docId} className="ocr-jobs-row">
                  <span className="ocr-jobs-name" title={d.name}>
                    {d.name}
                  </span>
                  <span className="ocr-jobs-count">
                    {r ? `${r.done} / ${r.total}` : `${pagesWord(d.held.length)} paused`}
                  </span>
                </li>
              )
            })}
          </ul>
          {summary.attention > 0 && (
            <button
              className="sign-link"
              onClick={() => {
                setJobsOpen(false)
                setSummaryOpen(true)
              }}
            >
              {pagesWord(summary.attention)} need{summary.attention === 1 ? 's' : ''} attention
            </button>
          )}
          {waiting && (
            // The toolbar button's action while the pill stands in for it.
            <button
              className="sign-link"
              disabled={busy}
              onClick={() => {
                setJobsOpen(false)
                actions.openDialog()
              }}
            >
              Recognize Text…
            </button>
          )}
          <div className="sign-actions">
            {crashed && (
              <button className="btn glass" onClick={() => store.resume()}>
                Resume
              </button>
            )}
            {running && (
              <button className="btn glass" onClick={() => store.cancel()}>
                Stop all
              </button>
            )}
          </div>
        </Popover>
      )}
      {summaryOpen && (
        <OcrSummaryPopover
          anchor={pillRef.current}
          docId={null}
          onClose={() => setSummaryOpen(false)}
        />
      )}
      {showButton && (
        <button
          className="btn glass ocr-recognize-btn"
          onClick={() => actions.openDialog()}
          disabled={busy}
          title={RECOGNIZE_TOOLTIP}
          aria-label="Recognize Text"
        >
          <ScanTextGlyph size={13} />
          <span className="ocr-btn-label">Recognize Text</span>
        </button>
      )}
    </span>
  )
}
