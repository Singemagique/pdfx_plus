// The Find bar's second row (DESIGN.md §3.8 "Find bar"): "7 scanned pages weren't searched.
// [Recognize text]" (one click, remembered settings), and the count's "No results · 7 scanned
// pages not searched". Nothing without unrecognised scans.

import { useOcrStore, useOcrSummary } from '../../ocr/OcrContext'
import { pagesWord } from '../../ocr/ocr-ui'

/** Scanned pages Find could not search (no recognised text yet, not being recognised). */
export function useUnsearchedScans(): number {
  const { store } = useOcrStore()
  const { summary } = useOcrSummary()
  return store ? summary.unrecognized.length : 0
}

export const unsearchedSuffix = (n: number): string =>
  n > 0 ? ` · ${n} scanned ${n === 1 ? 'page' : 'pages'} not searched` : ''

export function OcrFindRow(): React.JSX.Element | null {
  const { actions } = useOcrStore()
  const { summary } = useOcrSummary()
  const n = useUnsearchedScans()
  if (n === 0) return null
  return (
    <div className="findbar-row2">
      <span>
        {pagesWord(n).replace('page', 'scanned page')} {n === 1 ? 'wasn’t' : 'weren’t'} searched.
      </span>
      <button
        className="sign-link"
        // Keep focus in the input so typing can go on after a click.
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          // The row goes away once the pages are queued: from the keyboard (Tab, Enter) focus would
          // fall to <body>, where Esc and Delete reach the window shortcuts instead of Find.
          e.currentTarget
            .closest('.findbar')
            ?.querySelector<HTMLInputElement>('.findbar-input')
            ?.focus()
          actions.recognizeNow(summary.unrecognized)
        }}
      >
        Recognize text
      </button>
    </div>
  )
}
