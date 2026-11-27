import { select } from 'd3-selection'
import { zoomTransform, type ZoomBehavior, type ZoomTransform } from 'd3-zoom'
import { BUTTON_ZOOM_FACTOR } from './use-zoom-behavior'
import { computeRevealTransform } from './reveal-transform'
import { REVEAL_BOTTOM_MARGIN, REVEAL_SIDE_MARGIN, REVEAL_TOP_MARGIN } from './zoom-constants'
import type { RefObject } from 'react'
import type { CanvasHandle } from '../components/Canvas'

interface CanvasHandleArgs {
  viewportRef: RefObject<HTMLDivElement | null>
  zoomRef: RefObject<ZoomBehavior<HTMLDivElement, unknown> | null>
  userMovedRef: RefObject<boolean>
  /** Animate to the fit view anchored at world y `focusY` (and mark the view un-moved). */
  refit: (focusY: number) => void
  /** True while a page drag is in flight. */
  draggingRef?: RefObject<boolean | undefined>
  /** Animate to a transform (see useAutoFit's reveal). */
  reveal?: (target: ZoomTransform) => void
  /** Where a running fit/reveal tween ends (see useAutoFit), or null. */
  pendingTarget?: () => ZoomTransform | null
  /** The content's world height, so a reveal never scrolls past its ends. */
  contentHeightRef?: RefObject<{ contentHeight: number } | null>
}

const center = (vp: HTMLDivElement): [number, number] => [vp.clientWidth / 2, vp.clientHeight / 2]

export function createCanvasHandle({
  viewportRef,
  zoomRef,
  userMovedRef,
  refit,
  draggingRef,
  reveal,
  pendingTarget,
  contentHeightRef
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
    revealRect(rect) {
      const vp = viewportRef.current
      if (!vp || !zoomRef.current || !reveal) return
      // Never fight the user: not mid page-drag, and not while d3 has a pan in progress.
      if (draggingRef?.current || vp.classList.contains('panning')) return
      // Measure against where a running tween is heading, not the frame it is at: a rect that
      // happens to be visible mid-tween may be carried off screen by the time it ends.
      const target = computeRevealTransform(
        pendingTarget?.() ?? zoomTransform(vp),
        { w: vp.clientWidth, h: vp.clientHeight },
        rect,
        { top: REVEAL_TOP_MARGIN, bottom: REVEAL_BOTTOM_MARGIN, side: REVEAL_SIDE_MARGIN },
        contentHeightRef?.current?.contentHeight
      )
      if (target) reveal(target)
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
