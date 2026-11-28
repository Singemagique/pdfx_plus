// The summary popover (DESIGN.md §3.8 "Summary popover"): one row per page with an issue, for one
// document (the DocHeader chip) or every document (the job popover, a toast's [Details]). Rows act
// in place: [View] opens the page, [Replace…] the dialog for it, [Rotate] the existing undoable
// rotate by the turn recognition measured, [Try again] asks for the page again. "Needs Russian
// language data [Download]" (PR9) asks for consent in the row; once the language is installed the
// pages that needed it are recognised again with the languages they asked for.

import { useState } from 'react'
import { useLangPacks, useOcrStore, useOcrSummary } from '../../ocr/OcrContext'
import { missingLangs, needsLanguageCopy, type OcrPageView } from '../../ocr/ocr-ui'
import { LangDownloadPrompt } from './LangDownloadPrompt'
import { Popover } from './Popover'

export const SUMMARY_FOOTER = 'Recognized with the built-in engine (Tesseract)'

interface Props {
  anchor: HTMLElement | null
  /** One document, or null for all of them. */
  docId: string | null
  onClose: () => void
}

export function OcrSummaryPopover({ anchor, docId, onClose }: Props): React.JSX.Element {
  const { actions, store } = useOcrStore()
  const { summary } = useOcrSummary()
  const { langs: packs, snapshot: packSnap } = useLangPacks()
  const installed = packs?.installed() ?? new Set<string>()
  /** The row whose [Download] consent is open: its key and the language. */
  const [asking, setAsking] = useState<{ key: string; code: string } | null>(null)
  /** Recognise again every page that needed exactly these languages. */
  const retryNeeding = (langs: readonly string[]): void => {
    const want = langs.join('+')
    const keys = summary.issues
      .filter((v) => v.issue?.kind === 'needs-language' && (v.state.langs ?? []).join('+') === want)
      .map((v) => v.key)
    if (keys.length > 0) store?.recognize([...new Set(keys)], { langs: [...langs] })
  }
  const docs = docId ? summary.docs.filter((d) => d.docId === docId) : summary.docs
  const groups = docs.filter((d) => d.issues.length > 0)
  const many = !docId && groups.length > 1
  const row = (p: OcrPageView): React.JSX.Element => {
    const issue = p.issue!
    const needs = issue.kind === 'needs-language'
    const missing = needs ? missingLangs(p.state.langs, installed) : []
    const first = missing.length > 0 ? packSnap.list.find((l) => l.code === missing[0]) : undefined
    const rowKey = `${p.docId}|${p.key}`
    const prompt =
      asking && asking.key === rowKey
        ? packSnap.list.find((l) => l.code === asking.code)
        : undefined
    return (
      <li key={rowKey} className="ocr-summary-row">
        <span className="ocr-summary-page">Page {p.number}</span>
        <span className="ocr-summary-text">{needs ? needsLanguageCopy(missing) : issue.text}</span>
        <span className="ocr-summary-actions">
          {needs && first && !prompt && (
            <button
              className="sign-link"
              onClick={() => setAsking({ key: rowKey, code: first.code })}
            >
              Download
            </button>
          )}
          {needs && missing.length === 0 && p.state.langs && p.state.langs.length > 0 && (
            // Everything it asked for is installed now (a download elsewhere, Install from file…).
            <button className="sign-link" onClick={() => retryNeeding(p.state.langs!)}>
              Try again
            </button>
          )}
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
            // The one-click path: says "couldn't start" when OCR is unavailable, like the others.
            <button className="sign-link" onClick={() => actions.recognizeNow([p.key])}>
              Try again
            </button>
          )}
        </span>
        {prompt && (
          <div className="ocr-summary-prompt">
            <LangDownloadPrompt
              info={prompt}
              onCancel={() => setAsking(null)}
              onInstalled={(code) => {
                const rest = missingLangs(p.state.langs, new Set([...installed, code]))
                const next =
                  rest.length > 0 ? packSnap.list.find((l) => l.code === rest[0]) : undefined
                if (next) setAsking({ key: rowKey, code: next.code })
                else {
                  setAsking(null)
                  if (p.state.langs) retryNeeding(p.state.langs)
                }
              }}
            />
          </div>
        )}
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
