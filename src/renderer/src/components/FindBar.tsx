import { useEffect, useRef, useState } from 'react'
import { FIND_HIGHLIGHTS_EVENT } from './full-view/FindHighlights'
import type { FindBarState, FindController } from '../search/find-controller'
import { useFindBarState } from '../search/FindContext'
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, SearchIcon } from './icons'
import { OcrFindRow, unsearchedSuffix, useUnsearchedScans } from './ocr/OcrFindRow'

/** Renders the find bar while it is open. */
export function FindBarHost({
  controller
}: {
  controller: FindController
}): React.JSX.Element | null {
  const state = useFindBarState(controller)
  if (!state.open) return null
  return <FindBar controller={controller} state={state} />
}

function countLabel(state: FindBarState, unsearched = 0): string {
  if (!state.query) return ''
  if (state.total > 0) {
    const k = state.currentIndex >= 0 ? state.currentIndex + 1 : 0
    const pages = `${state.pagesMatched} ${state.pagesMatched === 1 ? 'page' : 'pages'}`
    return `${k} of ${state.total}${state.capped ? '+' : ''} · ${pages}`
  }
  return state.indexing ? 'Indexing…' : `No results${unsearchedSuffix(unsearched)}`
}

/** The bar's inset from the window edge, either side (.findbar's right / .findbar.dodge's left). */
const BAR_INSET = 20

type Box = { left: number; right: number; top: number; bottom: number }
const overlaps = (a: Box, b: Box): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

/**
 * Whether the bar should move to the left edge: the current match (drawn in full view, one rect per
 * line) sits under its usual top-right spot and would not be under the left one. Both spots are
 * derived from the bar's size, not its current position, so the choice never flips back and forth.
 */
export function shouldDodge(
  bar: { width: number; top: number; bottom: number },
  match: readonly Box[],
  viewportWidth: number
): boolean {
  const { width, top, bottom } = bar
  const right = {
    left: viewportWidth - BAR_INSET - width,
    right: viewportWidth - BAR_INSET,
    top,
    bottom
  }
  const left = { left: BAR_INSET, right: BAR_INSET + width, top, bottom }
  return match.some((r) => overlaps(right, r)) && !match.some((r) => overlaps(left, r))
}

/** Keeps the bar off the current match: re-checked as the match is drawn, scrolled or resized. */
function useDodge(barRef: React.RefObject<HTMLDivElement | null>, currentIndex: number): boolean {
  const [dodge, setDodge] = useState(false)
  useEffect(() => {
    let raf = 0
    const check = (): void => {
      raf = 0
      const bar = barRef.current
      const match = Array.from(document.querySelectorAll('.find-hl.current'), (el) =>
        el.getBoundingClientRect()
      )
      if (!bar || match.length === 0) return setDodge(false)
      setDodge(shouldDodge(bar.getBoundingClientRect(), match, window.innerWidth))
    }
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(check)
    }
    schedule()
    window.addEventListener(FIND_HIGHLIGHTS_EVENT, schedule)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('transitionend', schedule, true)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener(FIND_HIGHLIGHTS_EVENT, schedule)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('transitionend', schedule, true)
    }
  }, [barRef, currentIndex])
  return dodge
}

interface FindBarProps {
  controller: FindController
  state: FindBarState
}

export function FindBar({ controller, state }: FindBarProps): React.JSX.Element {
  // The input owns its text: a keystroke re-renders only the bar, and the controller debounces it.
  const [value, setValue] = useState(() => controller.getRawQuery())
  const inputRef = useRef<HTMLInputElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const dodge = useDodge(barRef, state.currentIndex)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [state.focusNonce])

  const unsearched = useUnsearchedScans()
  const label = countLabel(state, unsearched)
  const showIndexing = state.indexing && state.total > 0
  const none = state.total === 0

  return (
    <div
      ref={barRef}
      className={'findbar' + (dodge ? ' dodge' : '')}
      role="search"
      // Every key stops here: the canvas, full view and editor all listen on window, and none of
      // their shortcuts (Delete removes a page, arrows flip pages, Escape closes full view) may fire
      // while the user is typing a query or has a bar button focused.
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          controller.close()
        } else if (
          (e.metaKey || e.ctrlKey) &&
          ['z', 'y'].includes(e.key.toLowerCase()) &&
          e.target !== inputRef.current
        ) {
          // A bar button has focus: the menu's undo role would revert the input's last edit.
          e.preventDefault()
        }
      }}
    >
      <div className="findbar-main">
        <span className="findbar-icon" aria-hidden="true">
          <SearchIcon size={15} />
        </span>
        <input
          ref={inputRef}
          className="findbar-input"
          type="text"
          placeholder="Find in documents"
          aria-label="Find in documents"
          spellCheck={false}
          autoComplete="off"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            controller.setQuery(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) {
              e.stopPropagation()
              return
            }
            const mod = e.metaKey || e.ctrlKey
            const key = e.key.toLowerCase()
            if (e.key === 'Enter' || e.key === 'F3' || (mod && key === 'g')) {
              e.preventDefault()
              if (e.shiftKey) controller.prev()
              else controller.next()
            } else if (mod && key === 'f') {
              e.preventDefault()
              e.currentTarget.select()
            }
          }}
        />
        <span className="findbar-count" aria-live="polite">
          {label}
        </span>
        {showIndexing && <span className="findbar-status">Indexing…</span>}
        <button
          className="icon-btn"
          title="Previous match (Shift+Enter)"
          aria-label="Previous match"
          disabled={none}
          // Keep focus in the input so typing can go on after a click.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => controller.prev()}
        >
          <ChevronUpIcon size={15} />
        </button>
        <button
          className="icon-btn"
          title="Next match (Enter)"
          aria-label="Next match"
          disabled={none}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => controller.next()}
        >
          <ChevronDownIcon size={15} />
        </button>
        <button
          className="icon-btn"
          title="Close (Esc)"
          aria-label="Close find"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => controller.close()}
        >
          <CloseIcon size={15} />
        </button>
      </div>
      <OcrFindRow />
    </div>
  )
}
