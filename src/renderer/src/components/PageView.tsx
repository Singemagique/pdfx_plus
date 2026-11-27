import { memo, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { logRenderError, renderBase, renderDetail } from './page-view/raster'
import { detailDpr, planDetail } from './page-view/detail-geometry'

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
}

function PageViewImpl({
  pdf,
  pageNumber,
  naturalWidth,
  naturalHeight,
  version,
  eager = false,
  detail = true,
  rotation = 0
}: PageViewProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const baseRef = useRef<HTMLCanvasElement>(null)
  const detailRef = useRef<HTMLCanvasElement>(null)
  const [near, setNear] = useState(eager)
  const [baseReady, setBaseReady] = useState(false)

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
    void renderBase({
      pdf,
      pageNumber,
      naturalWidth,
      naturalHeight,
      baseRef,
      isCancelled: () => cancelled,
      onTask: (t) => (task = t),
      onReady: () => setBaseReady(true)
    }).catch(logRenderError(`Failed to render page ${pageNumber}`))
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [near, pdf, pageNumber, naturalWidth, naturalHeight])

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
      dpr: detailDpr(window.devicePixelRatio)
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
  }, [near, version, detail, rotation, pdf, pageNumber, naturalWidth, naturalHeight])

  return (
    <div className="pageview" ref={rootRef}>
      <canvas ref={baseRef} className={baseReady ? 'pageview-base ready' : 'pageview-base'} />
      <canvas ref={detailRef} className="pageview-detail" style={{ display: 'none' }} />
    </div>
  )
}

export const PageView = memo(PageViewImpl)
