import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PageEntry } from '../../types'
import {
  makePageKey,
  newOverlayId,
  overlaysForPage,
  type Geom,
  type Overlay,
  type RGB,
  type StandardFontName,
  type TextAlign
} from '../../edit/model'
import { useEdits } from '../../edit/EditProvider'
import {
  boundsOfPath,
  clientToPdfRotated,
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
  /** Upright CSS size of the page box (before any rotation transform). */
  fit: FitSize
  /** Page rotation in degrees CW (0/90/180/270). */
  rot: number
  /** Editing is enabled only on the focused, settled page. */
  active: boolean
}

type Draft =
  | { kind: 'highlight'; start: Pt; current: Pt }
  | { kind: 'ink'; pts: number[] }
  | { kind: 'shape'; start: Pt; current: Pt }
type Drag = {
  kind: 'move' | 'resize'
  handle?: HandleId
  startPdf: Pt
  start: Overlay
  preview: Overlay
}
type TextEdit = {
  id: string | null // null = a new box, else the overlay being re-edited
  geom: Geom
  value: string
  fontSize: number
  color: RGB
  font: StandardFontName
  align: TextAlign
}

const HANDLES: HandleId[] = ['tl', 'tr', 'bl', 'br']
const TEXT_COLOR: RGB = { r: 0.1, g: 0.1, b: 0.12 }
const TEXT_SIZE = 14
const TEXT_WIDTH = 220 // default text box width, PDF points
const LINE = 1.25

const fontCss = (f: StandardFontName): string =>
  f === 'Times'
    ? '"Times New Roman", Times, serif'
    : f === 'Courier'
      ? '"Courier New", monospace'
      : 'Helvetica, Arial, sans-serif'

const cssColor = (c: RGB): string =>
  `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`
const cssRgba = (c: RGB, a: number): string =>
  `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${a})`

// Text box height (PDF) for N lines, keeping its top edge fixed.
function textGeom(base: Geom, value: string, fontSize: number): Geom {
  const lines = value.split('\n').length
  const h = Math.max(fontSize * 1.4, lines * fontSize * LINE)
  return { ...base, y: base.y + base.h - h, h }
}

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
  if (o.type === 'shape' && o.points) return { ...o, geom, points: movePath(o.points, dx, dy) }
  return { ...o, geom }
}
function resizeOverlay(o: Overlay, handle: HandleId, p: Pt): Overlay {
  const geom = resizeGeom(o.geom, handle, p)
  if (o.type === 'ink')
    return { ...o, geom, paths: o.paths.map((pa) => scalePath(pa, o.geom, geom)) }
  if (o.type === 'shape' && o.points)
    return { ...o, geom, points: scalePath(o.points, o.geom, geom) }
  return { ...o, geom }
}
const geomEq = (a: Overlay['geom'], b: Overlay['geom']): boolean =>
  a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

