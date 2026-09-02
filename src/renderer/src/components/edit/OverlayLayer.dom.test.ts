// Real-React regression tests for the pointer-draft lifecycle in OverlayLayer.
//
// These exist because the bugs they pin are *scheduling* bugs, not pure-function bugs: a
// pointermove runs at React's ContinuousEventPriority, so its state update is scheduled rather
// than flushed, and a second handler in the same batch would read the previous render's closure.
// Reproducing that needs a real render + real event dispatch, hence react-dom/client + act():
// updates dispatched inside ONE act() scope are batched exactly the way a burst of native pointer
// events is batched under main-thread load.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { OverlayLayer } from './OverlayLayer'
import { EditProvider, useEditStore, type EditStore } from '../../edit/EditProvider'
import type { PageEntry } from '../../types'

const PAGE_W = 600
const PAGE_H = 800

// pdf.js stub: OverlayLayer only asks a page for its widget annotations (there are none here).
const pdfStub = {
  getPage: () =>
    Promise.resolve({ rotate: 0, view: [0, 0, PAGE_W, PAGE_H], getAnnotations: () => Promise.resolve([]) })
} // prettier-ignore

const page: PageEntry = {
  id: 'pg-1',
  source: {
    id: 'src-1',
    bytes: new Uint8Array(),
    pdf: pdfStub as unknown as PageEntry['source']['pdf']
  },
  pageIndex: 0,
  width: PAGE_W,
  height: PAGE_H
}

// fit === page size, so 1 CSS px === 1 PDF point and client (x, y) → PDF (x, PAGE_H - y).
const fit = { w: PAGE_W, h: PAGE_H }

let store: EditStore = null as unknown as EditStore

function Harness({ show }: { show: boolean }): ReactNode {
  const s = useEditStore()
  store = s
  const child = show ? createElement(OverlayLayer, { page, fit, rot: 0, active: true }) : null
  return createElement(EditProvider, { store: s, children: child })
}

const pointer = (type: string, x: number, y: number): MouseEvent =>
  new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })

let container: HTMLDivElement
let root: Root

const layer = (): HTMLElement => {
  const el = container.querySelector('.overlay-layer') as HTMLElement | null
  if (!el) throw new Error('overlay layer not rendered')
  // jsdom has no layout, so the pointer→PDF mapping needs a real rect.
  el.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: PAGE_W,
      bottom: PAGE_H,
      width: PAGE_W,
      height: PAGE_H,
      x: 0,
      y: 0,
      toJSON: () => ({})
    }) as DOMRect
  return el
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const proto = Element.prototype as unknown as Record<string, unknown>
  if (typeof proto.setPointerCapture !== 'function') proto.setPointerCapture = () => {}
  if (typeof proto.releasePointerCapture !== 'function') proto.releasePointerCapture = () => {}
})

beforeEach(async () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(Harness, { show: true }))
  })
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

const inkOverlays = (): Extract<EditStore['overlays'][number], { type: 'ink' }>[] =>
  store.overlays.filter((o): o is Extract<typeof o, { type: 'ink' }> => o.type === 'ink')

const highlight = (id: string): EditStore['overlays'][number] => ({
  id,
  pageKey: 'src-1#0',
  z: 0,
  createdAt: 0,
  geom: { x: 10, y: 10, w: 40, h: 20, rotation: 0, opacity: 1 },
  type: 'highlight',
  color: { r: 1, g: 0.9, b: 0.2 }
})

