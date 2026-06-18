import { useCallback, useEffect, useRef, useState } from 'react'
import type { DocEntry } from '../types'
import { PageView } from './PageView'

interface FullViewProps {
  doc: DocEntry
  startPageId: string
  onClose: () => void
}

const isMac = window.api.platform === 'darwin'
const MAX_ZOOM = 8
const WHEEL_ZOOM_SPEED = 0.036 // ~3x faster pinch zoom
const ZOOM_STEP = 1.4
const DOUBLE_CLICK_ZOOM = 2.5

/**
 * Full-screen single-page viewer. The page fills 100% of the viewport height;
 * pinch / ⌘-wheel zooms toward the center (keeping the page centered, like
 * macOS Preview), and panning kicks in once the page overflows the viewport.
 */
export function FullView({ doc, startPageId, onClose }: FullViewProps): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null)
  const wheelLock = useRef(0)
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const [current, setCurrent] = useState(() =>
    Math.max(
      0,
      doc.pages.findIndex((p) => p.id === startPageId)
    )
  )
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight })
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  // Bumped ~once the view settles, so the page re-renders crisp (see PageView).
  const [renderVersion, setRenderVersion] = useState(0)

  const index = Math.min(current, doc.pages.length - 1)
  const page = doc.pages[index]
  // Fit to 100% viewport height; width follows the aspect ratio.
  const baseH = viewport.h
  const baseW = (page.width / page.height) * baseH
  const dispW = baseW * zoom
  const dispH = baseH * zoom
  const canPan = dispW > viewport.w + 1 || dispH > viewport.h + 1

  useEffect(() => {
    const onResize = (): void => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Keep the page from being dragged fully off-screen.
  const clampPan = useCallback(
    (p: { x: number; y: number }, z: number) => {
      const maxX = Math.max(0, (baseW * z - viewport.w) / 2)
      const maxY = Math.max(0, (baseH * z - viewport.h) / 2)
      return {
        x: Math.min(maxX, Math.max(-maxX, p.x)),
        y: Math.min(maxY, Math.max(-maxY, p.y))
      }
    },
    [baseW, baseH, viewport.w, viewport.h]
  )

  const resetView = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  const goTo = useCallback(
    (next: number) => {
      setCurrent(Math.max(0, Math.min(doc.pages.length - 1, next)))
      resetView()
    },
    [doc.pages.length, resetView]
  )

  // Zoom toward a focal point (the cursor) so the point under it stays fixed —
  // consistent with the canvas and macOS Preview. Defaults to viewport center.
  const zoomTo = useCallback(
    (next: number, focal?: { x: number; y: number }) => {
      const cx = focal ? focal.x : viewport.w / 2
      const cy = focal ? focal.y : viewport.h / 2
      setZoom((z) => {
        const nz = Math.max(1, Math.min(MAX_ZOOM, next))
        const r = nz / z
        const dx = cx - viewport.w / 2
        const dy = cy - viewport.h / 2
        setPan((p) => clampPan({ x: dx * (1 - r) + r * p.x, y: dy * (1 - r) + r * p.y }, nz))
        return nz
      })
    },
    [clampPan, viewport.w, viewport.h]
  )

  // Re-render the page crisply once a zoom/pan gesture settles.
  useEffect(() => {
    const timer = setTimeout(() => setRenderVersion((v) => v + 1), 180)
    return () => clearTimeout(timer)
  }, [zoom, pan])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowRight') goTo(index + 1)
      else if (event.key === 'ArrowLeft') goTo(index - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, goTo, onClose])

  // Menu zoom (⌘ +/-/0) is routed here while the viewer is open (App skips the
  // canvas zoom when a full view is showing).
  useEffect(() => {
    return window.api.onZoom((action) => {
      if (action === 'in') zoomTo(zoom * ZOOM_STEP)
      else if (action === 'out') zoomTo(zoom / ZOOM_STEP)
      else resetView()
    })
  }, [zoom, zoomTo, resetView])

  // Wheel: pinch/⌘ zooms; plain wheel pans when zoomed, else flips pages.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        const dy = Math.max(-50, Math.min(50, event.deltaY))
        zoomTo(zoom * Math.pow(2, -dy * WHEEL_ZOOM_SPEED), { x: event.clientX, y: event.clientY })
        return
      }
      if (canPan) {
        event.preventDefault()
        setPan((p) => clampPan({ x: p.x - event.deltaX, y: p.y - event.deltaY }, zoom))
        return
      }
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      event.preventDefault()
      const now = Date.now()
      if (now - wheelLock.current < 250) return
      wheelLock.current = now
      goTo(index + (event.deltaY > 0 ? 1 : -1))
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [zoom, canPan, index, zoomTo, clampPan, goTo])

  const onPointerDown = (event: React.PointerEvent): void => {
    if (!canPan) return
    drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    setPan(clampPan({ x: d.panX + (event.clientX - d.x), y: d.panY + (event.clientY - d.y) }, zoom))
  }
  const endDrag = (event: React.PointerEvent): void => {
    if (!drag.current) return
    drag.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  return (
    <div className="full-view">
      <header className={`full-bar${isMac ? ' mac' : ''}`}>
        <span className="full-title">{doc.name}</span>
        <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </header>

      <div
        className={`full-stage${canPan ? ' pannable' : ''}`}
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <div
          key={page.id}
          className="full-page"
          style={{ width: dispW, height: dispH, transform: `translate(${pan.x}px, ${pan.y}px)` }}
          onDoubleClick={(e) =>
            zoom > 1 ? resetView() : zoomTo(DOUBLE_CLICK_ZOOM, { x: e.clientX, y: e.clientY })
          }
        >
          <PageView
            pdf={page.source.pdf}
            pageNumber={page.pageIndex + 1}
            naturalWidth={page.width}
            naturalHeight={page.height}
            version={renderVersion}
          />
        </div>
      </div>

      <button
        className="full-nav prev"
        disabled={index === 0}
        onClick={() => goTo(index - 1)}
        title="Previous page (←)"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>
      <button
        className="full-nav next"
        disabled={index === doc.pages.length - 1}
        onClick={() => goTo(index + 1)}
        title="Next page (→)"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
      </button>

      <div className="full-count">
        {index + 1} / {doc.pages.length}
      </div>
    </div>
  )
}
