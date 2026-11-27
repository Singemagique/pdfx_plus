// The find bar: focus/select on open, its own keys (Enter/F3/Ctrl+G, Escape, IME), its labels,
// and — the part that keeps typing safe — no keystroke inside it reaches the window-level canvas,
// full-view or editor shortcuts.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FindBarHost } from './FindBar'
import { NULL_FIND_CONTROLLER } from '../search/FindContext'
import type { FindBarState, FindController } from '../search/find-controller'
import { useKeyboardShortcuts } from '../app/useKeyboardShortcuts'

const BAR: FindBarState = {
  open: true,
  query: '',
  focusNonce: 1,
  total: 0,
  capped: false,
  currentIndex: -1,
  pagesMatched: 0,
  indexing: false,
  indexed: 0,
  indexTotal: 0
}

function fakeController(raw = 'previous words') {
  let state = BAR
  const listeners = new Set<() => void>()
  const ctl: FindController = {
    ...NULL_FIND_CONTROLLER,
    subscribe: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    getBarState: () => state,
    getRawQuery: () => raw,
    next: vi.fn(),
    prev: vi.fn(),
    close: vi.fn(),
    setQuery: vi.fn()
  }
  const set = (patch: Partial<FindBarState>): void => {
    state = { ...state, ...patch }
    listeners.forEach((l) => l())
  }
  return { ctl, set }
}

const shortcuts = {
  onDeletePage: vi.fn(),
  onDuplicate: vi.fn(),
  onCopy: vi.fn(),
  onPaste: vi.fn(),
  onClearSelection: vi.fn()
}

function Shortcuts(): null {
  useKeyboardShortcuts({
    active: true,
    selected: { docId: 'd', pageId: 'p' },
    ...shortcuts
  })
  return null
}

let container: HTMLDivElement
let root: Root
let f: ReturnType<typeof fakeController>

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(async () => {
  Object.values(shortcuts).forEach((s) => s.mockClear())
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  f = fakeController()
  await act(async () =>
    root.render(
      createElement(
        Fragment,
        null,
        createElement(Shortcuts),
        createElement(FindBarHost, { controller: f.ctl })
      )
    )
  )
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const input = (): HTMLInputElement => container.querySelector('.findbar-input') as HTMLInputElement
const count = (): string => container.querySelector('.findbar-count')?.textContent ?? ''

const key = async (
  target: Element,
  k: string,
  init: KeyboardEventInit = {}
): Promise<KeyboardEvent> => {
  const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
  await act(async () => {
    target.dispatchEvent(event)
  })
  return event
}

describe('FindBar', () => {
  it('renders only while open', async () => {
    expect(container.querySelector('.findbar')).not.toBeNull()
    await act(async () => f.set({ open: false }))
    expect(container.querySelector('.findbar')).toBeNull()
  })

  it('focuses and selects the kept query on mount and on a focus request', async () => {
    const el = input()
    expect(el.value).toBe('previous words')
    expect(document.activeElement).toBe(el)
    expect([el.selectionStart, el.selectionEnd]).toEqual([0, el.value.length])
    el.setSelectionRange(2, 2)
    el.blur()
    await act(async () => f.set({ focusNonce: 2 }))
    expect(document.activeElement).toBe(el)
    expect([el.selectionStart, el.selectionEnd]).toEqual([0, el.value.length])
  })

  it('steps with Enter, Shift+Enter, F3, Shift+F3, Ctrl+G and Shift+Ctrl+G', async () => {
    await key(input(), 'Enter')
    await key(input(), 'F3')
    await key(input(), 'g', { ctrlKey: true })
    await key(input(), 'G', { metaKey: true })
    expect(f.ctl.next).toHaveBeenCalledTimes(4)
    await key(input(), 'Enter', { shiftKey: true })
    await key(input(), 'F3', { shiftKey: true })
    await key(input(), 'G', { ctrlKey: true, shiftKey: true })
    expect(f.ctl.prev).toHaveBeenCalledTimes(3)
  })

  it('closes on Escape', async () => {
    const e = await key(input(), 'Escape')
    expect(f.ctl.close).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
  })

  it('ignores Enter while an IME composition is in progress', async () => {
    await key(input(), 'Enter', { isComposing: true })
    expect(f.ctl.next).not.toHaveBeenCalled()
  })

  it('labels the result count, no results and indexing', async () => {
    expect(count()).toBe('')
    await act(async () => f.set({ query: 'x', indexing: true }))
    expect(count()).toBe('Indexing…')
    await act(async () => f.set({ indexing: false }))
    expect(count()).toBe('No results')
    await act(async () => f.set({ total: 7, currentIndex: 2, pagesMatched: 3 }))
    expect(count()).toBe('3 of 7 · 3 pages')
    await act(async () => f.set({ pagesMatched: 1, capped: true, indexing: true }))
    expect(count()).toBe('3 of 7+ · 1 page')
    expect(container.querySelector('.findbar-status')?.textContent).toBe('Indexing…')
  })

  it('sends typed text to the controller', async () => {
    const el = input()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(el, 'kiwi')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(f.ctl.setQuery).toHaveBeenCalledWith('kiwi')
    expect(el.value).toBe('kiwi')
  })

  it('keeps every key inside the bar away from the window shortcuts', async () => {
    const onWindow = vi.fn()
    window.addEventListener('keydown', onWindow)
    try {
      const next = container.querySelector('button[aria-label="Next match"]')!
      for (const target of [input(), next]) {
        await key(target, 'Delete')
        await key(target, 'Backspace')
        await key(target, 'ArrowRight')
        await key(target, 'd', { ctrlKey: true })
        await key(target, 'z', { ctrlKey: true })
      }
      await key(input(), 'Escape')
      expect(onWindow).not.toHaveBeenCalled()
      expect(shortcuts.onDeletePage).not.toHaveBeenCalled()
      expect(shortcuts.onDuplicate).not.toHaveBeenCalled()
      expect(shortcuts.onClearSelection).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', onWindow)
    }
    // Control: the same Delete outside the bar does reach them.
    await key(document.body, 'Delete')
    expect(shortcuts.onDeletePage).toHaveBeenCalledTimes(1)
  })
})
