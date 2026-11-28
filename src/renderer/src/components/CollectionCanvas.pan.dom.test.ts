// Pan bounds: however the view is moved — wheel scroll, drag, ctrl+wheel or button zoom, the
// import fit, a resize — the documents never leave the screen. Content taller (wider) than the
// window inside the toolbar/bottom (side) margins pans only until an edge reaches that margin;
// shorter (narrower) content stays entirely inside it.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { zoomTransform, type ZoomTransform } from 'd3-zoom'

vi.mock('./collection/DocLayer', () => ({ DocLayer: () => null }))
vi.mock('./collection/HeaderLayer', () => ({ HeaderLayer: () => null }))

import { CollectionCanvas } from './CollectionCanvas'
import type { CanvasHandle } from './Canvas'
import { computeLayout, panReachWidth, wrapWidthForViewport, type Rect } from '../canvas/layout'
import { boundTransform } from '../canvas/constrain'
import { computeRevealTransform } from '../canvas/reveal-transform'
import {
  FIT_ANIMATION_MS,
  MAX_SCALE,
  MIN_SCALE,
  PAN_BOTTOM_MARGIN,
  PAN_SIDE_MARGIN,
  PAN_TOP_MARGIN,
  REVEAL_BOTTOM_MARGIN,
  REVEAL_SIDE_MARGIN,
  REVEAL_TOP_MARGIN
} from '../canvas/zoom-constants'
import { doc } from '../canvas/test-utils/layout-fixtures'
import type { DocEntry } from '../types'

const vpSize = { w: 1400, h: 900 }

let setDocs: (docs: DocEntry[]) => void = () => {}
let setFindOpen: (open: boolean) => void = () => {}
let setDragKind: (kind: 'internal' | null) => void = () => {}
let handle: CanvasHandle | null = null

function Harness({ initial }: { initial: DocEntry[] }): ReactNode {
  const [docs, set] = useState(initial)
  const [wrap, setWrap] = useState<number | undefined>(undefined)
  const [findOpen, setFind] = useState(false)
  const [dragKind, setDrag] = useState<'internal' | null>(null)
  setDocs = set
  setFindOpen = setFind
  setDragKind = setDrag
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
    dragKind,
    draggingPage: null,
    dropTarget: null,
    collapsedId: null,
    externalCount: 0,
    findOpen,
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

/**
 * Asserts the bounds hold on both axes, whatever the content's size on screen. `topReach`: how far
 * down the top of tall content may be (the find bar open: REVEAL_TOP_MARGIN).
 */
function expectInBounds(topReach: number = PAN_TOP_MARGIN): void {
  const s = screen()
  const w = win()
  const eps = 1e-6
  if (s.bottom - s.top >= w.bottom - w.top) {
    expect(s.top).toBeLessThanOrEqual(topReach + eps)
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
  it('can be scrolled fully into view when zoomed well in', async () => {
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

describe('the edge add-page button, zoomed all the way in', () => {
  it('never lets the view be panned right to an empty screen', async () => {
    await mount([doc('a', 5)])
    const layout = computeLayout(docs, undefined, wrapWidthForViewport(vpSize.w))
    expect(layout.items[0].addPage.edge).toBe(true)
    await wheelMany(40, { deltaY: -50, ctrlKey: true, clientX: 700, clientY: 450 })
    expect(screen().k).toBeCloseTo(MAX_SCALE)
    for (let i = 0; i < 200; i++) await wheel({ deltaX: 3000 })
    for (let i = 0; i < 200; i++) await wheel({ deltaY: 3000 })
    // The button's outer half is 16 × 90 = 1440 px here, wider than the pane: the cards still fill
    // at least half of it.
    const s = screen()
    expect(s.right).toBeGreaterThanOrEqual(vpSize.w / 2 - 1e-6)
    expect(s.left).toBeLessThan(0)
    expect(s.top).toBeLessThan(0)
    expect(s.bottom).toBeCloseTo(win().bottom)
  })
})

describe('tween frames', () => {
  it('keeps every frame of the zoom-out back to the fit inside the bounds', async () => {
    await mount(many())
    // Zoomed far in at the top-left corner: the fit tween from here zooms out across it.
    await wheelMany(20, { deltaY: -50, ctrlKey: true, clientX: 0, clientY: 0 })
    expect(screen().k).toBeGreaterThan(3)
    await act(async () => handle!.reset())
    const seen = new Set<string>()
    for (let i = 0; i < 60; i++) {
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 8)))
      expectInBounds()
      const t = zoomTransform(viewport())
      seen.add(`${t.x},${t.y},${t.k}`)
    }
    expect(seen.size).toBeGreaterThan(3)
  })
})

describe("Find's reveal", () => {
  const margins = { top: REVEAL_TOP_MARGIN, bottom: REVEAL_BOTTOM_MARGIN, side: REVEAL_SIDE_MARGIN }
  const layoutNow = (): ReturnType<typeof computeLayout> =>
    computeLayout(docs, undefined, wrapWidthForViewport(vpSize.w))
  const firstPage = (): Rect => layoutNow().items[0].pages[0]

  it('measures a reveal asked for mid-tween against the BOUNDED target of the running one', async () => {
    await mount(many())
    await wheelMany(10, { deltaY: 400 })
    const t0 = zoomTransform(viewport())
    const page0 = firstPage()
    const { contentWidth, contentHeight } = layoutNow()
    const raw1 = computeRevealTransform(t0, vpSize, page0, margins, contentHeight)!
    const b1 = boundTransform(
      raw1,
      [
        [0, 0],
        [vpSize.w, vpSize.h]
      ],
      [
        [0, 0],
        [contentWidth, contentHeight]
      ]
    )
    // The reveal of the first page is held by the 72 px top bound.
    expect(b1.y).toBeLessThan(raw1.y - 26)
    // A rect whose bottom is 50 px above the pane's bottom under the bounded target — in view
    // there — but, under the raw one, 52 px further down: past the bottom reveal margin.
    const h = 100
    const r2: Rect = { x: page0.x, y: b1.invertY(vpSize.h - 50) - h, w: page0.w, h }
    await act(async () => handle!.revealRect(page0))
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 40)))
    await act(async () => handle!.revealRect(r2))
    await settle()
    const end = zoomTransform(viewport())
    expect(end.x).toBeCloseTo(b1.x)
    expect(end.y).toBeCloseTo(b1.y)
    expect(end.k).toBeCloseTo(b1.k)
  })

  it('runs no tween when the bounded reveal goes nowhere', async () => {
    // A narrow pane: the fit comes up below 100%, so the first page's top (72 + 52k) is above the
    // find bar's 124 px, and — the bar closed — the reveal can't bring it lower than the top bound
    // already holds it. A do-nothing tween would still end by marking the view user-moved.
    vpSize.w = 700
    await mount(many())
    const before = zoomTransform(viewport())
    expect(before.k).toBeLessThan(1)
    expect(before.applyY(0)).toBeCloseTo(PAN_TOP_MARGIN)
    const { contentHeight } = layoutNow()
    expect(computeRevealTransform(before, vpSize, firstPage(), margins, contentHeight)).not.toBe(
      null
    )
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame')
    try {
      await act(async () => handle!.revealRect(firstPage()))
      await settle()
      expect(raf).not.toHaveBeenCalled()
    } finally {
      raf.mockRestore()
    }
    expect(zoomTransform(viewport())).toEqual(before)
  })

  it('with the find bar open, brings a first-row page fully below it, then gives the space back', async () => {
    vpSize.w = 700
    await mount(many())
    const before = zoomTransform(viewport())
    expect(before.k).toBeLessThan(1)
    // Opening the bar moves nothing.
    await act(async () => setFindOpen(true))
    expect(zoomTransform(viewport())).toEqual(before)
    await act(async () => handle!.revealRect(firstPage()))
    await settle()
    // The content's top comes down to the bar's bottom: the page is fully below the bar.
    const t = zoomTransform(viewport())
    expect(screen().top).toBeCloseTo(REVEAL_TOP_MARGIN)
    expect(t.applyY(firstPage().y)).toBeGreaterThan(REVEAL_TOP_MARGIN)
    expectInBounds(REVEAL_TOP_MARGIN)
    // The content's top can't come further down than the bar's bottom.
    for (let i = 0; i < 10; i++) {
      await wheel({ deltaY: -400 })
      expectInBounds(REVEAL_TOP_MARGIN)
    }
    expect(screen().top).toBeCloseTo(REVEAL_TOP_MARGIN)
    // Closing the bar pulls the top back to the toolbar margin.
    await act(async () => setFindOpen(false))
    expectInBounds()
    expect(screen().top).toBeCloseTo(PAN_TOP_MARGIN)
  })
})

