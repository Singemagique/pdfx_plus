import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { select } from 'd3-selection'
import { zoomIdentity, zoomTransform, type ZoomBehavior, type ZoomTransform } from 'd3-zoom'
import { animateZoomTo } from './animate-transform'
import { boundToViewport } from './constrain'
import { FIT_ANIMATION_MS, FIT_TOP_MARGIN, REVEAL_ANIMATION_MS } from './zoom-constants'

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
  /** The world width the view can be panned across (default contentWidth; see panReachWidth). */
  reachWidth?: number
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
 *   only horizontally framed: see keepMovedViewInFrame. A height-only change never moves it, unless
 *   it leaves the view past the new end of the content: then it is pulled back to the end.
 *
 * It also owns the pan bounds: the zoom's translate extent is the content box, and every transform
 * it sets (fit, import focus, Find's reveal, re-framing) is bounded the way gestures are, by
 * boundToViewport.
 */
export function useAutoFit({
  viewportRef,
  zoomRef,
  userMovedRef,
  draggingRef,
  fitTransform,
  contentWidth,
  contentHeight,
  reachWidth = contentWidth,
  focus,
  viewportWidth,
  viewportHeight
}: AutoFitArgs): {
  refit: (focusY: number) => void
  reveal: (target: ZoomTransform) => void
  /** Where the running fit or reveal tween will leave the view, or null when none is running. */
  pendingTarget: () => ZoomTransform | null
} {
  const fitted = useRef(false)
  const lastDims = useRef({ w: 0, h: 0, vw: 0, vh: 0 })
  const lastFocus = useRef<FitFocus | null>(null)
  /** The world y the running animation (if any) is heading for. */
  const animAnchor = useRef<number | null>(null)
  const cancelAnim = useRef<(() => void) | null>(null)
  /** The transform the running animation (if any) ends at. */
  const animTarget = useRef<ZoomTransform | null>(null)
  /** The scale the last fit set — if the view is still at it, the user has scrolled, not zoomed. */
  const fitK = useRef<number | null>(null)

  const stopAnim = (): void => {
    cancelAnim.current?.()
    cancelAnim.current = null
    animAnchor.current = null
    animTarget.current = null
  }

  /** `t` within the pan bounds (zoom.transform does not constrain; see boundToViewport). */
  const bounded = (t: ZoomTransform): ZoomTransform => {
    const vp = viewportRef.current
    const zoom = zoomRef.current
    return vp && zoom ? boundToViewport(vp, zoom, t) : t
  }

  const animateTo = (focusY: number): void => {
    const vp = viewportRef.current
    const zoom = zoomRef.current
    if (!vp || !zoom) return
    stopAnim()
    animAnchor.current = focusY
    userMovedRef.current = false
    const target = bounded(fitTransform(focusY))
    animTarget.current = target
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
        animTarget.current = null
      },
      bounded
    )
  }

  const jumpTo = (focusY: number): void => {
    const vp = viewportRef.current
    const zoom = zoomRef.current
    if (!vp || !zoom) return
    stopAnim()
    select(vp).call(zoom.transform, bounded(fitTransform(focusY)))
    fitK.current = zoomTransform(vp).k
  }

  /**
   * Pull the view back inside the pan bounds if a content or viewport change left it outside them
   * (the content got shorter under a view scrolled to its end, the pane grew). A no-op otherwise,
   * and never mid-drag or mid-tween (the tween bounds every frame itself).
   */
  const keepInBounds = (): void => {
    const vp = viewportRef.current
    const zoom = zoomRef.current
    if (!vp || !zoom || draggingRef.current || cancelAnim.current) return
    const t = zoomTransform(vp)
    const b = bounded(t)
    if (b !== t) select(vp).call(zoom.transform, b)
  }

  useLayoutEffect(() => {
    const vp = viewportRef.current
    const zoom = zoomRef.current
    if (!vp || !zoom) return
    zoom.extent([
      [0, 0],
      [vp.clientWidth, vp.clientHeight]
    ])
    // The pan bounds' content box (see boundTransform): the column of document cards, which spans
    // the collection's width (and any edge "Add page" button), down to the end of the trailing
    // "Add document" row.
    zoom.translateExtent([
      [0, 0],
      [Math.max(contentWidth, reachWidth), contentHeight]
    ])
    if (contentWidth <= 1 || contentHeight <= 1) return
    place()
    keepInBounds()
  }, [contentWidth, contentHeight, reachWidth, focus, viewportWidth, viewportHeight])

  /** Decide whether, and how, the content/viewport change that ran the layout effect re-fits. */
  const place = (): void => {
    const vp = viewportRef.current
    if (!vp) return

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
  }

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
    select(vp).call(zoom.transform, bounded(zoomIdentity.translate(tx, t.y).scale(t.k)))
  }

  useEffect(() => stopAnim, [])

  const refit = useCallback((focusY: number) => animateTo(focusY), [])

  /**
   * Animate to `target` (Find bringing a page into view). It shares the fit's tween slot, so the
   * two never run at once; a wheel or drag mid-tween marks the view user-moved, which aborts it.
   * It ends marked user-moved too, so a later content change doesn't re-fit away from the page.
   */
  const reveal = useCallback((requested: ZoomTransform) => {
    const vp = viewportRef.current
    const zoom = zoomRef.current
    if (!vp || !zoom) return
    stopAnim()
    userMovedRef.current = false
    // Bounded like any other view: a page near the top of the content can't be brought lower than
    // the content's top is allowed to go.
    const target = bounded(requested)
    animTarget.current = target
    cancelAnim.current = animateZoomTo(
      vp,
      zoom,
      target,
      REVEAL_ANIMATION_MS,
      () => userMovedRef.current,
      () => {
        cancelAnim.current = null
        animTarget.current = null
        userMovedRef.current = true
      },
      bounded
    )
  }, [])

  // A tween the user aborted (wheel/drag) has not reached its target: only a live one counts.
  const pendingTarget = useCallback(
    () => (cancelAnim.current && !userMovedRef.current ? animTarget.current : null),
    []
  )
  return { refit, reveal, pendingTarget }
}
