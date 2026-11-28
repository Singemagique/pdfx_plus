import { useCallback } from 'react'
import type { DocEntry } from '../../types'
import type { View } from './geometry'
import { clampPan } from './page-display'
import { FullViewPage } from './FullViewPage'
import { useFullViewDrag } from './use-full-view-drag'

interface FullViewPagesProps {
  scrollRef: React.RefObject<HTMLDivElement | null>
  drag: React.MutableRefObject<{ x: number; y: number; panX: number; panY: number } | null>
  draggedRef: React.MutableRefObject<boolean>
  docs: DocEntry[]
  viewport: { w: number; h: number }
  di: number
  pi: number
  view: View
  fit: { w: number; h: number }
  vw: number
  vh: number
  zoomed: boolean
  interactive: boolean
  animating: boolean
  flip: string | null
  flipTransition: boolean
  renderVersion: number
  setView: React.Dispatch<React.SetStateAction<View>>
  resetView: () => void
  applyZoom: (nextZoom: (z: number) => number, focal?: { x: number; y: number }) => void
  runClose: () => void
}

export function FullViewPages(props: FullViewPagesProps): React.JSX.Element {
  const { scrollRef, drag, draggedRef, docs, viewport, di, pi } = props
  const { view, fit, vw, vh, zoomed, interactive, animating, flip, flipTransition } = props
  const { renderVersion, setView, resetView, applyZoom, runClose } = props

  // The recognized-text overlay pans a zoomed page to the low-confidence word it steps to (a pan
  // the clamp refuses, as on a page that fits, changes nothing).
  const panBy = useCallback(
    (dx: number, dy: number) =>
      setView((v) => {
        const next = clampPan(v, v.x + dx, v.y + dy, fit, { w: vw, h: vh })
        return next.x === v.x && next.y === v.y ? v : next
      }),
    [setView, fit, vw, vh]
  )

  const { onPointerDown, onPointerMove, endDrag } = useFullViewDrag({
    drag,
    draggedRef,
    view,
    fit,
    vw,
    vh,
    zoomed,
    interactive,
    setView
  })

  return (
    <div
      className={`full-scroll${zoomed || animating ? ' locked' : ''}${zoomed ? ' pannable' : ''}`}
      ref={scrollRef}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={(e) => {
        if (draggedRef.current) {
          draggedRef.current = false
          return
        }
        if (!(e.target as HTMLElement).closest('.full-page')) runClose()
      }}
    >
      {docs.map((d, ddi) => (
        // tabIndex -1: Chromium makes a scroll container keyboard-focusable on its own, so Tab
        // past the last form field landed on the NEXT document's section and scrolled to it.
        <section className="full-doc" key={d.id} tabIndex={-1}>
          {d.pages.map((p, ppi) => (
            <FullViewPage
              key={p.id}
              page={p}
              viewport={viewport}
              isCurrent={ddi === di && ppi === pi}
              view={view}
              zoomed={zoomed}
              interactive={interactive}
              animating={animating}
              flip={flip}
              flipTransition={flipTransition}
              renderVersion={renderVersion}
              resetView={resetView}
              applyZoom={applyZoom}
              panBy={panBy}
            />
          ))}
        </section>
      ))}
    </div>
  )
}
