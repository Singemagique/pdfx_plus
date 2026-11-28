// The export mid-job prompt (DESIGN.md §3.8 "Export mid-job"), asked by the OCR store's
// `flushOrConfirm` BEFORE the save dialog (§3.7.1):
// - "Text recognition is still running (5 of 12 pages)…" [Wait and export] [Export now] [Cancel]:
//   a small modal in the Sign dialog's style, with a focus trap and Esc = Cancel;
// - while waiting: a NON-modal status card (role="status"), so the toolbar and the editor stay
//   usable and the App busy overlay is never raised; [Export now] [Cancel] stay offered;
// - "Text recognition stopped (7 of 12 pages done)…" when it ends early while waiting;
// - "…recognized text isn't available…" for a Replace whose result is missing.

import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { OcrPrompt, OcrPromptAnswer, OcrStore } from '../ocr/ocr-store'

const pages = (n: number): string => `${n} page${n === 1 ? '' : 's'}`

function formatEta(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return ''
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? ` · about ${s} s left` : ` · about ${Math.round(s / 60)} min left`
}

interface ModalProps {
  title: string
  text: string
  buttons: Array<{ label: string; answer: OcrPromptAnswer; primary?: boolean }>
  onAnswer: (a: OcrPromptAnswer) => void
}

/** The modal: focus on the primary button, Tab cycles inside, Esc cancels. */
function Modal({ title, text, buttons, onAnswer }: ModalProps): React.JSX.Element {
  const box = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    box.current?.querySelector<HTMLButtonElement>('button.primary')?.focus()
    return () => previous?.focus?.()
  }, [])
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onAnswer('cancel')
      return
    }
    if (e.key !== 'Tab' || !box.current) return
    const focusable = [...box.current.querySelectorAll<HTMLButtonElement>('button')]
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }
  return (
    <div className="sign-overlay" onPointerDown={() => onAnswer('cancel')}>
      <div
        ref={box}
        className="sign-dialog ocr-export-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ocr-export-prompt-title"
        aria-describedby="ocr-export-prompt-text"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 id="ocr-export-prompt-title">{title}</h2>
        <p id="ocr-export-prompt-text" className="sign-hint">
          {text}
        </p>
        <div className="sign-actions">
          {buttons.map((b) => (
            <button
              key={b.answer}
              className={`btn glass${b.primary ? ' primary' : ''}`}
              onClick={() => onAnswer(b.answer)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function view(p: OcrPrompt, onAnswer: (a: OcrPromptAnswer) => void): React.JSX.Element {
  if (p.kind === 'waiting')
    return (
      <div className="ocr-export-waiting" role="status" aria-live="polite">
        <span>
          Waiting for text recognition before exporting ({p.done} of {pages(p.total)})
          {formatEta(p.etaMs)}
        </span>
        <button className="btn glass" onClick={() => onAnswer('now')}>
          Export now
        </button>
        <button className="btn glass" onClick={() => onAnswer('cancel')}>
          Cancel
        </button>
      </div>
    )
  if (p.kind === 'running')
    return (
      <Modal
        title="Text recognition is running"
        text={`Text recognition is still running (${p.done} of ${pages(p.total)}). Export now without the remaining pages, or wait?`}
        buttons={[
          { label: 'Cancel', answer: 'cancel' },
          { label: 'Export now', answer: 'now' },
          { label: 'Wait and export', answer: 'wait', primary: true }
        ]}
        onAnswer={onAnswer}
      />
    )
  if (p.kind === 'stopped')
    return (
      <Modal
        title="Text recognition stopped"
        text={`Text recognition stopped before it finished (${p.done} of ${pages(p.total)} done). Export now without the remaining pages?`}
        buttons={[
          { label: 'Cancel', answer: 'cancel' },
          { label: 'Export now', answer: 'now', primary: true }
        ]}
        onAnswer={onAnswer}
      />
    )
  return (
    <Modal
      title="Recognized text not available"
      text={`The replacement recognized text for ${pages(p.pages)} isn't available (its recognition didn't finish). ${p.pages === 1 ? 'That page' : 'Those pages'} will be exported without recognized text.`}
      buttons={[
        { label: 'Cancel', answer: 'cancel' },
        { label: 'Export anyway', answer: 'now', primary: true }
      ]}
      onAnswer={onAnswer}
    />
  )
}

/** Renders whatever the store is asking; nothing otherwise. */
export function OcrExportPrompt({ store }: { store: OcrStore }): React.JSX.Element | null {
  const p = useSyncExternalStore(store.subscribe, store.getPrompt)
  if (!p) return null
  return view(p, store.answerPrompt)
}
