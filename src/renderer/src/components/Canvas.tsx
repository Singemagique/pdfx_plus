import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { useZoomBehavior } from '../canvas/use-zoom-behavior'
import { useAutoFit, type FitFocus } from '../canvas/use-auto-fit'
import { useViewportSize, type ViewportSize } from '../canvas/use-viewport-size'
import { createCanvasHandle } from '../canvas/canvas-handle'

export interface CanvasHandle {
  zoomIn(): void
  zoomOut(): void
  reset(): void
  /** Bring a world rect (a page slot) into view, unless the user is dragging or panning. */
  revealRect(rect: { x: number; y: number; w: number; h: number }): void
  clientToWorld(clientX: number, clientY: number): { x: number; y: number; k: number } | null
}

interface CanvasProps {
  contentWidth: number
  contentHeight: number
  /**
   * The world width the view can be panned across, when wider than `contentWidth` (a round "Add
   * page" button straddling a card's edge); the fit still frames `contentWidth`.
   */
  reachWidth?: number
  /**
   * Screen px below the top edge that the top of the content may be scrolled down to when floating
   * chrome covers the top of the view (the find bar: REVEAL_TOP_MARGIN); default the toolbar
   * margin. Raising it never moves the view; lowering it pulls a view past the new bound back up.
   */
  panTopReach?: number
  /** Set (a fresh object) when documents were just imported: fit and scroll to world y `focus.y`. */
  focus?: FitFocus | null
  dragging?: boolean
  onScaleChange?: (scale: number) => void
  onSettle?: () => void
  onBackgroundClick?: () => void
  /**
   * The viewport's css width — on mount, then on (debounced) resize; held back mid-drag. A resize
   * also re-fits a view the user hasn't moved, even when the width change doesn't re-wrap.
   */
  onViewportWidth?: (width: number) => void
  children: React.ReactNode
  overlay?: React.ReactNode
}

export const Canvas = forwardRef<CanvasHandle, CanvasProps>(function Canvas(
  {
    contentWidth,
    contentHeight,
    reachWidth = contentWidth,
    panTopReach,
    focus = null,
    dragging,
    onScaleChange,
    onSettle,
    onBackgroundClick,
    onViewportWidth,
    children,
    overlay
  },
  ref
) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const userMovedRef = useRef(false)
  const dims = useRef({ contentWidth, contentHeight })
  dims.current = { contentWidth, contentHeight }
  const draggingRef = useRef(dragging)
  draggingRef.current = dragging

  const { zoomRef, panBoundsRef, fitTransform } = useZoomBehavior({
    viewportRef,
    worldRef,
    overlayRef,
    userMovedRef,
    dims,
    onScaleChange,
    onSettle
  })

  const [viewportSize, setViewportSize] = useState<ViewportSize>({ width: 0, height: 0 })
  useViewportSize(viewportRef, !!dragging, (size) => {
    // Both updates land in one render: the re-wrapped layout and the new size re-fit together.
    setViewportSize(size)
    onViewportWidth?.(size.width)
  })

  const { refit, reveal, pendingTarget } = useAutoFit({
    viewportRef,
    zoomRef,
    panBoundsRef,
    userMovedRef,
    draggingRef,
    dragging: !!dragging,
    fitTransform,
    contentWidth,
    contentHeight,
    reachWidth,
    topReach: panTopReach,
    focus,
    viewportWidth: viewportSize.width,
    viewportHeight: viewportSize.height
  })

  useImperativeHandle(ref, () =>
    createCanvasHandle({
      viewportRef,
      zoomRef,
      userMovedRef,
      refit,
      draggingRef,
      reveal,
      pendingTarget,
      contentHeightRef: dims
    })
  )

  return (
    <div
      className="canvas-viewport"
      ref={viewportRef}
      onClick={(event) => {
        const target = event.target as Element
        if (
          !target.closest('.page') &&
          !target.closest('button') &&
          !target.closest('.doc-header')
        ) {
          onBackgroundClick?.()
        }
      }}
    >
      <div className="canvas-world" ref={worldRef}>
        {children}
      </div>
      <div className="canvas-overlay" ref={overlayRef}>
        {overlay}
      </div>
    </div>
  )
})
