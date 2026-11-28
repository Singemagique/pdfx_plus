// The app toast's timing: a toast with a button stays until used, dismissed or replaced (a keyboard
// or screen-reader user must be able to reach [Details] / [Resume]); a plain one goes after 4 s.

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOAST_MS, useToast } from './useToast'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
let t: ReturnType<typeof useToast>

function Host(): null {
  t = useToast()
  return null
}

beforeEach(async () => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(createElement(Host)))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})

const wait = (ms: number): Promise<void> => act(async () => void vi.advanceTimersByTime(ms))

describe('useToast', () => {
  it('a plain toast goes after TOAST_MS', async () => {
    await act(async () => t.flash('Page text copied'))
    expect(t.toast?.message).toBe('Page text copied')
    await wait(TOAST_MS + 1)
    expect(t.toast).toBeNull()
  })

  it('a toast with a button stays (no timer) until dismissed', async () => {
    const run = vi.fn()
    await act(async () => t.flash('Text recognition couldn’t start.', { label: 'Details', run }))
    await wait(60_000)
    expect(t.toast?.action?.label).toBe('Details')
    await act(async () => t.dismiss())
    expect(t.toast).toBeNull()
  })

  it('a plain toast that replaces an action toast still goes; an action one cancels a timer', async () => {
    await act(async () => t.flash('first'))
    await act(async () => t.flash('Stopped unexpectedly', { label: 'Resume', run: vi.fn() }))
    await wait(TOAST_MS + 1) // the first toast's timer must not take the action toast away
    expect(t.toast?.message).toBe('Stopped unexpectedly')
    await act(async () => t.flash('plain'))
    await wait(TOAST_MS + 1)
    expect(t.toast).toBeNull()
  })
})