describe('OverlayLayer ink drafting under batched pointer events', () => {
  beforeEach(async () => {
    await act(async () => {
      store.setTool('ink')
    })
  })

  it('keeps every point when several pointermoves land in one batch', async () => {
    const el = layer()
    await act(async () => {
      el.dispatchEvent(pointer('pointerdown', 10, 10))
    })
    // Two moves before React commits: the second must extend the first, not replace it.
    await act(async () => {
      el.dispatchEvent(pointer('pointermove', 20, 20))
      el.dispatchEvent(pointer('pointermove', 30, 30))
    })
    await act(async () => {
      el.dispatchEvent(pointer('pointerup', 30, 30))
    })

    expect(inkOverlays()).toHaveLength(1)
    expect(inkOverlays()[0].paths[0]).toEqual([10, 790, 20, 780, 30, 770])
  })

  it('commits a fast flick where the move and the pointerup share a batch', async () => {
    const el = layer()
    await act(async () => {
      el.dispatchEvent(pointer('pointerdown', 10, 10))
    })
    // pointerup does NOT flush the pending continuous move, so the commit must not read
    // the pre-move render closure — otherwise the stroke fails the >= 4 point guard.
    await act(async () => {
      el.dispatchEvent(pointer('pointermove', 40, 40))
      el.dispatchEvent(pointer('pointerup', 40, 40))
    })

    expect(inkOverlays()).toHaveLength(1)
    expect(inkOverlays()[0].paths[0]).toEqual([10, 790, 40, 760])
  })

  it('drops a tap that never moved (still under the minimum-points guard)', async () => {
    const el = layer()
    await act(async () => {
      el.dispatchEvent(pointer('pointerdown', 10, 10))
    })
    await act(async () => {
      el.dispatchEvent(pointer('pointerup', 10, 10))
    })
    expect(inkOverlays()).toHaveLength(0)
  })
})

// Counts window keydown (un)subscriptions while the spy is installed, passing everything through
// to the real implementation so the listener still works.
type ListenerFn = (type: string, ...rest: unknown[]) => void

describe('OverlayLayer keyboard handling', () => {
  let counts: { added: number; removed: number }
  let origAdd: typeof window.addEventListener
  let origRemove: typeof window.removeEventListener

  beforeEach(() => {
    counts = { added: 0, removed: 0 }
    origAdd = window.addEventListener
    origRemove = window.removeEventListener
    const passAdd = origAdd.bind(window) as unknown as ListenerFn
    const passRemove = origRemove.bind(window) as unknown as ListenerFn
    window.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'keydown') counts.added++
      passAdd(type, ...rest)
    }) as unknown as typeof window.addEventListener
    window.removeEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'keydown') counts.removed++
      passRemove(type, ...rest)
    }) as unknown as typeof window.removeEventListener
  })

  afterEach(() => {
    window.addEventListener = origAdd
    window.removeEventListener = origRemove
  })

  it('does not re-subscribe the keydown listener when unrelated store state changes', async () => {
    // Changing the pen colour re-renders the layer but touches nothing the handler reads. Listing
    // the whole `edits` object in the effect deps tore the listener down and re-added it here.
    await act(async () => {
      store.setInkColor({ r: 1, g: 0, b: 0 })
    })
    expect(store.inkColor).toEqual({ r: 1, g: 0, b: 0 })
    expect(counts).toEqual({ added: 0, removed: 0 })

    // Adding an overlay elsewhere in the document is just as unrelated to the handler.
    await act(async () => {
      store.addOverlay(highlight('ov-keep'))
    })
    expect(counts).toEqual({ added: 0, removed: 0 })
  })

  it('still deletes the selected overlay on Delete', async () => {
    await act(async () => {
      store.addOverlay(highlight('ov-del'))
    })
    await act(async () => {
      store.select('ov-del')
    })
    expect(store.selectedId).toBe('ov-del')

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    })
    expect(store.overlays).toHaveLength(0)
    expect(store.selectedId).toBeNull()
  })

  it('clears the selection on Escape', async () => {
    await act(async () => {
      store.addOverlay(highlight('ov-esc'))
    })
    await act(async () => {
      store.select('ov-esc')
    })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(store.selectedId).toBeNull()
    expect(store.overlays).toHaveLength(1)
  })
})

describe('OverlayLayer currentPage reporting', () => {
  it('clears currentPage when the layer deactivates, so palette actions cannot target a stale page', async () => {
    expect(store.currentPage?.pageKey).toBe('src-1#0')
    await act(async () => {
      root.render(createElement(Harness, { show: false }))
    })
    expect(store.currentPage).toBeNull()
  })
})
