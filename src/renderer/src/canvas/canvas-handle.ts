import { select } from 'd3-selection'
import { zoomTransform, type ZoomBehavior } from 'd3-zoom'
import { BUTTON_ZOOM_FACTOR } from './use-zoom-behavior'
import type { RefObject } from 'react'
import type { CanvasHandle } from '../components/Canvas'

interface CanvasHandleArgs {
  viewportRef: RefObject<HTMLDivElement | null>
  zoomRef: RefObject<ZoomBehavior<HTMLDivElement, unknown> | null>
  userMovedRef: RefObject<boolean>
  /** Animate to the fit view anchored at world y `focusY` (and mark the view un-moved). */
  refit: (focusY: number) => void
}

const center = (vp: HTMLDivElement): [number, number] => [vp.clientWidth / 2, vp.clientHeight / 2]

export function createCanvasHandle({
  viewportRef,
  zoomRef,
  userMovedRef,
  refit
}: CanvasHandleArgs): CanvasHandle {
  return {
    zoomIn() {
      const vp = viewportRef.current
      if (!vp || !zoomRef.current) return
      userMovedRef.current = true
      zoomRef.current.scaleBy(select(vp), BUTTON_ZOOM_FACTOR, center(vp))
    },
    zoomOut() {
      const vp = viewportRef.current
      if (!vp || !zoomRef.current) return
      userMovedRef.current = true
      zoomRef.current.scaleBy(select(vp), 1 / BUTTON_ZOOM_FACTOR, center(vp))
    },
    reset() {
      if (!viewportRef.current || !zoomRef.current) return
      refit(0)
    },
    clientToWorld(clientX, clientY) {
      const vp = viewportRef.current
      if (!vp) return null
      const rect = vp.getBoundingClientRect()
      const t = zoomTransform(vp)
      return { x: t.invertX(clientX - rect.left), y: t.invertY(clientY - rect.top), k: t.k }
    }
  }
}
