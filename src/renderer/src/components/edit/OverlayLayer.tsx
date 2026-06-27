import { useEffect, useRef, useState } from 'react'
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
  movePath,
  pageScale,
  pointToCss,
  rectGeom,
  resizeGeom,
  scalePath,
  type FitSize,
  type HandleId,
  type Pt
} from './overlay-geometry'

interface OverlayLayerProps {
  page: PageEntry
  fit: FitSize
  /** Editing is enabled only on the focused, settled page. */
  active: boolean
}

type Draft = { kind: 'highlight'; start: Pt; current: Pt } | { kind: 'ink'; pts: number[] }
type Drag = {
  kind: 'move' | 'resize'
  handle?: HandleId
  startPdf: Pt
  start: Overlay
  preview: Overlay
}

const HANDLES: HandleId[] = ['tl', 'tr', 'bl', 'br']

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

// Translate / rescale an overlay (and an ink stroke's points) by a drag.
function moveOverlay(o: Overlay, dx: number, dy: number): Overlay {
  const geom = { ...o.geom, x: o.geom.x + dx, y: o.geom.y + dy }
  if (o.type === 'ink') return { ...o, geom, paths: o.paths.map((p) => movePath(p, dx, dy)) }
  return { ...o, geom }
}
function resizeOverlay(o: Overlay, handle: HandleId, p: Pt): Overlay {
  const geom = resizeGeom(o.geom, handle, p)
  if (o.type === 'ink')
    return { ...o, geom, paths: o.paths.map((pa) => scalePath(pa, o.geom, geom)) }
  return { ...o, geom }
}
const geomEq = (a: Overlay['geom'], b: Overlay['geom']): boolean =>
  a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

