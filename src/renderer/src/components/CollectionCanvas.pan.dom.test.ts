// Pan bounds: however the view is moved — wheel scroll, drag, ctrl+wheel or button zoom, the
// import fit, a resize — the documents never leave the screen. Content taller (wider) than the
// window inside the toolbar/bottom (side) margins pans only until an edge reaches that margin;
// shorter (narrower) content stays entirely inside it.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { zoomTransform } from 'd3-zoom'

vi.mock('./collection/DocLayer', () => ({ DocLayer: () => null }))
vi.mock('./collection/HeaderLayer', () => ({ HeaderLayer: () => null }))

import { CollectionCanvas } from './CollectionCanvas'
import type { CanvasHandle } from './Canvas'
import { computeLayout, panReachWidth, wrapWidthForViewport } from '../canvas/layout'
import {
  FIT_ANIMATION_MS,
  MIN_SCALE,
  PAN_BOTTOM_MARGIN,
  PAN_SIDE_MARGIN,
  PAN_TOP_MARGIN
} from '../canvas/zoom-constants'
import { doc } from '../canvas/test-utils/layout-fixtures'
import type { DocEntry } from '../types'

const vpSize = { w: 1400, h: 900 }

let setDocs: (docs: DocEntry[]) => void = () => {}
let handle: CanvasHandle | null = null

function Harness({ initial }: { initial: DocEntry[] }): ReactNode {
  const [docs, set] = useState(initial)
  const [wrap, setWrap] = useState<number | undefined>(undefined)
  setDocs = set
  const layout = computeLayout(docs, undefined, wrap)
  const noop = (): void => {}
  return createElement(CollectionCanvas, {
    docs,
    layout,
    busy: false,
    pagesDraggable: true,
    renderVersion: 0,
    selected: null,
    hiddenPageId: null,
    dragKind: null,
    draggingPage: null,
    dropTarget: null,
    collapsedId: null,
    externalCount: 0,
    canvasRef: (h: CanvasHandle | null) => {
      handle = h
    },
    onScaleChange: noop,
    onSettle: noop,
    onBackgroundClick: noop,
    onWrapWidthChange: setWrap,
    onOpen: noop,
    onSelectPage: noop,
    onOpenPage: noop,
    onPageDragStart: noop,
    onPageDragEnd: noop,
    onAddPage: noop,
    onMoveDoc: noop,
    onRemoveDoc: noop,
    onRenameDoc: noop
  })
}

const observers = new Set<() => void>()
const sizeProps = ['clientWidth', 'clientHeight'] as const
const saved = sizeProps.map((p) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, p))

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  for (const [prop, key] of [
    ['clientWidth', 'w'],
    ['clientHeight', 'h']
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('canvas-viewport') ? vpSize[key] : 0
      }
    })
  }
  class TestResizeObserver {
    private readonly cb: () => void
    constructor(cb: () => void) {
      this.cb = cb
    }
    observe(): void {
      observers.add(this.cb)
    }
    disconnect(): void {
      observers.delete(this.cb)
    }
    unobserve(): void {}
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
})

afterAll(() => {
  sizeProps.forEach((p, i) => {
    const d = saved[i]
    if (d) Object.defineProperty(HTMLElement.prototype, p, d)
  })
  vi.unstubAllGlobals()
})

let container: HTMLDivElement
let root: Root
let docs: DocEntry[] = []

const viewport = (): HTMLDivElement => container.querySelector('.canvas-viewport') as HTMLDivElement
const settle = (): Promise<void> =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, FIT_ANIMATION_MS + 150)))

/** The content box's on-screen edges, and the window they are bounded by. */
function screen(): {
  k: number
  top: number
  bottom: number
  left: number
  right: number
} {
  const t = zoomTransform(viewport())
  const layout = computeLayout(docs, undefined, wrapWidthForViewport(vpSize.w))
  return {
    k: t.k,
    top: t.applyY(0),
    bottom: t.applyY(layout.contentHeight),
    left: t.applyX(0),
    right: t.applyX(layout.contentWidth)
  }
}
const win = (): { top: number; bottom: number; left: number; right: number } => ({
  top: PAN_TOP_MARGIN,
  bottom: vpSize.h - PAN_BOTTOM_MARGIN,
  left: PAN_SIDE_MARGIN,
  right: vpSize.w - PAN_SIDE_MARGIN
})

/** Asserts the bounds hold on both axes, whatever the content's size on screen. */
function expectInBounds(): void {
  const s = screen()
  const w = win()
  const eps = 1e-6
  if (s.bottom - s.top >= w.bottom - w.top) {
    expect(s.top).toBeLessThanOrEqual(w.top + eps)
    expect(s.bottom).toBeGreaterThanOrEqual(w.bottom - eps)
  } else {
    expect(s.top).toBeGreaterThanOrEqual(w.top - eps)
    expect(s.bottom).toBeLessThanOrEqual(w.bottom + eps)
  }
  if (s.right - s.left >= w.right - w.left) {
    expect(s.left).toBeLessThanOrEqual(w.left + eps)
    expect(s.right).toBeGreaterThanOrEqual(w.right - eps)
  } else {
    expect(s.left).toBeGreaterThanOrEqual(w.left - eps)
    expect(s.right).toBeLessThanOrEqual(w.right + eps)
  }
}

