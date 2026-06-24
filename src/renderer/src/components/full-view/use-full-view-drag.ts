import type { View } from './geometry'
import { clamp } from './geometry'

interface DragOptions {
  drag: React.MutableRefObject<{ x: number; y: number; panX: number; panY: number } | null>
  draggedRef: React.MutableRefObject<boolean>
  view: View
  fit: { w: number; h: number }
  vw: number
  vh: number
  zoomed: boolean
  interactive: boolean
  setView: React.Dispatch<React.SetStateAction<View>>
}

interface DragHandlers {
  onPointerDown: (event: React.PointerEvent) => void
  onPointerMove: (event: React.PointerEvent) => void
  endDrag: (event: React.PointerEvent) => void
}

export function useFullViewDrag(opts: DragOptions): DragHandlers {
  const { drag, draggedRef, view, fit, vw, vh, zoomed, interactive, setView } = opts

  const onPointerDown = (event: React.PointerEvent): void => {
    if (!zoomed || !interactive) return
    drag.current = { x: event.clientX, y: event.clientY, panX: view.x, panY: view.y }
    draggedRef.current = false
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    if (Math.abs(event.clientX - d.x) > 3 || Math.abs(event.clientY - d.y) > 3) {
      draggedRef.current = true
    }
    setView((v) => {
      const maxX = Math.max(0, (fit.w * v.zoom - vw) / 2)
      const maxY = Math.max(0, (fit.h * v.zoom - vh) / 2)
      return {
        ...v,
        x: clamp(d.panX + (event.clientX - d.x), -maxX, maxX),
        y: clamp(d.panY + (event.clientY - d.y), -maxY, maxY)
      }
    })
  }
  const endDrag = (event: React.PointerEvent): void => {
    if (!drag.current) return
    drag.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  return { onPointerDown, onPointerMove, endDrag }
}
