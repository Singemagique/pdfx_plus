import { useLayoutEffect, useRef, type RefObject } from 'react'
import { pointer, select } from 'd3-selection'
import { zoomIdentity, zoomTransform, type ZoomBehavior } from 'd3-zoom'
import { createZoomBehavior } from './create-zoom-behavior'
import { computeFitTransform } from './fit-transform'
import { WHEEL_ZOOM_SPEED } from './zoom-constants'

export {
  MIN_SCALE,
  MAX_SCALE,
  PAN_MARGIN,
  FIT_MARGIN,
  TARGET_VISIBLE_DOCS,
  WHEEL_ZOOM_SPEED,
  BUTTON_ZOOM_FACTOR
} from './zoom-constants'

interface Dims {
  contentWidth: number
  contentHeight: number
  slotHeight: number
}

interface ZoomBehaviorArgs {
  viewportRef: RefObject<HTMLDivElement | null>
  worldRef: RefObject<HTMLDivElement | null>
  overlayRef: RefObject<HTMLDivElement | null>
  userMovedRef: RefObject<boolean>
  dims: RefObject<Dims>
  onScaleChange?: (scale: number) => void
  onSettle?: () => void
}

export function useZoomBehavior({
  viewportRef,
  worldRef,
  overlayRef,
  userMovedRef,
  dims,
  onScaleChange,
  onSettle
}: ZoomBehaviorArgs): {
  zoomRef: RefObject<ZoomBehavior<HTMLDivElement, unknown> | null>
  fitTransform: () => ReturnType<typeof zoomIdentity.translate>
} {
  const zoomRef = useRef<ZoomBehavior<HTMLDivElement, unknown> | null>(null)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastTick = useRef(0)
  const onScaleRef = useRef(onScaleChange)
  onScaleRef.current = onScaleChange
  const onSettleRef = useRef(onSettle)
  onSettleRef.current = onSettle

  const fitTransform = (): ReturnType<typeof zoomIdentity.translate> =>
    computeFitTransform(viewportRef.current!, dims.current!)

  useLayoutEffect(() => {
    const vp = viewportRef.current
    if (!vp) return

    const zoomBehavior = createZoomBehavior({
      vp,
      worldRef,
      overlayRef,
      userMovedRef,
      idleTimer,
      lastTick,
      onScaleRef,
      onSettleRef
    })

    zoomRef.current = zoomBehavior
    const sel = select(vp)
    sel.call(zoomBehavior)
    sel.on('dblclick.zoom', null)

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const [px, py] = pointer(event, vp)
      if (event.ctrlKey || event.metaKey) {
        const dy = Math.max(-50, Math.min(50, event.deltaY))
        zoomBehavior.scaleBy(sel, Math.pow(2, -dy * WHEEL_ZOOM_SPEED), [px, py])
      } else {
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

  return { zoomRef, fitTransform }
}
