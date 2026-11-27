import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { select } from 'd3-selection'
import { zoomTransform, type ZoomBehavior, type ZoomTransform } from 'd3-zoom'
import { animateZoomTo } from './animate-transform'
import { FIT_ANIMATION_MS, FIT_TOP_MARGIN, PAN_MARGIN } from './zoom-constants'

/** A request to bring world y `y` (the top of a just-imported document) to the top of the view. */
export interface FitFocus {
  y: number
}

interface AutoFitArgs {
  viewportRef: RefObject<HTMLDivElement | null>
  zoomRef: RefObject<ZoomBehavior<HTMLDivElement, unknown> | null>
  userMovedRef: RefObject<boolean>
  draggingRef: RefObject<boolean | undefined>
  fitTransform: (focusY?: number) => ZoomTransform
  contentWidth: number
  contentHeight: number
  /** A new object (by identity) each time documents are imported; null otherwise. */
  focus: FitFocus | null
}

/**
 * Owns when the canvas re-fits:
 * - first layout: fit immediately, top of the content in view;
 * - documents imported (`focus` changes): animated fit scrolled to the first new document — even if
 *   the user had moved the view — after which the view counts as un-moved again;
 * - any other content change (re-wrap on resize, rotate, delete, reorder): only while the user has
 *   not moved the view and nothing is being dragged, and then it keeps whatever world y is at the
 *   top of the view, so an edit re-scales the fit without scrolling away from where they are.
 */
export function useAutoFit({
  viewportRef,
  zoomRef,
  userMovedRef,
  draggingRef,
  fitTransform,
  contentWidth,
  contentHeight,
  focus
}: AutoFitArgs): { refit: (focusY: number) => void } {
  const fitted = useRef(false)
  const lastDims = useRef({ w: 0, h: 0 })
  const lastFocus = useRef<FitFocus | null>(null)
  /** The world y the running animation (if any) is heading for. */
  const animAnchor = useRef<number | null>(null)
  const cancelAnim = useRef<(() => void) | null>(null)

  const stopAnim = (): void => {
    cancelAnim.current?.()
    cancelAnim.current = null
    animAnchor.current = null
  }

  const animateTo = (focusY: number): void => {
    const vp = viewportRef.current
    const zoom = zoomRef.current
    if (!vp || !zoom) return
    stopAnim()
    animAnchor.current = focusY
    userMovedRef.current = false
    cancelAnim.current = animateZoomTo(
      vp,
      zoom,
      fitTransform(focusY),
      FIT_ANIMATION_MS,
      () => userMovedRef.current,
      () => {
        cancelAnim.current = null
        animAnchor.current = null
      }
    )
  }

  const jumpTo = (focusY: number): void => {
    const vp = viewportRef.current
    const zoom = zoomRef.current
    if (!vp || !zoom) return
    stopAnim()
    select(vp).call(zoom.transform, fitTransform(focusY))
  }

  useLayoutEffect(() => {
    const vp = viewportRef.current
    const zoom = zoomRef.current
    if (!vp || !zoom) return
    zoom.extent([
      [0, 0],
      [vp.clientWidth, vp.clientHeight]
    ])
    const mx = contentWidth * PAN_MARGIN
    const my = contentHeight * PAN_MARGIN
    zoom.translateExtent([
      [-mx, -my],
      [contentWidth + mx, contentHeight + my]
    ])
    if (contentWidth <= 1 || contentHeight <= 1) return

    const changed = lastDims.current.w !== contentWidth || lastDims.current.h !== contentHeight
    lastDims.current = { w: contentWidth, h: contentHeight }

    if (focus && focus !== lastFocus.current) {
      lastFocus.current = focus
      if (fitted.current) animateTo(focus.y)
      else {
        userMovedRef.current = false
        jumpTo(focus.y)
      }
      fitted.current = true
      return
    }
    if (!fitted.current) {
      fitted.current = true
      jumpTo(0)
      return
    }
    if (!changed || userMovedRef.current || draggingRef.current) return
    if (animAnchor.current !== null) {
      animateTo(animAnchor.current)
      return
    }
    jumpTo(zoomTransform(vp).invertY(FIT_TOP_MARGIN))
  }, [contentWidth, contentHeight, focus])

  useEffect(() => stopAnim, [])

  const refit = useCallback((focusY: number) => animateTo(focusY), [])
  return { refit }
}
