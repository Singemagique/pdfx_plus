import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'

// Always-present low-res raster of the whole page (the fallback shown while
// moving / before the crisp layer renders). Long side, in device pixels.
const BASE_RASTER = 1100
// Cap the crisp detail canvas to ~a screenful so memory/GPU stay bounded at any
// zoom — this is what lets text stay sharp without huge full-page canvases.
const MAX_DETAIL = 4096

interface PageViewProps {
  pdf: PDFDocumentProxy
  pageNumber: number
  /** Natural page size in PDF points (for aspect + render scale). */
  naturalWidth: number
  naturalHeight: number
  /** Bumped on zoom/pan settle to re-render the crisp visible-region layer. */
  version: number
}

const dpr = (): number => Math.min(window.devicePixelRatio || 1, 2)

/**
 * Renders a PDF page in two layers:
 *  - a low-res full-page "base" raster (always present, scales/blurs with zoom),
 *  - a "detail" raster of just the currently-visible region at device
 *    resolution, refreshed whenever the view settles.
 * The detail layer is what keeps text vector-sharp at any zoom (like Preview),
 * while staying memory-bounded because it never exceeds ~one screenful.
 */
export function PageView({
  pdf,
  pageNumber,
  naturalWidth,
  naturalHeight,
  version
}: PageViewProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const baseRef = useRef<HTMLCanvasElement>(null)
  const detailRef = useRef<HTMLCanvasElement>(null)
  const [near, setNear] = useState(false)
  const [baseReady, setBaseReady] = useState(false)

  // Only do any work once the page is near the viewport.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true)
          observer.disconnect()
        }
      },
      { rootMargin: '300px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Base full-page raster (rendered once).
  useEffect(() => {
    if (!near) return
    let cancelled = false
    let task: RenderTask | null = null
    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber)
        if (cancelled) return
        const scale = BASE_RASTER / Math.max(naturalWidth, naturalHeight)
        const viewport = page.getViewport({ scale })
        const off = document.createElement('canvas')
        off.width = Math.max(1, Math.floor(viewport.width))
        off.height = Math.max(1, Math.floor(viewport.height))
        task = page.render({ canvas: off, viewport })
        await task.promise
        if (cancelled) return
        const canvas = baseRef.current
        if (!canvas) return
        canvas.width = off.width
        canvas.height = off.height
        canvas.getContext('2d')!.drawImage(off, 0, 0)
        setBaseReady(true)
      } catch (error) {
        if ((error as Error)?.name !== 'RenderingCancelledException') {
          console.error(`Failed to render page ${pageNumber}`, error)
        }
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [near, pdf, pageNumber, naturalWidth, naturalHeight])

  // Crisp detail layer: re-render the on-screen region at device resolution
  // whenever the view settles (version bump) or the page becomes visible.
  useEffect(() => {
    if (!near) return
    const root = rootRef.current
    const detail = detailRef.current
    if (!root || !detail) return

    const rect = root.getBoundingClientRect()
    const winW = window.innerWidth
    const winH = window.innerHeight
    const visLeft = Math.max(0, rect.left)
    const visTop = Math.max(0, rect.top)
    const visRight = Math.min(winW, rect.right)
    const visBottom = Math.min(winH, rect.bottom)
    const visW = visRight - visLeft
    const visH = visBottom - visTop

    // Skip when off-screen, or when the base raster already has enough detail
    // for the page's current on-screen size (no point re-rendering at low zoom).
    const baseDevicePx = (BASE_RASTER / Math.max(naturalWidth, naturalHeight)) * naturalWidth
    if (visW <= 0 || visH <= 0 || rect.width * dpr() <= baseDevicePx * 1.05) {
      detail.style.display = 'none'
      return
    }

    let cancelled = false
    let task: RenderTask | null = null
    void (async () => {
      try {
        const d = dpr()
        // Render scale = current on-screen page resolution (device px / point),
        // reduced by capFactor if the visible region would exceed MAX_DETAIL.
        const capFactor = Math.min(1, MAX_DETAIL / (visW * d), MAX_DETAIL / (visH * d))
        const renderScale = (rect.width / naturalWidth) * d * capFactor

        const page = await pdf.getPage(pageNumber)
        if (cancelled) return
        const viewport = page.getViewport({ scale: renderScale })
        const fx0 = (visLeft - rect.left) / rect.width
        const fy0 = (visTop - rect.top) / rect.height
        const backingW = Math.max(1, Math.round(visW * d * capFactor))
        const backingH = Math.max(1, Math.round(visH * d * capFactor))

        const off = document.createElement('canvas')
        off.width = backingW
        off.height = backingH
        task = page.render({
          canvas: off,
          viewport,
          // Shift so the visible region's top-left lands at the canvas origin.
          transform: [1, 0, 0, 1, -fx0 * viewport.width, -fy0 * viewport.height]
        })
        await task.promise
        if (cancelled) return

        detail.width = backingW
        detail.height = backingH
        detail.getContext('2d')!.drawImage(off, 0, 0)
        // Position in the page's local coordinate space (ancestor transforms
        // then scale it back onto the visible region on screen).
        const effScale = rect.width / root.offsetWidth || 1
        detail.style.display = 'block'
        detail.style.left = `${(visLeft - rect.left) / effScale}px`
        detail.style.top = `${(visTop - rect.top) / effScale}px`
        detail.style.width = `${visW / effScale}px`
        detail.style.height = `${visH / effScale}px`
      } catch (error) {
        if ((error as Error)?.name !== 'RenderingCancelledException') {
          console.error(`Failed to render detail for page ${pageNumber}`, error)
        }
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [near, version, pdf, pageNumber, naturalWidth, naturalHeight])

  return (
    <div className="pageview" ref={rootRef}>
      <canvas ref={baseRef} className={baseReady ? 'pageview-base ready' : 'pageview-base'} />
      <canvas ref={detailRef} className="pageview-detail" style={{ display: 'none' }} />
    </div>
  )
}
