// Real-React regression tests for the identity of the edit store handed to context.
//
// The store is created in App, which also owns a pile of unrelated state (busy counter, toast,
// zoom, drag). While useEditStore returned a fresh object literal, every one of those renders
// produced a new context value and re-rendered every useEdits() consumer — the whole overlay
// layer and the tool palette — for nothing. Pinning that needs a real render + real context
// propagation (a memoized consumer only re-renders when the context value's identity changes),
// hence react-dom/client + act().

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement, memo, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { EditProvider, useEdits, useEditStore, type EditStore } from './EditProvider'
import type { Overlay } from './model'

// Every context value a memoized consumer has actually seen, newest last.
let seen: EditStore[] = []
// The store as of the most recent parent render.
let latest: EditStore = null as unknown as EditStore
// Unrelated parent state, standing in for App's busy counter / toast / zoom.
let bumpUnrelated: (n: number) => void = () => {}

// memo() with no props re-renders ONLY when a context it reads changes, so seen.length is an
// exact count of context-value identity changes.
const Consumer = memo(function Consumer(): ReactNode {
  seen.push(useEdits())
  return null
})

function Parent(): ReactNode {
  const store = useEditStore()
  const [unrelated, setUnrelated] = useState(0)
  latest = store
  bumpUnrelated = setUnrelated
  return createElement(
    'div',
    null,
    String(unrelated),
    createElement(EditProvider, { store, children: createElement(Consumer, null) })
  )
}

const overlay = (id: string): Overlay => ({
  id,
  pageKey: 'src-1#0',
  z: 0,
  createdAt: 0,
  geom: { x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 },
  type: 'highlight',
  color: { r: 1, g: 0.9, b: 0.2 }
})

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(async () => {
  seen = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(Parent, null))
  })
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

describe('useEditStore identity', () => {
  it('survives a parent re-render caused by unrelated state', async () => {
    const first = latest
    expect(seen).toEqual([first])

    await act(async () => {
      bumpUnrelated(1)
    })
    expect(container.textContent).toContain('1') // the parent really did re-render

    expect(latest).toBe(first)
    expect(seen).toEqual([first]) // the consumer was not re-rendered

    await act(async () => {
      bumpUnrelated(2)
    })
    expect(latest).toBe(first)
    expect(seen).toEqual([first])
  })

  it('changes when the store itself is mutated', async () => {
    const first = latest

    await act(async () => {
      latest.addOverlay(overlay('ov-1'))
    })
    expect(latest).not.toBe(first)
    expect(latest.overlays.map((o) => o.id)).toEqual(['ov-1'])
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBe(latest)

    // …and again for a field that has nothing to do with overlays.
    const second = latest
    await act(async () => {
      latest.setTool('ink')
    })
    expect(latest).not.toBe(second)
    expect(latest.tool).toBe('ink')
    expect(seen).toHaveLength(3)
    expect(seen[2]?.tool).toBe('ink')
  })

  it('keeps exposing live values through the memoized object', async () => {
    await act(async () => {
      latest.setInkWidth(6)
    })
    await act(async () => {
      bumpUnrelated(1)
    })
    // The memo must not pin a stale snapshot: the value read after an unrelated render is still
    // the one the setter wrote.
    expect(latest.inkWidth).toBe(6)
    expect(seen[seen.length - 1].inkWidth).toBe(6)
    expect(latest.canUndo).toBe(false)

    await act(async () => {
      latest.addOverlay(overlay('ov-2'))
    })
    expect(latest.canUndo).toBe(true)
    expect(seen[seen.length - 1].canUndo).toBe(true)
  })
})
