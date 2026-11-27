import { memo, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { logRenderError, renderBase, renderDetail } from './page-view/raster'
import { detailDpr, planDetail } from './page-view/detail-geometry'
import type { WindowFractions } from '../page-geometry'

interface PageViewProps {
  pdf: PDFDocumentProxy
  pageNumber: number
  naturalWidth: number
  naturalHeight: number
  version: number
  eager?: boolean
  detail?: boolean
  /** CSS rotation (degrees) an ancestor applies to this upright page box; the detail canvas
   *  needs it to map the on-screen bounding box back to upright page coordinates. */
  rotation?: number
  /** The only part of the page that is shown (a crop window), as page fractions. The box still lays
   *  out the FULL page — an ancestor clips it — so this only says which part needs pixels. */
  clip?: WindowFractions | null
}

function PageViewImpl({
  pdf,
  pageNumber,
  naturalWidth,
  naturalHeight,
  version,
  eager = false,
  detail = true,
  rotation = 0,
  clip
}: PageViewProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const baseRef = useRef<HTMLCanvasElement>(null)
  const detailRef = useRef<HTMLCanvasElement>(null)
  const [near, setNear] = useState(eager)
  const [baseReady, setBaseReady] = useState(false)
  // Effects key on the clip's primitives: callers pass a fresh object every render.
  const cx0 = clip?.x0
  const cy0 = clip?.y0
  const cx1 = clip?.x1
  const cy1 = clip?.y1

  useEffect(() => {
    if (eager) return
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
  }, [eager])

  useEffect(() => {
    if (!near) return
    let cancelled = false
    let task: RenderTask | null = null
    const c = cx0 === undefined ? null : { x0: cx0, y0: cy0!, x1: cx1!, y1: cy1! }
    void renderBase({
      pdf,
      pageNumber,
      naturalWidth,
      naturalHeight,
      baseRef,
      clip: c,
      isCancelled: () => cancelled,
      onTask: (t) => (task = t),
      onReady: () => setBaseReady(true)
    }).catch(logRenderError(`Failed to render page ${pageNumber}`))
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [near, pdf, pageNumber, naturalWidth, naturalHeight, cx0, cy0, cx1, cy1])

  useEffect(() => {
    if (!near) return
    const root = rootRef.current
    const detailCanvas = detailRef.current
    if (!root || !detailCanvas) return
    if (!detail) {
      detailCanvas.style.display = 'none'
      return
    }

    const plan = planDetail({
      rect: root.getBoundingClientRect(),
      layoutW: root.offsetWidth,
      rotation,
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
      naturalWidth,
      naturalHeight,
      dpr: detailDpr(window.devicePixelRatio),
      clip: cx0 === undefined ? null : { x0: cx0, y0: cy0!, x1: cx1!, y1: cy1! }
    })
    if (!plan) {
      detailCanvas.style.display = 'none'
      return
    }

    let cancelled = false
    let task: RenderTask | null = null
    void renderDetail({
      pdf,
      pageNumber,
      plan,
      detailCanvas,
      isCancelled: () => cancelled,
      onTask: (t) => (task = t)
    }).catch(logRenderError(`Failed to render detail for page ${pageNumber}`))
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [
    near,
    version,
    detail,
    rotation,
    pdf,
    pageNumber,
    naturalWidth,
    naturalHeight,
    cx0,
    cy0,
    cx1,
    cy1
  ])

  return (
    <div className="pageview" ref={rootRef}>
      <canvas ref={baseRef} className={baseReady ? 'pageview-base ready' : 'pageview-base'} />
      <canvas ref={detailRef} className="pageview-detail" style={{ display: 'none' }} />
    </div>
  )
}

export const PageView = memo(PageViewImpl)
