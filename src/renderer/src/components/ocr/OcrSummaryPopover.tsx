// The summary popover (DESIGN.md §3.8 "Summary popover"): one row per page with an issue, for one
// document (the DocHeader chip) or every document (the job popover, a toast's [Details]). Rows act
// in place: [View] opens the page, [Replace…] the dialog for it, [Rotate] the existing undoable
// rotate by the turn recognition measured, [Try again] asks for the page again.

import { useOcrStore, useOcrSummary } from '../../ocr/OcrContext'
import type { OcrPageView } from '../../ocr/ocr-ui'
import { Popover } from './Popover'

export const SUMMARY_FOOTER = 'Recognized with the built-in engine (Tesseract)'

interface Props {
  anchor: HTMLElement | null
  /** One document, or null for all of them. */
  docId: string | null
  onClose: () => void
}

export function OcrSummaryPopover({ anchor, docId, onClose }: Props): React.JSX.Element {
  const { store, actions } = useOcrStore()
  const { summary } = useOcrSummary()
  const docs = docId ? summary.docs.filter((d) => d.docId === docId) : summary.docs
  const groups = docs.filter((d) => d.issues.length > 0)
  const many = !docId && groups.length > 1
  const row = (p: OcrPageView): React.JSX.Element => {
    const issue = p.issue!
    return (
      <li key={`${p.docId}|${p.key}`} className="ocr-summary-row">
        <span className="ocr-summary-page">Page {p.number}</span>
        <span className="ocr-summary-text">{issue.text}</span>
        <span className="ocr-summary-actions">
          {issue.kind === 'low-confidence' && (
            <>
              <button
                className="sign-link"
                onClick={() => {
                  onClose()
                  actions.viewPage(p.docId, p.pageId)
                }}
              >
                View
              </button>
              <button
                className="sign-link"
                onClick={() => {
                  onClose()
                  actions.openDialog({ mode: 'replace', keys: [p.key] })
                }}
              >
                Replace…
              </button>
            </>
          )}
          {issue.kind === 'sideways' && p.state.rotateBy && (
            <button
              className="sign-link"
              onClick={() => actions.rotatePage(p.key, p.state.rotateBy!)}
            >
              Rotate
            </button>
          )}
          {issue.retry && (
            <button className="sign-link" onClick={() => store?.recognize([p.key])}>
              Try again
            </button>
          )}
        </span>
      </li>
    )
  }
  return (
    <Popover
      anchor={anchor}
      label="Text recognition details"
      onClose={onClose}
      className="ocr-summary"
    >
      {groups.length === 0 ? (
        <p className="ocr-summary-empty">Every page is fine.</p>
      ) : (
        groups.map((d) => (
          <section key={d.docId}>
            {many && <h3 className="ocr-summary-doc">{d.name}</h3>}
            <ul className="ocr-summary-list">{d.issues.map(row)}</ul>
          </section>
        ))
      )}
      <p className="ocr-summary-footer">{SUMMARY_FOOTER}</p>
    </Popover>
  )
}
