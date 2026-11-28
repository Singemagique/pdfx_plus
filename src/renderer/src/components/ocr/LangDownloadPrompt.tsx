// The consent and progress for one language download (DESIGN.md §3.2.5 "Consent wording",
// "Offline wording"; §3.8 "Language picker", the summary's "Needs Russian language data
// [Download]"). Nothing is requested until the user presses Download here: this is the only caller
// of `LangPacksStore.download`. Used inline by the picker and by a summary row.

import { useEffect, useRef, useState } from 'react'
import type { LangDownloadError, LangPackInfo } from '../../../../shared/ocr/lang-packs'
import { useLangPacks } from '../../ocr/OcrContext'
import { consentCopy, downloadErrorCopy, offlineCopy } from '../../ocr/ocr-ui'

interface Props {
  info: LangPackInfo
  /** The language is installed (downloaded now, or already there). */
  onInstalled: (code: string) => void
  onCancel: () => void
  /** Focus the prompt's first button when it appears (the picker; a popover row does too). */
  autoFocus?: boolean
}

const online = (): boolean =>
  typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean' || navigator.onLine

export function LangDownloadPrompt({
  info,
  onInstalled,
  onCancel,
  autoFocus = true
}: Props): React.JSX.Element {
  const { langs, snapshot } = useLangPacks()
  const [error, setError] = useState<LangDownloadError | null>(null)
  const [running, setRunning] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)
  const progress = snapshot.progress.get(info.code)
  const busy = running || !!progress || info.state === 'downloading'

  useEffect(() => {
    if (autoFocus) box.current?.querySelector<HTMLElement>('button')?.focus()
    // Once, on appearing; later states move focus themselves below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Installed meanwhile (a download started from elsewhere, an Install from file…): done.
  useEffect(() => {
    if (info.state === 'installed' && !running) onInstalled(info.code)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.state])

  const start = async (): Promise<void> => {
    if (!langs || busy) return
    setError(null)
    setRunning(true)
    const r = await langs.download(info.code)
    setRunning(false)
    if (r.ok) onInstalled(info.code)
    else if (r.error !== 'cancelled') setError(r.error)
    // The buttons changed under the focus: keep it in the prompt.
    queueMicrotask(() => box.current?.querySelector<HTMLElement>('button')?.focus())
  }

  const pct =
    progress && progress.total > 0 ? Math.floor((100 * progress.received) / progress.total) : 0
  let body: React.JSX.Element
  if (busy)
    body = (
      <>
        <p className="ocr-lang-prompt-text" role="status" aria-live="polite">
          Downloading {info.name} language data… {pct}%
        </p>
        <div
          className="ocr-lang-progress"
          role="progressbar"
          aria-label={`Downloading ${info.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div style={{ width: `${pct}%` }} />
        </div>
        <div className="ocr-lang-prompt-actions">
          <button className="btn glass" onClick={() => langs?.cancel(info.code)}>
            Stop
          </button>
        </div>
      </>
    )
  else if (error)
    body = (
      <>
        <p className="ocr-lang-prompt-text" role="alert">
          {downloadErrorCopy(error, info.name)}
        </p>
        <div className="ocr-lang-prompt-actions">
          <button className="btn glass" onClick={onCancel}>
            Cancel
          </button>
          {error !== 'proxy-auth' && (
            <button className="btn glass primary" onClick={() => void start()}>
              Try again
            </button>
          )}
        </div>
      </>
    )
  else if (!online())
    body = (
      <>
        <p className="ocr-lang-prompt-text">{offlineCopy(info.name)}</p>
        <div className="ocr-lang-prompt-actions">
          <button className="btn glass" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn glass" onClick={() => void start()}>
            Try anyway
          </button>
        </div>
      </>
    )
  else
    body = (
      <>
        <p className="ocr-lang-prompt-text">{consentCopy(info)}</p>
        <div className="ocr-lang-prompt-actions">
          <button className="btn glass" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn glass primary" onClick={() => void start()}>
            Download
          </button>
        </div>
      </>
    )
  return (
    <div ref={box} className="ocr-lang-prompt" role="group" aria-label={`Download ${info.name}`}>
      {body}
    </div>
  )
}