const wheel = (init: WheelEventInit): Promise<void> =>
  act(async () => {
    viewport().dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init }))
  })
/** `n` wheel notches, checking the bounds after each one. */
async function wheelMany(n: number, init: WheelEventInit): Promise<void> {
  for (let i = 0; i < n; i++) {
    await wheel(init)
    expectInBounds()
  }
}

/**
 * A mouse event for d3-zoom's drag, which listens for the moves on `event.view`. (jsdom refuses
 * the test environment's `window` as the `view` init member, so it is set on the event instead.)
 */
function mouse(type: string, x: number, y: number): MouseEvent {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true })
  Object.defineProperty(event, 'view', { value: window })
  return event
}
const pointerDown = (x: number, y: number): Promise<void> =>
  act(async () => {
    viewport().dispatchEvent(mouse('mousedown', x, y))
  })
const pointerMove = (x: number, y: number): Promise<void> =>
  act(async () => {
    window.dispatchEvent(mouse('mousemove', x, y))
  })
const pointerUp = (x: number, y: number): Promise<void> =>
  act(async () => {
    window.dispatchEvent(mouse('mouseup', x, y))
  })

/** A d3 mouse drag on the viewport background from `from` to `to` (css px), in `steps` moves. */
async function drag(from: [number, number], to: [number, number], steps = 10): Promise<void> {
  await pointerDown(...from)
  for (let i = 1; i <= steps; i++) {
    await pointerMove(
      from[0] + ((to[0] - from[0]) * i) / steps,
      from[1] + ((to[1] - from[1]) * i) / steps
    )
    expectInBounds()
  }
  await pointerUp(...to)
}

const mount = async (initial: DocEntry[]): Promise<void> => {
  docs = initial
  await act(async () => root.render(createElement(Harness, { initial })))
  await settle()
}
const resize = async (w: number, h: number): Promise<void> => {
  vpSize.w = w
  vpSize.h = h
  observers.forEach((cb) => cb())
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 150)))
}

