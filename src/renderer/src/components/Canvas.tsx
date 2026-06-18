import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { pointer, select } from 'd3-selection'
import {
  zoom as d3zoom,
  zoomIdentity,
  zoomTransform,
  type ZoomBehavior,
  type ZoomTransform
} from 'd3-zoom'

type Extent = [[number, number], [number, number]]

// Like d3-zoom's default constrain (clamp the pan to translateExtent), but when
// the content is smaller than the viewport (far zoomed out) it does NOT recenter
// — that recenter is what shifts your position when zooming out then back in.
// Zooming stays anchored to the cursor, so zoom in/out is fully reversible.
function reversibleConstrain(
  transform: ZoomTransform,
  extent: Extent,
  translateExtent: Extent
): ZoomTransform {
  const dx0 = transform.invertX(extent[0][0]) - translateExtent[0][0]
  const dx1 = transform.invertX(extent[1][0]) - translateExtent[1][0]
  const dy0 = transform.invertY(extent[0][1]) - translateExtent[0][1]
  const dy1 = transform.invertY(extent[1][1]) - translateExtent[1][1]
  return transform.translate(
    dx1 > dx0 ? 0 : Math.min(0, dx0) || Math.max(0, dx1),
    dy1 > dy0 ? 0 : Math.min(0, dy0) || Math.max(0, dy1)
  )
}

// Zoom-in is capped (you rarely need more than ~8x on a page); zoom-out goes
// far enough to see a huge collection as specks.
const MIN_SCALE = 0.02
const MAX_SCALE = 90
// Panning is bounded to the content box grown by this fraction on every side.
const PAN_MARGIN = 3 // 300% of the content beyond its edges
const FIT_MARGIN = 0.86 // leave a little breathing room when fitting
const TARGET_VISIBLE_DOCS = 3.5
const WHEEL_ZOOM_SPEED = 0.03 // ~3x faster pinch zoom
const BUTTON_ZOOM_FACTOR = 1.35

export interface CanvasHandle {
  zoomIn(): void
  zoomOut(): void
  /** Re-center and fit the collection. */
  reset(): void
}

interface CanvasProps {
  contentWidth: number
  contentHeight: number
  /** One document slot incl. gap, for the "fit ~N docs" initial zoom. */
  slotHeight: number
  onScaleChange?: (scale: number) => void
  /** Fired ~once after a zoom/pan gesture stops, for crisp re-rendering. */
  onSettle?: () => void
  onBackgroundClick?: () => void
  children: React.ReactNode
}

