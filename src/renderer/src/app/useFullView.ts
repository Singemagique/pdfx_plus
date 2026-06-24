import { useCallback, useRef, useState } from 'react'
import type { FullViewTarget } from './types'

export function useFullView() {
  const [fullView, setFullView] = useState<FullViewTarget | null>(null)
  const [hiddenPageId, setHiddenPageId] = useState<string | null>(null)
  const fullViewRef = useRef<FullViewTarget | null>(null)
  fullViewRef.current = fullView

  const openPage = useCallback((docId: string, pageId: string) => {
    const el = document.querySelector(`[data-page-id="${CSS.escape(pageId)}"]`)
    const rect = el?.getBoundingClientRect()
    setFullView({
      docId,
      pageId,
      originRect: rect
        ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
        : null
    })
    setHiddenPageId(pageId)
  }, [])

  const closeFullView = useCallback(() => {
    setFullView(null)
    setHiddenPageId(null)
  }, [])

  return { fullView, fullViewRef, hiddenPageId, setHiddenPageId, openPage, closeFullView }
}
