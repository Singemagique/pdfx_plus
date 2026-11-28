// The consent and progress for one language download (DESIGN.md §3.2.5 "Consent wording",
// "Offline wording"; §3.8 "Language picker", the summary's "Needs Russian language data
// [Download]"). Nothing is requested until the user presses Download here: this is the only caller
// of `LangPacksStore.download`. Used inline by the picker and by a summary row.
//
// A download never runs out of sight: while it runs, Esc stops it (and goes no further), and a
// prompt that goes away with its download still running (the dialog or popover closed) stops it.
// When the download can't be made from here (offline, a proxy sign-in, a timeout, a server error)
// the prompt names the file and its address, with Copy link and Install from file… in place.

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  langFileName,
  type LangDownloadError,
  type LangPackInfo
} from '../../../../shared/ocr/lang-packs'
import { useLangPacks } from '../../ocr/OcrContext'
import {
  MANUAL_ROUTE_ERRORS,
  consentCopy,
  downloadErrorCopy,
  installErrorCopy,
  langName,
  manualCopy,
  offlineCopy
} from '../../ocr/ocr-ui'

interface Props {
  info: LangPackInfo
  /** The language is installed (downloaded now, or already there). */
  onInstalled: (code: string) => void
  onCancel: () => void
  /** Focus the prompt's first button when it appears (the picker; a popover row does too). */
  autoFocus?: boolean
}

const subscribeOnline = (cb: () => void): (() => void) => {
  window.addEventListener('online', cb)
  window.addEventListener('offline', cb)
  return () => {
    window.removeEventListener('online', cb)
    window.removeEventListener('offline', cb)
  }
}
const onlineNow = (): boolean =>
  typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean' || navigator.onLine

/** navigator.onLine, re-read when the window hears the connection drop or come back. */
function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, onlineNow, () => true)
}

