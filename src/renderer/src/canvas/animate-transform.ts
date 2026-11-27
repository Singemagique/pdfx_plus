import { select } from 'd3-selection'
import { zoomIdentity, zoomTransform, type ZoomBehavior, type ZoomTransform } from 'd3-zoom'

const easeOutCubic = (p: number): number => 1 - Math.pow(1 - p, 3)

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * Tween the viewport's zoom transform to `target` over `duration` ms (ease-out; scale interpolated
 * geometrically so zooming feels even). Every frame goes through `zoom.transform` without a source
 * event, so it never counts as a user move. The tween stops early when `shouldAbort()` turns true
 * (the user grabbed the view). Returns a cancel function. Jumps straight to the target when motion
 * is reduced or there is no animation frame clock.
 */
export function animateZoomTo(
  vp: HTMLDivElement,
  zoom: ZoomBehavior<HTMLDivElement, unknown>,
  target: ZoomTransform,
  duration: number,
  shouldAbort: () => boolean,
  onDone?: () => void
): () => void {
  const sel = select(vp)
  if (duration <= 0 || prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
    zoom.transform(sel, target)
    onDone?.()
    return () => {}
  }
  const start = zoomTransform(vp)
  const lk0 = Math.log(start.k)
  const lk1 = Math.log(target.k)
  const t0 = performance.now()
  let raf = 0
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    onDone?.()
  }
  // Time is read from performance.now() rather than the frame timestamp: not every rAF clock
  // (jsdom's, notably) shares its time origin.
  const step = (): void => {
    if (finished) return
    if (shouldAbort()) return finish()
    const p = Math.min(1, Math.max(0, (performance.now() - t0) / duration))
    const e = easeOutCubic(p)
    const t =
      p >= 1
        ? target
        : zoomIdentity
            .translate(start.x + (target.x - start.x) * e, start.y + (target.y - start.y) * e)
            .scale(Math.exp(lk0 + (lk1 - lk0) * e))
    zoom.transform(sel, t)
    if (p < 1) raf = requestAnimationFrame(step)
    else finish()
  }
  raf = requestAnimationFrame(step)
  return () => {
    cancelAnimationFrame(raf)
    finish()
  }
}