describe('reduced motion', () => {
  let savedMatchMedia: PropertyDescriptor | undefined
  beforeEach(() => {
    savedMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query.includes('prefers-reduced-motion: reduce'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false
      })
    })
  })
  afterEach(() => {
    if (savedMatchMedia) Object.defineProperty(window, 'matchMedia', savedMatchMedia)
    else delete (window as { matchMedia?: unknown }).matchMedia
  })

  /** Scrolled to the end, the content gets shorter: the view must follow it to the new end. */
  async function shrinkAtEnd(): Promise<void> {
    await wheelMany(40, { deltaY: 2000 })
    expect(screen().bottom).toBeCloseTo(win().bottom)
    docs = [doc('a', 12)]
    await act(async () => setDocs(docs))
    await settle()
    expectInBounds()
    expect(screen().bottom).toBeCloseTo(win().bottom)
  }

  it('keeps the view in bounds after a fit (the reset button)', async () => {
    await mount(many())
    await wheelMany(3, { deltaY: 400 })
    await act(async () => handle!.reset())
    await shrinkAtEnd()
  })

  it('keeps the view in bounds after an import', async () => {
    await mount(many().slice(0, 3))
    docs = many()
    await act(async () => setDocs(docs))
    await settle()
    await shrinkAtEnd()
  })

  it("keeps the view in bounds after Find's reveal", async () => {
    await mount(many())
    const layout = computeLayout(docs, undefined, wrapWidthForViewport(vpSize.w))
    await act(async () => handle!.revealRect(layout.items[2].pages[6]))
    await settle()
    await shrinkAtEnd()
  })
})

describe('mid-drag', () => {
  it('leaves the view alone while a drag is in flight, and bounds it once the drag ends', async () => {
    await mount(many())
    await wheelMany(40, { deltaY: 2000 })
    await act(async () => setDragKind('internal'))
    const during: ZoomTransform = zoomTransform(viewport())
    docs = [doc('a', 12)]
    await act(async () => setDocs(docs))
    await settle()
    expect(zoomTransform(viewport())).toEqual(during)
    await act(async () => setDragKind(null))
    await settle()
    expectInBounds()
    expect(screen().bottom).toBeCloseTo(win().bottom)
  })
})
