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

  const { zoomRef, fitTransform } = useZoomBehavior({
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

  const { refit, reveal } = useAutoFit({
    viewportRef,
    zoomRef,
    userMovedRef,
    draggingRef,
    fitTransform,
    contentWidth,
    contentHeight,
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
