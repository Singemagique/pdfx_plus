// The scan-redaction note (DESIGN.md §3.8 "Redaction on a scan"), next to the Redact tool on a
// scanned page. With D3 pixel redaction the covered pixels go; when the export's redaction pass
// says it removes the whole scan image instead (pixel redaction did not apply to that image: its
// removal report, ocr-find-supply.ts `redactionOutcome`), the note says that.

import { useSyncExternalStore } from 'react'
import { useOcrPageState, useOcrStore } from '../../ocr/OcrContext'

export const REDACTION_NOTE = {
  pixels: 'Redacting removes the covered pixels and any recognized words under them.',
  whole: 'Redacting part of a scanned page removes the whole scan image and its recognized text.'
} as const

const noSubscribe = (): (() => void) => () => {}

export function OcrRedactionNote({ pageKey }: { pageKey: string }): React.JSX.Element | null {
  const { supply } = useOcrStore()
  const state = useOcrPageState(pageKey)
  const outcome = useSyncExternalStore(supply?.onChange ?? noSubscribe, () =>
    supply ? supply.redactionOutcome(pageKey) : 'unknown'
  )
  if (!state?.scan) return null
  return (
    <span className="tool-hint ocr-redaction-note" role="note">
      {outcome === 'whole' ? REDACTION_NOTE.whole : REDACTION_NOTE.pixels}
    </span>
  )
}
