import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useFindShortcuts } from './useFindShortcuts'
import { NULL_FIND_CONTROLLER } from './FindContext'
import type { FindController } from './find-controller'

let open = false
const ctl: FindController = {
  ...NULL_FIND_CONTROLLER,
  getBarState: () => ({ ...NULL_FIND_CONTROLLER.getBarState(), open }),
  open: vi.fn(() => {
    open = true
  }),
  next: vi.fn(),
  prev: vi.fn()
}

function Harness({ enabled }: { enabled: boolean }): null {
  useFindShortcuts({ controller: ctl, enabled })
  return null
}

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(async () => {
  open = false
  vi.mocked(ctl.open).mockClear()
  vi.mocked(ctl.next).mockClear()
  vi.mocked(ctl.prev).mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(createElement(Harness, { enabled: true })))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const press = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  document.body.dispatchEvent(e)
  return e
}

describe('useFindShortcuts', () => {
  it('opens on Ctrl+F and Cmd+F, taking the key', () => {
    expect(press('f', { ctrlKey: true }).defaultPrevented).toBe(true)
    expect(press('F', { metaKey: true }).defaultPrevented).toBe(true)
    expect(ctl.open).toHaveBeenCalledTimes(2)
  })

  it('opens on F3 / Ctrl+G when closed, and steps once open', () => {
    expect(press('F3').defaultPrevented).toBe(true)
    expect(ctl.open).toHaveBeenCalledTimes(1)
    expect(ctl.next).not.toHaveBeenCalled()
    press('F3')
    press('g', { ctrlKey: true })
    expect(ctl.next).toHaveBeenCalledTimes(2)
    press('F3', { shiftKey: true })
    press('G', { ctrlKey: true, shiftKey: true })
    expect(ctl.prev).toHaveBeenCalledTimes(2)
  })

  it('leaves other keys alone', () => {
    expect(press('f').defaultPrevented).toBe(false)
    expect(press('Delete').defaultPrevented).toBe(false)
    expect(ctl.open).not.toHaveBeenCalled()
  })

  it('does nothing while disabled (a modal dialog is open)', async () => {
    await act(async () => root.render(createElement(Harness, { enabled: false })))
    expect(press('f', { ctrlKey: true }).defaultPrevented).toBe(false)
    press('F3')
    expect(ctl.open).not.toHaveBeenCalled()
  })
})
