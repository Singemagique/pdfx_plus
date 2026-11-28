// The full-view banner's "at most once per document per session" (DESIGN.md §3.8 "Full-view
// banner"). A document is seen once the banner was answered for it (onDone), or once full view
// leaves it after showing it: moving to another document (whether or not that one shows the
// banner), or closing full view. Session state only.

import { useCallback, useEffect, useRef, useState } from 'react'

export interface BannerSeen {
  /** Documents the banner was already shown for this session. */
  seen: ReadonlySet<string>
  /** OcrBanner showed for `docId`. */
  onShown: (docId: string) => void
  /** Answered (Recognize, Just this page, Not now, Stop): never again for `docId`. */
  onDone: (docId: string) => void
}

/** `viewDocId`: the document full view shows, or null when full view is closed. */
export function useBannerSeen(viewDocId: string | null): BannerSeen {
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set())
  // Shown and not yet seen. A set: the banner of the document full view moves TO can report in
  // (a child effect) before this hook's effect sees the move away from the previous one.
  const shown = useRef(new Set<string>())
  const onDone = useCallback((docId: string) => {
    shown.current.delete(docId)
    setSeen((s) => (s.has(docId) ? s : new Set([...s, docId])))
  }, [])
  const onShown = useCallback((docId: string) => {
    shown.current.add(docId)
  }, [])
  useEffect(() => {
    // Full view moved to another document, or closed: the ones it showed for are done with.
    for (const d of [...shown.current]) if (d !== viewDocId) onDone(d)
  }, [viewDocId, onDone])
  return { seen, onShown, onDone }
}
