import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

const RESIZE_DEBOUNCE_MS = 100

/**
 * Report the viewport's css width: once synchronously on mount (before first paint, so the first
 * wrap is already the right one), then on resize, debounced. While `dragging` the latest width is
 * held back and delivered when the drag ends — re-wrapping mid-drag would move every drop target
 * out from under the cursor.
 */
export function useViewportWidth(
  viewportRef: RefObject<HTMLDivElement | null>,
  dragging: boolean,
  onWidth: ((width: number) => void) | undefined
): void {
  const onWidthRef = useRef(onWidth)
  onWidthRef.current = onWidth
  const draggingRef = useRef(dragging)
  draggingRef.current = dragging
  const last = useRef(0)
  const pending = useRef<number | null>(null)

  const report = useRef((width: number): void => {
    if (width <= 0) return
    if (draggingRef.current) {
      pending.current = width
      return
    }
    pending.current = null
    if (width === last.current) return
    last.current = width
    onWidthRef.current?.(width)
  })

  useLayoutEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    report.current(vp.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => report.current(vp.clientWidth), RESIZE_DEBOUNCE_MS)
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
