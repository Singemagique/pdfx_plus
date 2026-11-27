import { useEffect, useRef, useState } from 'react'
import type { Overlay } from '../edit/model'
import type { DocEntry } from '../types'
import { createFindController, type FindController, type FindMatch } from './find-controller'

interface UseFindArgs {
  docs: readonly DocEntry[]
  overlays: readonly Overlay[]
  getAnchorPageId: () => string | null
  onNavigate: (match: FindMatch) => void
}

/**
 * The app's find controller: created once, side-effect free until the bar first opens, and fed the
 * collection and overlays as they change. The returned controller is stable, so nothing above the
 * components that subscribe to it re-renders because of find state.
 */
export function useFind({
  docs,
  overlays,
  getAnchorPageId,
  onNavigate
}: UseFindArgs): FindController {
  const anchorRef = useRef(getAnchorPageId)
  anchorRef.current = getAnchorPageId
  const navigateRef = useRef(onNavigate)
  navigateRef.current = onNavigate

  const [controller] = useState(() =>
    createFindController({
      getAnchorPageId: () => anchorRef.current(),
      onNavigate: (m) => navigateRef.current(m)
    })
  )

  useEffect(() => controller.setDocs(docs), [controller, docs])
  useEffect(() => controller.setOverlays(overlays), [controller, overlays])
  // Only timers are torn down: StrictMode's mount/unmount/mount must leave a working controller.
  useEffect(() => () => controller.cancelTimers(), [controller])

  return controller
}