export function OverlayLayer({ page, fit, active }: OverlayLayerProps): React.JSX.Element {
  const edits = useEdits()
  const { selectedId, select, setCurrentPage } = edits
  const layerRef = useRef<HTMLDivElement>(null)
  const urlCache = useRef<Map<string, string>>(new Map())
  const [draft, setDraft] = useState<Draft | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)

  const pageKey = makePageKey(page.source.id, page.pageIndex)
  const pageOverlays = overlaysForPage(edits.overlays, pageKey)
  const drawing = active && edits.tool !== 'browse'
  const selecting = active && edits.tool === 'browse'
  const scale = pageScale(page, fit)

  const toPdf = (clientX: number, clientY: number): Pt => {
    const rect = layerRef.current!.getBoundingClientRect()
    return clientToPdf(clientX, clientY, rect, page)
  }

  // Report this page as the placement target for palette actions (e.g. stamping).
  useEffect(() => {
    if (active) setCurrentPage({ pageKey, width: page.width, height: page.height })
  }, [active, pageKey, page.width, page.height, setCurrentPage])

  // Object URLs for image overlays, revoked on unmount.
  useEffect(() => {
    const cache = urlCache.current
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url)
      cache.clear()
    }
  }, [])
  const imageUrl = (attachmentId: string): string | null => {
    const cached = urlCache.current.get(attachmentId)
    if (cached) return cached
    const att = edits.attachments.get(attachmentId)
    if (!att) return null
    const url = URL.createObjectURL(new Blob([new Uint8Array(att.bytes)], { type: att.mime }))
    urlCache.current.set(attachmentId, url)
    return url
  }

  // Delete / deselect via keyboard while this page is focused.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') return select(null)
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault()
        edits.removeOverlay(selectedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, selectedId, edits, select])

  // ---- Drawing (highlight / ink) ----
  const onDrawDown = (e: React.PointerEvent): void => {
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
  const onDrawMove = (e: React.PointerEvent): void => {
    if (!draft) return
    e.stopPropagation()
    const p = toPdf(e.clientX, e.clientY)
    setDraft(
      draft.kind === 'highlight'
        ? { ...draft, current: p }
        : { kind: 'ink', pts: [...draft.pts, p.x, p.y] }
    )
  }
  const onDrawUp = (e: React.PointerEvent): void => {
    if (!draft) return
    e.stopPropagation()
    layerRef.current?.releasePointerCapture(e.pointerId)
    const base = { id: newOverlayId(), pageKey, z: pageOverlays.length, createdAt: Date.now() }
    if (draft.kind === 'highlight') {
      const geom = rectGeom(draft.start, draft.current, 0.4)
      if (geom.w > 2 && geom.h > 2)
        edits.addOverlay({ ...base, geom, type: 'highlight', color: edits.highlightColor })
    } else if (draft.pts.length >= 4) {
      edits.addOverlay({
        ...base,
        geom: boundsOfPath(draft.pts, 1),
        type: 'ink',
        paths: [draft.pts],
        strokeWidth: edits.inkWidth,
        color: edits.inkColor
      })
    }
    setDraft(null)
  }

  // ---- Select / move / resize ----
  const beginDrag = (
    e: React.PointerEvent,
    kind: 'move' | 'resize',
    handle: HandleId | undefined,
    o: Overlay
  ): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    select(o.id)
    setDrag({ kind, handle, startPdf: toPdf(e.clientX, e.clientY), start: o, preview: o })
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }
  const onDragMove = (e: React.PointerEvent): void => {
    if (!drag) return
    e.stopPropagation()
    const p = toPdf(e.clientX, e.clientY)
    const preview =
      drag.kind === 'move'
        ? moveOverlay(drag.start, p.x - drag.startPdf.x, p.y - drag.startPdf.y)
        : resizeOverlay(drag.start, drag.handle!, p)
    setDrag({ ...drag, preview })
  }
  const onDragEnd = (e: React.PointerEvent): void => {
    if (!drag) return
    e.stopPropagation()
    ;(e.currentTarget as Element).releasePointerCapture?.(e.pointerId)
    if (!geomEq(drag.preview.geom, drag.start.geom)) edits.replaceOverlay(drag.preview)
    setDrag(null)
  }

  const effective = (o: Overlay): Overlay => (drag && drag.preview.id === o.id ? drag.preview : o)

  const renderVisual = (o: Overlay): React.JSX.Element | null => {
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
    if (o.type === 'image') {
      const r = geomToCss(o.geom, page, fit)
      const url = imageUrl(o.attachmentId)
      if (!url) return null
      return (
        <img
          key={o.id}
          className="ov-image"
          src={url}
          draggable={false}
          style={{
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height,
            opacity: o.geom.opacity
          }}
        />
      )
    }
    return null
  }

  const renderChrome = (o: Overlay): React.JSX.Element => {
    const r = geomToCss(o.geom, page, fit)
    const isSel = o.id === selectedId
    return (
      <div key={`hit-${o.id}`}>
        <div
          className="ov-hitbox"
          style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
          onPointerDown={(e) => beginDrag(e, 'move', undefined, o)}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        />
        {isSel && (
          <>
            <div
              className="ov-selected"
              style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
            />
            {HANDLES.map((h) => (
              <div
                key={h}
                className={`ov-handle ov-handle-${h}`}
                style={{
                  left: r.left + (h === 'tr' || h === 'br' ? r.width : 0),
                  top: r.top + (h === 'bl' || h === 'br' ? r.height : 0)
                }}
                onPointerDown={(e) => beginDrag(e, 'resize', h, o)}
                onPointerMove={onDragMove}
                onPointerUp={onDragEnd}
                onPointerCancel={onDragEnd}
              />
            ))}
            <button
              className="ov-delete"
              style={{ left: r.left + r.width, top: r.top }}
              title="Delete (Del)"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                edits.removeOverlay(o.id)
              }}
            >
              ×
            </button>
          </>
        )}
      </div>
    )
  }

  return (
    <div
      ref={layerRef}
      className={`overlay-layer${drawing ? ' drawing' : ''}`}
      style={{ pointerEvents: drawing ? 'auto' : 'none' }}
      onPointerDown={onDrawDown}
      onPointerMove={onDrawMove}
      onPointerUp={onDrawUp}
      onPointerCancel={onDrawUp}
    >
      {pageOverlays.map((o) => renderVisual(effective(o)))}
      {selecting && pageOverlays.map((o) => renderChrome(effective(o)))}
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
