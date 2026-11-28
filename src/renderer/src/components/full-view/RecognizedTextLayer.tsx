import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PageEntry } from '../../types'
import type { PageWindow } from '../../page-geometry'
import { isEditableTarget } from '../../app/useKeyboardShortcuts'
import { FullViewHeaderSlot } from './header-slot'
import {
  headerText,
  SESSION_NOTE,
  setRecognizedTextShown,
  useRecognizedText,
  useRecognizedTextShown,
  type ShownWord
} from '../../ocr/recognized-text'

interface RecognizedTextLayerProps {
  page: PageEntry
  /** The crop window actually shown, in page px (top-left origin); absent = the whole page. */
  window?: PageWindow
  /** The page takes input (open, not animating): `]` / `[` step through low-confidence words. */
  active: boolean
  /** Pan a zoomed page by screen px (clamped), to bring a stepped-to word into view. */
  panBy?: (dx: number, dy: number) => void
}

/** How far inside the viewport a stepped-to word must be before the page is panned to it. */
const REVEAL_MARGIN = 48

const ASCENT = 0.8
const DESCENT = 0.2

/**
 * The header is portalled out of the page, but React still bubbles its events through the page's
 * tree: to FullViewPage's double-click zoom and FullViewPages' backdrop click (which closes full
 * view) and drag handlers. They stop at the header.
 */
const stop = (e: React.SyntheticEvent): void => e.stopPropagation()
const HEADER_EVENTS = {
  onClick: stop,
  onDoubleClick: stop,
  onPointerDown: stop,
  onPointerUp: stop,
  onPointerMove: stop,
  onPointerCancel: stop
}

/**
 * `]` steps forward, `[` back: by the character typed, or by the physical key at the US `]` / `[`
 * position (`BracketRight` / `BracketLeft`) with no modifier at all, for layouts (German, French…)
 * where the brackets need AltGr. AltGr itself arrives as Ctrl+Alt on Windows: a `]` / `[` typed with
 * it still counts; a real Ctrl, Alt or Meta chord does not.
 */
function stepDirection(event: KeyboardEvent): 1 | -1 | 0 {
  if (event.metaKey) return 0
  const altGr = event.getModifierState?.('AltGraph') ?? false
  if ((event.ctrlKey || event.altKey) && !altGr) return 0
  if (event.key === ']') return 1
  if (event.key === '[') return -1
  if (altGr || event.ctrlKey || event.altKey || event.shiftKey) return 0
  if (event.code === 'BracketRight') return 1
  if (event.code === 'BracketLeft') return -1
  return 0
}

/** Three decimals of a pt are plenty, and keep Float32 noise out of the markup. */
const r3 = (v: number): number => Math.round(v * 1000) / 1000
const placeAt = (w: ShownWord): string => `translate(${r3(w.x)} ${r3(w.y)}) rotate(${r3(w.deg)})`

function Word({ w }: { w: ShownWord }): React.JSX.Element {
  return (
    <g className="ocr-w" transform={placeAt(w)}>
      <rect x={0} y={-ASCENT * w.size} width={Math.max(w.w, 0)} height={w.size} />
      <text
        x={0}
        y={0}
        fontSize={w.size}
        {...(w.w > 0 ? { textLength: w.w, lengthAdjust: 'spacingAndGlyphs' } : {})}
      >
        {w.t}
      </text>
    </g>
  )
}

/**
 * "Show recognized text" (DESIGN.md §3.6.3): a read-only layer over the full-view page drawing
 * each recognised word's box with its text at 60% opacity — exactly the words Find and Copy Page
 * Text use, so nothing a redaction hides — and a dotted underline under every word below the
 * calibrated underline threshold. `]` / `[` step through those (a focus ring, the page panned to
 * it when zoomed). Like FindHighlights it sits inside `.page-frame` (so it inherits the box's
 * rotate()/zoom), under the Find matches (they multiply over it and stay saturated) and under the
 * overlay layer; the header is portalled out of the transformed box, into the full-view bar.
 */