export function LangDownloadPrompt({
  info,
  onInstalled,
  onCancel,
  autoFocus = true
}: Props): React.JSX.Element {
  const { langs, snapshot } = useLangPacks()
  const online = useOnline()
  const [error, setError] = useState<LangDownloadError | null>(null)
  const [running, setRunning] = useState(false)
  /** What Copy link / Install from file… said. */
  const [note, setNote] = useState<string | null>(null)
  const box = useRef<HTMLDivElement | null>(null)
  /** This prompt's own download is running (stopped if the prompt goes away). */
  const mine = useRef(false)
  const progress = snapshot.progress.get(info.code)
  const busy = running || !!progress || info.state === 'downloading'
  const latest = useRef({ langs, code: info.code })
  latest.current = { langs, code: info.code }
  /** Report a language installed once, however it got there (download, file, elsewhere). */
  const reported = useRef<string | null>(null)
  const installed = (code: string): void => {
    if (reported.current === code) return
    reported.current = code
    onInstalled(code)
  }

  // Gone with the download still running (the dialog or popover closed, Esc on the dialog): stop
  // it, so nothing downloads that the app no longer shows.
  useEffect(
    () => () => {
      if (mine.current) latest.current.langs?.cancel(latest.current.code)
    },
    []
  )

  // Installed meanwhile (a download started from elsewhere, an Install from file…): done.
  useEffect(() => {
    if (info.state === 'installed' && !running) installed(info.code)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.state])

  const manual = !busy && (error ? MANUAL_ROUTE_ERRORS.has(error) : !online)
  const phase = busy ? 'busy' : error ? `error:${error}` : online ? 'consent' : 'offline'
  // Focus follows the prompt's state: the buttons are replaced under it (Download → Stop → Try
  // again), and a focused button that goes leaves focus on <body>. After the commit, never before.
  const firstPhase = useRef(true)
  useLayoutEffect(() => {
    const b = box.current
    if (!b) return
    const initial = firstPhase.current
    firstPhase.current = false
    if (initial && !autoFocus) return
    const active = document.activeElement
    const lost = !active || active === document.body || b.contains(active)
    if (!initial && !lost)
      return // Busy: Stop. Ended: Try again / Download; a proxy sign-in (no retry): Install from file….
    ;(
      b.querySelector<HTMLElement>('.ocr-lang-prompt-actions .primary') ??
      (phase === 'error:proxy-auth' ? b.querySelector<HTMLElement>('.ocr-lang-install') : null) ??
      b.querySelector<HTMLElement>('.ocr-lang-prompt-actions button') ??
      b.querySelector<HTMLElement>('button')
    )?.focus()
  }, [phase, autoFocus])

  const start = async (): Promise<void> => {
    if (!langs || busy) return
    setError(null)
    setNote(null)
    setRunning(true)
    mine.current = true
    const r = await langs.download(info.code)
    mine.current = false
    setRunning(false)
    if (r.ok) installed(info.code)
    else if (r.error !== 'cancelled') setError(r.error)
  }
  const stop = (): void => langs?.cancel(info.code)

  const copyLink = async (): Promise<void> => {
    if (!langs) return
    setNote((await langs.copyText(info.url)) ? 'Link copied.' : 'PDFx couldn’t copy the link.')
  }
  const installFromFile = async (): Promise<void> => {
    if (!langs) return
    setNote(null)
    const r = await langs.installFromFile()
    if (r.ok && r.code === info.code) installed(info.code)
    else if (r.ok)
      setNote(
        `That file is ${langName(r.code)} language data; it’s installed. ${info.name} needs ${langFileName(info.code)}.`
      )
    else setNote(installErrorCopy(r, info))
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // Esc while downloading is Stop, and only Stop: the prompt stays, showing what happened.
    if (e.key === 'Escape' && busy) {
      e.preventDefault()
      e.stopPropagation()
      stop()
    }
  }

  const pct =
    progress && progress.total > 0 ? Math.floor((100 * progress.received) / progress.total) : 0
  const cancelButton = (
    <button className="btn glass" onClick={onCancel}>
      Cancel
    </button>
  )
  let text: React.JSX.Element
  let actions: React.JSX.Element
  if (busy) {
    text = (
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
      </>
    )
    actions = (
      <button className="btn glass" onClick={stop}>
        Stop
      </button>
    )
  } else if (error) {
    text = (
      <p className="ocr-lang-prompt-text" role="alert">
        {downloadErrorCopy(error, info)}
      </p>
    )
    actions = (
      <>
        {cancelButton}
        {error !== 'proxy-auth' && (
          <button className="btn glass primary" onClick={() => void start()}>
            Try again
          </button>
        )}
      </>
    )
  } else if (!online) {
    text = <p className="ocr-lang-prompt-text">{offlineCopy(info.name)}</p>
    actions = (
      <>
        {cancelButton}
        <button className="btn glass" onClick={() => void start()}>
          Try anyway
        </button>
      </>
    )
  } else {
    text = <p className="ocr-lang-prompt-text">{consentCopy(info)}</p>
    actions = (
      <>
        {cancelButton}
        <button className="btn glass primary" onClick={() => void start()}>
          Download
        </button>
      </>
    )
  }
  return (
    <div
      ref={box}
      className="ocr-lang-prompt"
      role="group"
      aria-label={`Download ${info.name}`}
      onKeyDown={onKeyDown}
    >
      {text}
      {manual && (
        <div className="ocr-lang-manual">
          {error !== 'proxy-auth' && <p className="ocr-lang-prompt-text">{manualCopy(info)}</p>}
          <code className="ocr-lang-url" aria-label={`Address of ${langFileName(info.code)}`}>
            {info.url}
          </code>
          <div className="ocr-lang-manual-actions">
            <button className="sign-link" onClick={() => void copyLink()}>
              Copy link
            </button>
            <button className="sign-link ocr-lang-install" onClick={() => void installFromFile()}>
              Install from file…
            </button>
          </div>
          {note && (
            <p className="sign-module-hint" role="status">
              {note}
            </p>
          )}
        </div>
      )}
      <div className="ocr-lang-prompt-actions">{actions}</div>
    </div>
  )
}
