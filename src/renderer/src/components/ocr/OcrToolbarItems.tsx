// The toolbar's OCR items (DESIGN.md §3.8 "Toolbar"): the Recognize Text glass button, shown only
// while scanned pages wait to be recognised, and the activity pill ("Recognizing text · 37%") that
// opens the job popover (per-document rows, Stop all). The pill is also the OCR live region: it
// announces progress every 10% or every 5 pages, and once more when the work ends (§3.8
// "Accessibility"). None of it touches the App busy flag.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useOcrStore, useOcrSummary } from '../../ocr/OcrContext'
import { batchToast, createAnnouncer, overallProgress, pagesWord } from '../../ocr/ocr-ui'
import { Popover } from './Popover'
import { ScanTextGlyph } from './OcrPageBadge'
import { OcrSummaryPopover } from './OcrSummaryPopover'

export const RECOGNIZE_TOOLTIP =
  'Make scanned pages searchable — runs on this computer, nothing is uploaded'

export function OcrToolbarItems({ busy }: { busy: boolean }): React.JSX.Element | null {
  const { store, actions } = useOcrStore()
  const { summary, snapshot, runs } = useOcrSummary()
  const pillRef = useRef<HTMLButtonElement | null>(null)
  const [jobsOpen, setJobsOpen] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)

  const progress = overallProgress(snapshot.batches)
  const crashed = snapshot.batches.some((b) => b.state === 'crashed')
  const running = snapshot.running
  const lastEnded = useMemo(
    () => [...snapshot.batches].reverse().find((b) => b.state !== 'running') ?? null,
    [snapshot.batches]
  )

  // Throttled announcements (one live region for the whole app; the chip and banner show the same
  // numbers visually).
  const announcer = useRef(createAnnouncer())
  const [said, setSaid] = useState('')
  useEffect(() => {
    const final = lastEnded ? (batchToast(lastEnded)?.message ?? null) : null
    const msg = announcer.current.next({
      running,
      done: progress.done,
      total: progress.total,
      final: running ? null : final
    })
    if (msg) setSaid(msg)
  }, [running, progress.done, progress.total, lastEnded])

  // The popover closes when there is nothing left to show in it.
  useEffect(() => {
    if (!running && !crashed) setJobsOpen(false)
  }, [running, crashed])

  if (!store) return null
  const showButton = summary.unrecognized.length > 0
  const showPill = running || crashed
  const pct = Math.round(progress.fraction * 100)
  const docRows = summary.docs.filter((d) => runs.has(d.docId) || d.held.length > 0)

  return (
    <>
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
              <span aria-hidden="true">Recognizing text · {pct}%</span>
              <span className="sr-only">Recognizing text, {pct} percent. Show details</span>
            </>
          ) : (
            <span>Text recognition stopped</span>
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
        >
          <ScanTextGlyph size={13} />
          Recognize Text
        </button>
      )}
    </>
  )
}