export function RecognizedTextLayer({
  page,
  window: shownWindow,
  active,
  panBy
}: RecognizedTextLayerProps): React.JSX.Element | null {
  const shown = useRecognizedTextShown()
  const view = useRecognizedText(page, shownWindow, shown)
  // The stepped-to low-confidence word: an index into `view.low` (-1: none yet).
  const [focus, setFocus] = useState(-1)
  const svgRef = useRef<SVGSVGElement | null>(null)

  // New low-confidence words (a redaction, Replace, a crop): start stepping from the top again.
  // By content, not identity: a redacted page's words are a new array on every supply change
  // (an edit elsewhere, another page's result), and those must not lose the user's place.
  const lowSig = useMemo(
    () =>
      view
        ? JSON.stringify(view.low.map((i) => [view.words[i].t, view.words[i].x, view.words[i].y]))
        : '',
    [view]
  )
  useEffect(() => setFocus(-1), [lowSig])
  const slot = useContext(FullViewHeaderSlot)
  const headerTarget = slot === undefined ? document.body : slot

  const lowCount = view?.low.length ?? 0
  useEffect(() => {
    if (!shown || !active || lowCount === 0) return
    const onKey = (event: KeyboardEvent): void => {
      const dir = stepDirection(event)
      if (dir === 0 || event.defaultPrevented) return
      if (isEditableTarget(event.target)) return
      event.preventDefault()
      setFocus((f) => {
        if (f < 0) return dir > 0 ? 0 : lowCount - 1
        return (f + dir + lowCount) % lowCount
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shown, active, lowCount])

  // Bring the focused word into view: a page that fits is already whole on screen; a zoomed one is
  // panned (by the transform, not by scrolling: the full-view scrollers are locked while zoomed).
  // Once per step: `panBy` is read through a ref, since panning re-renders the page with a new one.
  const panRef = useRef(panBy)
  panRef.current = panBy
  useLayoutEffect(() => {
    const panBy = panRef.current
    if (focus < 0 || !panBy) return
    const el = svgRef.current?.querySelector('.ocr-focus')
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return
    const vw = document.documentElement.clientWidth || window.innerWidth
    const vh = document.documentElement.clientHeight || window.innerHeight
    const inside =
      r.left >= REVEAL_MARGIN &&
      r.top >= REVEAL_MARGIN &&
      r.right <= vw - REVEAL_MARGIN &&
      r.bottom <= vh - REVEAL_MARGIN
    if (inside) return
    panBy(vw / 2 - (r.left + r.width / 2), vh / 2 - (r.top + r.height / 2))
  }, [focus])

  if (!shown || !view) return null
  const focused = focus >= 0 && focus < view.low.length ? view.words[view.low[focus]] : null
  const header = (
    <div className="ocr-text-header" role="status" {...HEADER_EVENTS}>
      <div className="ocr-text-header-row">
        <span className="ocr-text-header-main">{headerText(view)}</span>
        {view.low.length > 0 && (
          <span className="ocr-text-header-step">
            {focused ? `${focus + 1} of ${view.low.length}` : 'Press ] or [ to step through them'}
          </span>
        )}
        <button
          type="button"
          className="ocr-text-header-hide"
          onClick={() => setRecognizedTextShown(false)}
          title="Hide recognized text"
        >
          Hide
        </button>
      </div>
      <div className="ocr-text-header-note">{SESSION_NOTE}</div>
      <span className="visually-hidden" aria-live="polite">
        {focused ? `Low-confidence word ${focus + 1} of ${view.low.length}: ${focused.t}` : ''}
      </span>
    </div>
  )
  return (
    <>
      {view.words.length > 0 && (
        <svg
          ref={svgRef}
          className="ocr-text-layer"
          viewBox={`0 0 ${page.width} ${page.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {view.words.map((w, i) => (
            <Word key={i} w={w} />
          ))}
          {view.low.map((wi, li) => {
            const w = view.words[wi]
            const y = DESCENT * 0.5 * w.size
            return (
              <g key={`u${wi}`} transform={placeAt(w)}>
                <line className="ocr-low" x1={0} y1={y} x2={Math.max(w.w, 0)} y2={y} />
                {li === focus && (
                  <rect
                    className="ocr-focus"
                    x={-1}
                    y={-ASCENT * w.size - 1}
                    width={Math.max(w.w, 0) + 2}
                    height={w.size + 2}
                    rx={1.5}
                  />
                )}
              </g>
            )
          })}
        </svg>
      )}
      {headerTarget && createPortal(header, headerTarget)}
    </>
  )
}
