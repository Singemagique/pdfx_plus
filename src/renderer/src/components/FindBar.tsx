import { useEffect, useRef, useState } from 'react'
import type { FindBarState, FindController } from '../search/find-controller'
import { useFindBarState } from '../search/FindContext'
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, SearchIcon } from './icons'

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

function countLabel(state: FindBarState): string {
  if (!state.query) return ''
  if (state.total > 0) {
    const k = state.currentIndex >= 0 ? state.currentIndex + 1 : 0
    const pages = `${state.pagesMatched} ${state.pagesMatched === 1 ? 'page' : 'pages'}`
    return `${k} of ${state.total}${state.capped ? '+' : ''} · ${pages}`
  }
  return state.indexing ? 'Indexing…' : 'No results'
}

interface FindBarProps {
  controller: FindController
  state: FindBarState
}

export function FindBar({ controller, state }: FindBarProps): React.JSX.Element {
  // The input owns its text: a keystroke re-renders only the bar, and the controller debounces it.
  const [value, setValue] = useState(() => controller.getRawQuery())
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [state.focusNonce])

  const label = countLabel(state)
  const showIndexing = state.indexing && state.total > 0
  const none = state.total === 0

  return (
    <div
      className="findbar"
      role="search"
      // Every key stops here: the canvas, full view and editor all listen on window, and none of
      // their shortcuts (Delete removes a page, arrows flip pages, Escape closes full view) may fire
      // while the user is typing a query or has a bar button focused.
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          controller.close()
        }
      }}
    >
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
  )
}
