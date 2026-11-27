import { forwardRef, useImperativeHandle, useRef } from 'react'
import { useZoomBehavior } from '../canvas/use-zoom-behavior'
import { useAutoFit, type FitFocus } from '../canvas/use-auto-fit'
import { useViewportWidth } from '../canvas/use-viewport-width'
import { createCanvasHandle } from '../canvas/canvas-handle'

export interface CanvasHandle {
  zoomIn(): void
  zoomOut(): void
  reset(): void
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
  /** The viewport's css width — on mount, then on (debounced) resize; held back mid-drag. */
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

  useViewportWidth(viewportRef, !!dragging, onViewportWidth)

  const { refit } = useAutoFit({
    viewportRef,
    zoomRef,
    userMovedRef,
    draggingRef,
    fitTransform,
    contentWidth,
    contentHeight,
    focus
  })

  useImperativeHandle(ref, () => createCanvasHandle({ viewportRef, zoomRef, userMovedRef, refit }))

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
