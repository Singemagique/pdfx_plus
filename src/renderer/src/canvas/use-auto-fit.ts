import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { select } from 'd3-selection'
import { zoomIdentity, zoomTransform, type ZoomBehavior, type ZoomTransform } from 'd3-zoom'
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
  /**
   * A new object (by identity) each time documents are imported — the same object again for later
   * commits of one import batch; null otherwise.
   */
  focus: FitFocus | null
  /** The measured (debounced, held back mid-drag) viewport size; a change re-runs the fit. */
  viewportWidth: number
  viewportHeight: number
}

/**
 * Owns when the canvas re-fits:
 * - first layout: fit immediately, top of the content in view;
 * - documents imported (`focus` changes): animated fit scrolled to the first new document — even if
 *   the user had moved the view — after which the view counts as un-moved again;
 * - later commits of the same import batch (same `focus` object): keep heading for its first doc;
 * - any other content change (re-wrap, rotate, delete, reorder) or viewport resize, while nothing is
 *   being dragged: an unmoved view re-fits, keeping whatever world y is at the top of the view, so
 *   it re-scales without scrolling away from where they are;
 * - the same for a view the user moved, but only when the pane or the content changed WIDTH, and
 *   only horizontally framed: see keepMovedViewInFrame. A height-only change never moves it.
 */
export function useAutoFit({
  viewportRef,
  zoomRef,
  userMovedRef,
  draggingRef,
  fitTransform,
  contentWidth,
  contentHeight,
  focus,
  viewportWidth,
  viewportHeight
}: AutoFitArgs): { refit: (focusY: number) => void } {
  const fitted = useRef(false)
  const lastDims = useRef({ w: 0, h: 0, vw: 0, vh: 0 })
  const lastFocus = useRef<FitFocus | null>(null)
  /** The world y the running animation (if any) is heading for. */
  const animAnchor = useRef<number | null>(null)
  const cancelAnim = useRef<(() => void) | null>(null)
  /** The scale the last fit set — if the view is still at it, the user has scrolled, not zoomed. */
  const fitK = useRef<number | null>(null)

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
    const target = fitTransform(focusY)
    fitK.current = target.k
    cancelAnim.current = animateZoomTo(
      vp,
      zoom,
      target,
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
    fitK.current = zoomTransform(vp).k
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

    // A viewport resize counts as a change even when the layout doesn't re-wrap (the wrap is
    // clamped at MIN_DOC_WIDTH, or the narrower wrap packs the same columns): the fit scale still
    // has to follow the new width, or the right-hand columns end up clipped off the pane.
    const vw = viewportWidth
    const vh = viewportHeight
    const last = lastDims.current
    const changed =
      last.w !== contentWidth || last.h !== contentHeight || last.vw !== vw || last.vh !== vh
    lastDims.current = { w: contentWidth, h: contentHeight, vw, vh }

    if (focus && focus === lastFocus.current) {
      // A later commit of the same import batch: keep heading for the batch's first document.
      if (!changed || userMovedRef.current || draggingRef.current) return
      if (animAnchor.current !== null) animateTo(focus.y)
      else jumpTo(focus.y)
      return
    }
    if (focus) {
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
    if (!changed || draggingRef.current) return
    if (userMovedRef.current) {
      keepMovedViewInFrame(last, vw)
      return
    }
    if (animAnchor.current !== null) {
      animateTo(animAnchor.current)
      return
    }
    jumpTo(zoomTransform(vp).invertY(FIT_TOP_MARGIN))
  }, [contentWidth, contentHeight, focus, viewportWidth, viewportHeight])

  /**
   * The user has scrolled or zoomed, so the view is theirs — but the pane or the content changed
   * width, and the transform alone (anchored at the top-left) would leave the re-wrapped content
   * off-centre or running off the right edge. Keep their place (the world y at the top of the
   * view) and frame the content horizontally again:
   * - a resize when they only scrolled (the scale is still the one the fit set): re-fit the scale to
   *   the new width, as for an unmoved view;
   * - otherwise (they zoomed, or only the content width changed): keep their scale, centre content
   *   that fits across, and keep the same point of wider content at the middle of the pane.
   * The view stays marked as moved, so later content changes still won't scroll it.
   */
  const keepMovedViewInFrame = (prev: { w: number; vw: number; vh: number }, vw: number): void => {
    const vp = viewportRef.current
    const zoom = zoomRef.current
    if (!vp || !zoom) return
    const resized = prev.vw !== vw || prev.vh !== viewportHeight
    if (!resized && prev.w === contentWidth) return
    const t = zoomTransform(vp)
    const scrolledOnly = fitK.current !== null && Math.abs(t.k - fitK.current) <= 1e-6 * t.k
    if (resized && scrolledOnly) {
      jumpTo(t.invertY(FIT_TOP_MARGIN))
      return
    }
    stopAnim()
    const W = vp.clientWidth
    let tx: number
    if (contentWidth * t.k <= W) tx = (W - contentWidth * t.k) / 2
    else {
      const prevW = prev.vw > 0 ? prev.vw : W
      const prevCw = prev.w > 0 ? prev.w : contentWidth
      const cx = ((prevW / 2 - t.x) / t.k) * (contentWidth / prevCw)
      tx = W / 2 - cx * t.k
    }
    select(vp).call(zoom.transform, zoomIdentity.translate(tx, t.y).scale(t.k))
  }

  useEffect(() => stopAnim, [])

  const refit = useCallback((focusY: number) => animateTo(focusY), [])
  return { refit }
}
