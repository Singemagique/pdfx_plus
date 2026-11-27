// The find bar: focus/select on open, its own keys (Enter/F3/Ctrl+G, Escape, IME), its labels,
// and — the part that keeps typing safe — no keystroke inside it reaches the window-level canvas,
// full-view or editor shortcuts.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FindBarHost, shouldDodge } from './FindBar'
import { FIND_HIGHLIGHTS_EVENT } from './full-view/FindHighlights'
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

  it('cancels the native undo on a focused bar button, but not in the input', async () => {
    const next = container.querySelector('button[aria-label="Next match"]')!
    expect((await key(next, 'z', { ctrlKey: true })).defaultPrevented).toBe(true)
    expect((await key(input(), 'z', { ctrlKey: true })).defaultPrevented).toBe(false)
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

describe('FindBar keeps off the current match', () => {
  const W = window.innerWidth
  const BAR = { left: W - 20 - 400, right: W - 20, top: 64, bottom: 104, width: 400, height: 40 }
  const box = (left: number, top: number, w = 30, h = 14) => ({
    left,
    right: left + w,
    top,
    bottom: top + h
  })

  it('decides from both spots, not from where the bar is now', () => {
    expect(shouldDodge(BAR, [box(W - 100, 70)], W)).toBe(true)
    expect(shouldDodge(BAR, [box(W - 100, 300)], W)).toBe(false) // below the bar
    expect(shouldDodge(BAR, [box(30, 70), box(W - 100, 70)], W)).toBe(false) // under both spots
    expect(shouldDodge(BAR, [], W)).toBe(false)
  })

  it('moves to the left while a current match is under it, and back once it is not', async () => {
    let hlBox = box(W - 100, 70)
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const r = this.classList.contains('findbar') ? BAR : hlBox
        return {
          ...r,
          x: r.left,
          y: r.top,
          width: r.right - r.left,
          height: r.bottom - r.top,
          toJSON: () => r
        } as DOMRect
      })
    const hl = document.createElement('div')
    hl.className = 'find-hl current'
    const bar = (): HTMLElement => container.querySelector('.findbar') as HTMLElement
    const frame = (): Promise<void> => act(() => new Promise<void>((r) => setTimeout(r, 50)))
    try {
      document.body.appendChild(hl)
      window.dispatchEvent(new Event(FIND_HIGHLIGHTS_EVENT))
      await frame()
      expect(bar().classList.contains('dodge')).toBe(true)
      hlBox = box(400, 500) // scrolled / zoomed away from the bar
      window.dispatchEvent(new Event('scroll'))
      await frame()
      expect(bar().classList.contains('dodge')).toBe(false)
      hlBox = box(W - 100, 70)
      window.dispatchEvent(new Event(FIND_HIGHLIGHTS_EVENT))
      await frame()
      expect(bar().classList.contains('dodge')).toBe(true)
      hl.remove() // left the full view, or moved to another page
      window.dispatchEvent(new Event(FIND_HIGHLIGHTS_EVENT))
      await frame()
      expect(bar().classList.contains('dodge')).toBe(false)
    } finally {
      hl.remove()
      spy.mockRestore()
    }
  })
})
