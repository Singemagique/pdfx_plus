// The OCR pieces App mounts inside OcrUiProvider (DESIGN.md §3.8): the Sign dialog told whether
// recognised text exists (D7), the Document-menu checkbox mirror, and the toasts.

import { useEffect, useRef } from 'react'
import { useOcrSettings, useOcrSummary } from '../../ocr/OcrContext'
import type { OcrStore } from '../../ocr/ocr-store'
import { batchToast, UNAVAILABLE_COPY, unavailableDetails } from '../../ocr/ocr-ui'
import { SignDialog } from '../SignDialog'

export interface ToastAction {
  label: string
  run: () => void
}

export type Flash = (message: string, action?: ToastAction) => void

/**
 * The Sign dialog, told whether recognised text exists for the pages it signs (D7: Sign signs the
 * whole collection, so any live page with recognised text shows the box).
 */
export function OcrSignDialog(
  props: Omit<React.ComponentProps<typeof SignDialog>, 'recognizedTextAvailable'>
): React.JSX.Element {
  const { summary } = useOcrSummary()
  return <SignDialog {...props} recognizedTextAvailable={summary.withText.length > 0} />
}

/** Mirrors the Document menu's two checkboxes into the native menu (main keeps no state of its own). */
export function OcrMenuSync({ showRecognizedText }: { showRecognizedText: boolean }): null {
  const settings = useOcrSettings()
  const include = settings?.['ocr.includeInExports'] ?? true
  useEffect(() => {
    window.api.setMenuChecked?.('include-recognized-text', include)
  }, [include])
  useEffect(() => {
    window.api.setMenuChecked?.('show-recognized-text', showRecognizedText)
  }, [showRecognizedText])
  return null
}

/**
 * The OCR toasts (§3.8 "Toasts"), through the existing flash: each request says once how it ended
 * (recognised / stopped / crashed, with Resume), and the session says once when OCR became
 * unavailable ("couldn't start", with Details). A request that ends as it starts (nothing to do)
 * speaks only when the user asked for it (batchToast).
 */
export function OcrToasts({
  store,
  flash,
  onDetails
}: {
  store: Pick<OcrStore, 'resume'>
  flash: Flash
  onDetails: () => void
}): null {
  const { snapshot } = useOcrSummary()
  const seen = useRef(new Map<string, string>())
  const unavailable = useRef(snapshot.unavailable)
  const details = useRef(onDetails)
  details.current = onDetails
  useEffect(() => {
    for (const b of snapshot.batches) {
      const prev = seen.current.get(b.id)
      if (prev === b.state) continue
      seen.current.set(b.id, b.state)
      if (b.state === 'running') continue
      // Only the end of a run speaks (a crashed request a later one took over says nothing more).
      if (prev !== undefined && prev !== 'running') continue
      const t = batchToast(b)
      if (!t) continue
      if (t.action === 'resume')
        flash(t.message, { label: 'Resume', run: () => store.resume(b.id) })
      else if (t.action === 'details')
        flash(t.message, { label: 'Details', run: () => details.current() })
      else flash(t.message)
    }
    if (snapshot.unavailable !== unavailable.current) {
      const reason = snapshot.unavailable
      unavailable.current = reason
      if (reason && reason !== 'no-port')
        flash(UNAVAILABLE_COPY, { label: 'Details', run: () => flash(unavailableDetails(reason)) })
    }
  }, [snapshot, store, flash])
  return null
}
