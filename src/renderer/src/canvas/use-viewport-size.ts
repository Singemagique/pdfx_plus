import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

const RESIZE_DEBOUNCE_MS = 100

export interface ViewportSize {
  width: number
  height: number
}

/**
 * Report the viewport's css size: once synchronously on mount (before first paint, so the first
 * wrap and fit are already the right ones), then on resize, debounced. While `dragging` the latest
 * size is held back and delivered when the drag ends — re-wrapping or re-fitting mid-drag would
 * move every drop target out from under the cursor.
 */
export function useViewportSize(
  viewportRef: RefObject<HTMLDivElement | null>,
  dragging: boolean,
  onSize: (size: ViewportSize) => void
): void {
  const onSizeRef = useRef(onSize)
  onSizeRef.current = onSize
  const draggingRef = useRef(dragging)
  draggingRef.current = dragging
  const last = useRef<ViewportSize>({ width: 0, height: 0 })
  const pending = useRef<ViewportSize | null>(null)

  const report = useRef((size: ViewportSize): void => {
    if (size.width <= 0) return
    if (draggingRef.current) {
      pending.current = size
      return
    }
    pending.current = null
    if (size.width === last.current.width && size.height === last.current.height) return
    last.current = size
    onSizeRef.current(size)
  })

  useLayoutEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const measure = (): ViewportSize => ({ width: vp.clientWidth, height: vp.clientHeight })
    report.current(measure())
    if (typeof ResizeObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => report.current(measure()), RESIZE_DEBOUNCE_MS)
    })
    observer.observe(vp)
    return () => {
      observer.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (!dragging && pending.current !== null) report.current(pending.current)
  }, [dragging])
}