export const Canvas = forwardRef<CanvasHandle, CanvasProps>(function Canvas(
  { contentWidth, contentHeight, slotHeight, onScaleChange, onSettle, onBackgroundClick, children },
  ref
) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const zoomRef = useRef<ZoomBehavior<HTMLDivElement, unknown> | null>(null)
  // Auto-fit keeps re-framing as documents load (they arrive one by one) until
  // the user pans/zooms for real, after which we leave their view alone.
  const userMovedRef = useRef(false)
  // Promote the world to a GPU layer only while moving; drop it at rest so the
  // browser re-rasterizes text + pages crisply at the current scale.
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Throttle the layout-affecting updates (label counter-scale + toolbar %) so
  // they don't run on every zoom frame; the transform itself stays at 60fps.
  const lastTick = useRef(0)
  // Latest dims for handlers/closures that are created once.
  const dims = useRef({ contentWidth, contentHeight, slotHeight })
  dims.current = { contentWidth, contentHeight, slotHeight }
  const onScaleRef = useRef(onScaleChange)
  onScaleRef.current = onScaleChange
  const onSettleRef = useRef(onSettle)
  onSettleRef.current = onSettle

  const fitTransform = (): ReturnType<typeof zoomIdentity.translate> => {
    const vp = viewportRef.current!
    const W = vp.clientWidth
    const H = vp.clientHeight
    const { contentWidth: cw, contentHeight: ch, slotHeight: slot } = dims.current
    const visibleDocs = Math.min(TARGET_VISIBLE_DOCS, Math.max(1, ch / slot))
    const k = Math.max(
      MIN_SCALE,
      Math.min(MAX_SCALE, (W * FIT_MARGIN) / cw, (H * FIT_MARGIN) / (visibleDocs * slot))
    )
    // Center the content bbox [0,0,cw,ch] in the viewport.
    const tx = (W - cw * k) / 2
    const ty = (H - ch * k) / 2
    return zoomIdentity.translate(tx, ty).scale(k)
  }

  // One-time d3-zoom wiring: drag-pan, custom wheel, cursor, resize.
  useLayoutEffect(() => {
    const vp = viewportRef.current
    if (!vp) return

    const zoomBehavior = d3zoom<HTMLDivElement, unknown>()
      .scaleExtent([MIN_SCALE, MAX_SCALE])
      .constrain(reversibleConstrain)
      .filter((event) => {
        // Wheel is handled manually (Figma-style pan vs. zoom); ignore here.
        if (event.type === 'wheel') return false
        if ((event as MouseEvent).button) return false
        // Don't start a pan from interactive bits — let them click/drag/select.
        const target = event.target as Element | null
        return !target?.closest('.page, button, input, textarea, .doc-actions')
      })
      .on('start', () => vp.classList.add('panning'))
      .on('end', () => vp.classList.remove('panning'))
      .on('zoom', (event) => {
        // A real gesture (not a programmatic fit) has a sourceEvent.
        if (event.sourceEvent) userMovedRef.current = true
        const t = event.transform
        const world = worldRef.current
        // Per frame: only the transform + layer hint (composite-only, no layout).
        if (world) {
          world.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.k})`
          world.style.willChange = 'transform'
        }
        // Throttled: the label counter-scale (reflows headers) and the React %
        // update. ~11/s is smooth enough for a small label and the readout.
        const now = performance.now()
        if (now - lastTick.current >= 90) {
          lastTick.current = now
          world?.style.setProperty('--zoom', String(t.k))
          onScaleRef.current?.(t.k)
        }
        // On idle: exact label scale + toolbar %, and drop the layer so text
        // and pages re-rasterize crisply at the final scale.
        if (idleTimer.current) clearTimeout(idleTimer.current)
        const k = t.k
        idleTimer.current = setTimeout(() => {
          world?.style.setProperty('--zoom', String(k))
          if (world) world.style.willChange = 'auto'
          onScaleRef.current?.(k)
          onSettleRef.current?.()
        }, 200)
      })

    zoomRef.current = zoomBehavior
    const sel = select(vp)
    sel.call(zoomBehavior)
    sel.on('dblclick.zoom', null) // double-click-to-zoom feels wrong here

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const [px, py] = pointer(event, vp)
      if (event.ctrlKey || event.metaKey) {
        // Pinch / ⌘-wheel → zoom toward the cursor. Clamp the delta so a chunky
        // mouse-wheel notch doesn't jump wildly while keeping pinch responsive.
        const dy = Math.max(-50, Math.min(50, event.deltaY))
        zoomBehavior.scaleBy(sel, Math.pow(2, -dy * WHEEL_ZOOM_SPEED), [px, py])
      } else {
        // Plain wheel / two-finger scroll → pan.
        const k = zoomTransform(vp).k
        zoomBehavior.translateBy(sel, -event.deltaX / k, -event.deltaY / k)
      }
    }
    vp.addEventListener('wheel', onWheel, { passive: false })

    const resize = new ResizeObserver(() => {
      zoomBehavior.extent([
        [0, 0],
        [vp.clientWidth, vp.clientHeight]
      ])
    })
    resize.observe(vp)

    return () => {
      vp.removeEventListener('wheel', onWheel)
      resize.disconnect()
      sel.on('.zoom', null)
      if (idleTimer.current) clearTimeout(idleTimer.current)
    }
  }, [])

  // Keep the viewport/pan extents in sync with content size, and fit once.
  useLayoutEffect(() => {
    const vp = viewportRef.current
    const zoomBehavior = zoomRef.current
    if (!vp || !zoomBehavior) return
    zoomBehavior.extent([
      [0, 0],
      [vp.clientWidth, vp.clientHeight]
    ])
    const mx = contentWidth * PAN_MARGIN
    const my = contentHeight * PAN_MARGIN
    zoomBehavior.translateExtent([
      [-mx, -my],
      [contentWidth + mx, contentHeight + my]
    ])
    if (!userMovedRef.current && contentWidth > 1 && contentHeight > 1) {
      select(vp).call(zoomBehavior.transform, fitTransform())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentWidth, contentHeight])

  useImperativeHandle(ref, () => ({
    zoomIn() {
      const vp = viewportRef.current
      if (!vp || !zoomRef.current) return
      zoomRef.current.scaleBy(select(vp), BUTTON_ZOOM_FACTOR, [vp.clientWidth / 2, vp.clientHeight / 2])
    },
    zoomOut() {
      const vp = viewportRef.current
      if (!vp || !zoomRef.current) return
      zoomRef.current.scaleBy(select(vp), 1 / BUTTON_ZOOM_FACTOR, [
        vp.clientWidth / 2,
        vp.clientHeight / 2
      ])
    },
    reset() {
      const vp = viewportRef.current
      if (!vp || !zoomRef.current) return
      zoomRef.current.transform(select(vp), fitTransform())
    }
  }))

  return (
    <div
      className="canvas-viewport"
      ref={viewportRef}
      onClick={(event) => {
        const target = event.target as Element
        if (!target.closest('.page') && !target.closest('button')) onBackgroundClick?.()
      }}
    >
      <div className="canvas-world" ref={worldRef}>
        {children}
      </div>
    </div>
  )
})