export function OverlayLayer({ page, fit, rot, active }: OverlayLayerProps): React.JSX.Element {
  const edits = useEdits()
  const { selectedId, select, setCurrentPage } = edits
  const layerRef = useRef<HTMLDivElement>(null)
  const urlCache = useRef<Map<string, string>>(new Map())
  const [draft, setDraft] = useState<Draft | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null)

  const pageKey = makePageKey(page.source.id, page.pageIndex)
  const pageOverlays = overlaysForPage(edits.overlays, pageKey)
  const drawing =
    active && (edits.tool === 'highlight' || edits.tool === 'ink' || edits.tool === 'shape')
  const placing = active && edits.tool === 'text'
  const selecting = active && edits.tool === 'browse'
  const capturing = drawing || placing
  const scale = pageScale(page, fit)

  const toPdf = (clientX: number, clientY: number): Pt => {
    const rect = layerRef.current!.getBoundingClientRect()
    return clientToPdfRotated(clientX, clientY, rect, fit, page, rot)
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
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return
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
        : edits.tool === 'shape'
          ? { kind: 'shape', start: p, current: p }
          : { kind: 'ink', pts: [p.x, p.y] }
    )
    layerRef.current?.setPointerCapture(e.pointerId)
  }
  const onDrawMove = (e: React.PointerEvent): void => {
    if (!draft) return
    e.stopPropagation()
    const p = toPdf(e.clientX, e.clientY)
    setDraft(
      draft.kind === 'ink'
        ? { kind: 'ink', pts: [...draft.pts, p.x, p.y] }
        : { ...draft, current: p }
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
    } else if (draft.kind === 'shape') {
      const geom = rectGeom(draft.start, draft.current, 1)
      const isLine = edits.shapeKind === 'line' || edits.shapeKind === 'arrow'
      if (geom.w > 2 || geom.h > 2) {
        edits.addOverlay({
          ...base,
          geom,
          type: 'shape',
          shape: edits.shapeKind,
          color: edits.shapeColor,
          strokeWidth: edits.shapeWidth,
          ...(isLine
            ? { points: [draft.start.x, draft.start.y, draft.current.x, draft.current.y] }
            : {})
        })
      }
    } else if (draft.kind === 'ink' && draft.pts.length >= 4) {
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

  // ---- Text ----
  const onLayerDown = (e: React.PointerEvent): void => {
    if (drawing) return onDrawDown(e)
    if (placing && !textEdit && e.button === 0) {
      e.stopPropagation()
      e.preventDefault()
      const p = toPdf(e.clientX, e.clientY)
      const h = TEXT_SIZE * 1.4
      setTextEdit({
        id: null,
        value: '',
        fontSize: TEXT_SIZE,
        color: TEXT_COLOR,
        font: 'Helvetica',
        align: 'left',
        geom: { x: p.x, y: p.y - h, w: TEXT_WIDTH, h, rotation: 0, opacity: 1 }
      })
    }
  }

  const commitText = (): void => {
    const te = textEdit
    if (!te) return
    setTextEdit(null)
    const value = te.value.replace(/[ \t]+$/gm, '').replace(/\n+$/, '')
    if (!value.trim()) {
      if (te.id) edits.removeOverlay(te.id)
      return
    }
    const geom = textGeom(te.geom, value, te.fontSize)
    const fields = {
      type: 'text' as const,
      text: value,
      fontSize: te.fontSize,
      color: te.color,
      font: te.font,
      align: te.align
    }
    if (te.id) {
      const existing = edits.overlays.find((o) => o.id === te.id)
      if (existing) edits.replaceOverlay({ ...existing, geom, ...fields })
    } else {
      const id = newOverlayId()
      edits.addOverlay({
        id,
        pageKey,
        z: pageOverlays.length,
        createdAt: Date.now(),
        geom,
        ...fields
      })
    }
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
    if (o.type === 'shape') {
      const r = geomToCss(o.geom, page, fit)
      const sw = o.strokeWidth * scale
      const stroke = cssColor(o.color)
      let el: ReactNode
      if (o.shape === 'rect') {
        el = (
          <rect
            x={r.left}
            y={r.top}
            width={r.width}
            height={r.height}
            fill="none"
            stroke={stroke}
            strokeWidth={sw}
          />
        )
      } else if (o.shape === 'ellipse') {
        el = (
          <ellipse
            cx={r.left + r.width / 2}
            cy={r.top + r.height / 2}
            rx={r.width / 2}
            ry={r.height / 2}
            fill="none"
            stroke={stroke}
            strokeWidth={sw}
          />
        )
      } else if (o.shape === 'underline' || o.shape === 'strike') {
        const yy = o.shape === 'underline' ? r.top + r.height : r.top + r.height / 2
        el = (
          <line
            x1={r.left}
            y1={yy}
            x2={r.left + r.width}
            y2={yy}
            stroke={stroke}
            strokeWidth={sw}
            strokeLinecap="round"
          />
        )
      } else {
        const pts = o.points ?? [o.geom.x, o.geom.y + o.geom.h, o.geom.x + o.geom.w, o.geom.y]
        const a = pointToCss(pts[0], pts[1], page, fit)
        const b = pointToCss(pts[2], pts[3], page, fit)
        const lines: number[][] = [[a.x, a.y, b.x, b.y]]
        if (o.shape === 'arrow') {
          const ang = Math.atan2(b.y - a.y, b.x - a.x)
          const head = Math.max(8, sw * 3.5)
          for (const da of [2.5, -2.5])
            lines.push([b.x, b.y, b.x + head * Math.cos(ang + da), b.y + head * Math.sin(ang + da)])
        }
        el = lines.map((l, i) => (
          <line
            key={i}
            x1={l[0]}
            y1={l[1]}
            x2={l[2]}
            y2={l[3]}
            stroke={stroke}
            strokeWidth={sw}
            strokeLinecap="round"
          />
        ))
      }
      return (
        <svg key={o.id} className="ov-vector" width={fit.w} height={fit.h}>
          {el}
        </svg>
      )
    }
    if (o.type === 'text') {
      if (textEdit && textEdit.id === o.id) return null // being edited
      const r = geomToCss(o.geom, page, fit)
      return (
        <div
          key={o.id}
          className="ov-text"
          style={{
            left: r.left,
            top: r.top,
            width: r.width,
            fontSize: o.fontSize * scale,
            lineHeight: LINE,
            color: cssColor(o.color),
            textAlign: o.align,
            fontFamily: fontCss(o.font),
            opacity: o.geom.opacity
          }}
        >
          {o.text}
        </div>
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
          onDoubleClick={
            o.type === 'text'
              ? (e) => {
                  e.stopPropagation()
                  select(o.id)
                  setTextEdit({
                    id: o.id,
                    geom: o.geom,
                    value: o.text,
                    fontSize: o.fontSize,
                    color: o.color,
                    font: o.font,
                    align: o.align
                  })
                }
              : undefined
          }
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
      className={`overlay-layer${drawing ? ' drawing' : ''}${placing ? ' placing' : ''}`}
      style={{ pointerEvents: capturing ? 'auto' : 'none' }}
      onPointerDown={onLayerDown}
      onPointerMove={onDrawMove}
      onPointerUp={onDrawUp}
      onPointerCancel={onDrawUp}
    >
      {pageOverlays.map((o) => renderVisual(effective(o)))}
      {selecting && pageOverlays.map((o) => renderChrome(effective(o)))}
      {textEdit &&
        (() => {
          const r = geomToCss(textEdit.geom, page, fit)
          return (
            <textarea
              className="ov-textedit"
              autoFocus
              value={textEdit.value}
              placeholder="Type…"
              spellCheck={false}
              style={{
                left: r.left,
                top: r.top,
                width: r.width,
                minHeight: r.height,
                fontSize: textEdit.fontSize * scale,
                lineHeight: LINE,
                color: cssColor(textEdit.color),
                textAlign: textEdit.align,
                fontFamily: fontCss(textEdit.font)
              }}
              onChange={(e) => setTextEdit({ ...textEdit, value: e.target.value })}
              onBlur={commitText}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') {
                  e.preventDefault()
                  commitText()
                }
              }}
            />
          )
        })()}
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
      {draft?.kind === 'shape' &&
        (() => {
          const geom = rectGeom(draft.start, draft.current, 1)
          const isLine = edits.shapeKind === 'line' || edits.shapeKind === 'arrow'
          const preview: Overlay = {
            id: '__draft',
            pageKey,
            z: 0,
            createdAt: 0,
            geom,
            type: 'shape',
            shape: edits.shapeKind,
            color: edits.shapeColor,
            strokeWidth: edits.shapeWidth,
            ...(isLine
              ? { points: [draft.start.x, draft.start.y, draft.current.x, draft.current.y] }
              : {})
          }
          return renderVisual(preview)
        })()}
    </div>
  )
}