beforeEach(() => {
  vpSize.w = 1400
  vpSize.h = 900
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

// 4 documents × 12 pages: many screens tall.
const many = (): DocEntry[] => ['a', 'b', 'c', 'd'].map((id) => doc(id, 12))

describe('wheel scrolling', () => {
  it('stops with the end of the content at the bottom margin', async () => {
    await mount(many())
    await wheelMany(40, { deltaY: 400 })
    const s = screen()
    expect(s.bottom).toBeCloseTo(win().bottom)
    // More scrolling changes nothing.
    const t = zoomTransform(viewport())
    await wheel({ deltaY: 400 })
    expect(zoomTransform(viewport())).toEqual(t)
  })

  it('stops with the top of the content at the top margin', async () => {
    await mount(many())
    await wheelMany(10, { deltaY: 400 })
    await wheelMany(40, { deltaY: -400 })
    expect(screen().top).toBeCloseTo(win().top)
  })

  it('keeps content narrower than the pane inside it when scrolled sideways', async () => {
    await mount(many())
    await wheelMany(20, { deltaX: 400 })
    expect(screen().left).toBeCloseTo(win().left)
    await wheelMany(20, { deltaX: -400 })
    expect(screen().right).toBeCloseTo(win().right)
  })

  it('keeps a small collection entirely on screen in every direction', async () => {
    // Tall enough a pane that 1 document × 2 pages (plus the "Add document" row) fits in it.
    vpSize.h = 1100
    await mount([doc('a', 2)])
    const fitted = screen()
    expect(fitted.bottom - fitted.top).toBeLessThan(win().bottom - win().top)
    for (const init of [{ deltaY: 500 }, { deltaY: -500 }, { deltaX: 500 }, { deltaX: -500 }]) {
      await wheelMany(20, init)
    }
    const s = screen()
    expect(s.top).toBeGreaterThanOrEqual(win().top)
    expect(s.bottom).toBeLessThanOrEqual(win().bottom)
    expect(s.left).toBeGreaterThanOrEqual(win().left)
  })
})

describe('the edge add-page button', () => {
  it('can be scrolled fully into view however far the view is zoomed in', async () => {
    // Five letter pages fill the row, so the round "Add page" button straddles the card's edge.
    await mount([doc('a', 5)])
    const layout = computeLayout(docs, undefined, wrapWidthForViewport(vpSize.w))
    expect(layout.items[0].addPage.edge).toBe(true)
    await wheelMany(3, { deltaY: -50, ctrlKey: true, clientX: 700, clientY: 450 })
    for (let i = 0; i < 40; i++) await wheel({ deltaX: 2000 })
    const t = zoomTransform(viewport())
    expect(t.applyX(panReachWidth(layout))).toBeCloseTo(vpSize.w - PAN_SIDE_MARGIN)
    expect(t.applyX(layout.contentWidth)).toBeLessThan(vpSize.w - PAN_SIDE_MARGIN)
  })
})

describe('zooming', () => {
  it('ctrl+wheel out to the minimum scale at a corner keeps the content on screen', async () => {
    await mount(many())
    await wheelMany(10, { deltaY: 300 })
    await wheelMany(30, { deltaY: 50, ctrlKey: true, clientX: 0, clientY: 0 })
    expect(screen().k).toBeCloseTo(MIN_SCALE)
    // At the minimum the whole collection is a small block inside the window, and stays there.
    for (const init of [{ deltaY: 900 }, { deltaY: -900 }, { deltaX: 900 }, { deltaX: -900 }]) {
      await wheelMany(10, init)
    }
  })

  it('ctrl+wheel in at a corner keeps the content covering the window', async () => {
    await mount(many())
    await wheelMany(30, {
      deltaY: -50,
      ctrlKey: true,
      clientX: vpSize.w,
      clientY: vpSize.h
    })
    await wheelMany(30, { deltaY: -50, ctrlKey: true, clientX: 0, clientY: 0 })
    const s = screen()
    expect(s.left).toBeLessThanOrEqual(win().left)
    expect(s.top).toBeLessThanOrEqual(win().top)
  })

  it('the zoom-out button down to the minimum keeps the content on screen', async () => {
    await mount(many())
    await wheelMany(5, { deltaY: 400 })
    for (let i = 0; i < 20; i++) {
      await act(async () => handle!.zoomOut())
      expectInBounds()
    }
    for (let i = 0; i < 20; i++) {
      await act(async () => handle!.zoomIn())
      expectInBounds()
    }
  })
})

describe('drag panning', () => {
  it('stops at the top and at the end of the content', async () => {
    await mount(many())
    await drag([700, 450], [700, 8000])
    expect(screen().top).toBeCloseTo(win().top)
    await drag([700, 450], [700, -30000], 30)
    expect(screen().bottom).toBeCloseTo(win().bottom)
  })

  it('keeps the grabbed point under the pointer once the pointer comes back from a bound', async () => {
    await mount(many())
    await wheelMany(3, { deltaY: 400 })
    const start = zoomTransform(viewport())
    // Past the top by far: pinned there. Then back the other way in the same drag: the view picks
    // up again as soon as the grabbed point is back within reach, and ends where it started.
    await pointerDown(700, 450)
    const ys = [1500, 3000, 2000, 900, 700, 450]
    let prevTop = Infinity
    for (const y of ys) {
      await pointerMove(700, y)
      expectInBounds()
      if (y <= 2000) {
        // Never a jump: the content's top only follows the pointer back up.
        expect(screen().top).toBeLessThanOrEqual(prevTop + 1e-6)
      }
      prevTop = screen().top
    }
    await pointerUp(700, 450)
    const end = zoomTransform(viewport())
    expect(end.y).toBeCloseTo(start.y)
    expect(end.x).toBeCloseTo(start.x)
  })

  it('pans zoomed-in content sideways only until its edges reach the side margins', async () => {
    await mount(many())
    // Two notches: about 8×, so the column is several panes wide.
    await wheelMany(2, {
      deltaY: -50,
      ctrlKey: true,
      clientX: vpSize.w / 2,
      clientY: vpSize.h / 2
    })
    await drag([700, 450], [9000, 450])
    expect(screen().left).toBeCloseTo(win().left)
    await drag([700, 450], [-20000, 450], 20)
    expect(screen().right).toBeCloseTo(win().right)
  })

  it('keeps a small collection, zoomed all the way out, inside the window', async () => {
    await mount([doc('a', 2)])
    await wheelMany(30, { deltaY: 50, ctrlKey: true, clientX: 700, clientY: 450 })
    for (const to of [
      [700, -5000],
      [700, 5000],
      [-5000, 450],
      [5000, 450]
    ] as const) {
      await drag([700, 450], [to[0], to[1]])
    }
  })
})

describe('programmatic moves', () => {
  it('a resize keeps a view at the end of the content at the new end', async () => {
    await mount(many())
    await wheelMany(40, { deltaY: 400 })
    await resize(1400, 1200)
    expectInBounds()
    expect(screen().bottom).toBeCloseTo(win().bottom)
    await resize(1000, 700)
    expectInBounds()
  })

  it('importing a short document at the end focuses it within the bounds', async () => {
    await mount(many())
    docs = [...many(), doc('e', 1)]
    await act(async () => setDocs(docs))
    await settle()
    expectInBounds()
    expect(screen().bottom).toBeCloseTo(win().bottom)
  })
})
