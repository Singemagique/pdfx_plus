import { useRef, useState } from 'react'
import type { PageEntry } from '../../types'
import {
  makePageKey,
  newOverlayId,
  overlaysForPage,
  type Overlay,
  type RGB
} from '../../edit/model'
import { useEdits } from '../../edit/EditProvider'
import {
  boundsOfPath,
  clientToPdf,
  geomToCss,
  pageScale,
  pointToCss,
  rectGeom,
  type FitSize,
  type Pt
} from './overlay-geometry'

interface OverlayLayerProps {
  page: PageEntry
  fit: FitSize
  /** Drawing is enabled only on the focused, settled page. */
  active: boolean
}

type Draft = { kind: 'highlight'; start: Pt; current: Pt } | { kind: 'ink'; pts: number[] }

const cssColor = (c: RGB): string =>
  `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`
const cssRgba = (c: RGB, a: number): string =>
  `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${a})`

function pathToPoints(path: number[], page: PageEntry, fit: FitSize): string {
  const out: string[] = []
  for (let i = 0; i + 1 < path.length; i += 2) {
    const p = pointToCss(path[i], path[i + 1], page, fit)
    out.push(`${p.x},${p.y}`)
  }
  return out.join(' ')
}

export function OverlayLayer({ page, fit, active }: OverlayLayerProps): React.JSX.Element {
  const edits = useEdits()
  const layerRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<Draft | null>(null)

  const pageKey = makePageKey(page.source.id, page.pageIndex)
  const pageOverlays = overlaysForPage(edits.overlays, pageKey)
  const drawing = active && edits.tool !== 'browse'
  const scale = pageScale(page, fit)

  const toPdf = (clientX: number, clientY: number): Pt => {
    const rect = layerRef.current!.getBoundingClientRect()
    return clientToPdf(clientX, clientY, rect, page)
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (!drawing || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const p = toPdf(e.clientX, e.clientY)
    setDraft(
      edits.tool === 'highlight'
        ? { kind: 'highlight', start: p, current: p }
        : { kind: 'ink', pts: [p.x, p.y] }
    )
    layerRef.current?.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!draft) return
    e.stopPropagation()
    const p = toPdf(e.clientX, e.clientY)
    setDraft(
      draft.kind === 'highlight'
        ? { ...draft, current: p }
        : { kind: 'ink', pts: [...draft.pts, p.x, p.y] }
    )
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    if (!draft) return
    e.stopPropagation()
    layerRef.current?.releasePointerCapture(e.pointerId)
    const z = pageOverlays.length
    const baseFields = { id: newOverlayId(), pageKey, z, createdAt: Date.now() }
    if (draft.kind === 'highlight') {
      const geom = rectGeom(draft.start, draft.current, 0.4)
      if (geom.w > 2 && geom.h > 2) {
        edits.addOverlay({ ...baseFields, geom, type: 'highlight', color: edits.highlightColor })
      }
    } else if (draft.pts.length >= 4) {
      edits.addOverlay({
        ...baseFields,
        geom: boundsOfPath(draft.pts, 1),
        type: 'ink',
        paths: [draft.pts],
        strokeWidth: edits.inkWidth,
        color: edits.inkColor
      })
    }
    setDraft(null)
  }

  const renderOverlay = (o: Overlay): React.JSX.Element | null => {
    if (o.type === 'highlight') {
      const r = geomToCss(o.geom, page, fit)
      return (
        <div
          key={o.id}
          className="ov-highlight"
          style={{
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height,
            background: cssRgba(o.color, o.geom.opacity)
          }}
        />
      )
    }
    if (o.type === 'ink') {
      return (
        <svg key={o.id} className="ov-vector" width={fit.w} height={fit.h}>
          {o.paths.map((path, i) => (
            <polyline
              key={i}
              points={pathToPoints(path, page, fit)}
              fill="none"
              stroke={cssColor(o.color)}
              strokeWidth={o.strokeWidth * scale}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
        </svg>
      )
    }
    return null
  }

  return (
    <div
      ref={layerRef}
      className={`overlay-layer${drawing ? ' drawing' : ''}`}
      style={{ pointerEvents: drawing ? 'auto' : 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {pageOverlays.map(renderOverlay)}
      {draft?.kind === 'highlight' &&
        (() => {
          const r = geomToCss(rectGeom(draft.start, draft.current, 1), page, fit)
          return (
            <div
              className="ov-draft-rect"
              style={{
                left: r.left,
                top: r.top,
                width: r.width,
                height: r.height,
                background: cssRgba(edits.highlightColor, 0.3)
              }}
            />
          )
        })()}
      {draft?.kind === 'ink' && (
        <svg className="ov-vector" width={fit.w} height={fit.h}>
          <polyline
            points={pathToPoints(draft.pts, page, fit)}
            fill="none"
            stroke={cssColor(edits.inkColor)}
            strokeWidth={edits.inkWidth * scale}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      )}
    </div>
  )
}
