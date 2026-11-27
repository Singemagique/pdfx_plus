// Fit-on-import: adding documents re-fits the canvas and scrolls the first new one to the top —
// even after the user moved the view — while edits that add no document leave the view alone.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { zoomTransform } from 'd3-zoom'

// The card/page layers need pdf.js and the edit store; this test is about the viewport only.
vi.mock('./collection/DocLayer', () => ({ DocLayer: () => null }))
vi.mock('./collection/HeaderLayer', () => ({ HeaderLayer: () => null }))

import { CollectionCanvas } from './CollectionCanvas'
import { computeLayout, wrapWidthForViewport } from '../canvas/layout'
import { FIT_ANIMATION_MS, FIT_MARGIN, FIT_TOP_MARGIN } from '../canvas/zoom-constants'
import { movePageToNewDoc } from '../app/doc-ops/move'
import { doc } from '../canvas/test-utils/layout-fixtures'
import type { DocEntry } from '../types'

const VP_W = 1400
const VP_H = 900
/** The canvas viewport's current (mutable, for resize tests) css size. */
const vpSize = { w: VP_W, h: VP_H }

let setDocs: (docs: DocEntry[]) => void = () => {}
let setBusy: (busy: boolean) => void = () => {}

function Harness({ initial }: { initial: DocEntry[] }): ReactNode {
  const [docs, set] = useState(initial)
  const [wrap, setWrap] = useState<number | undefined>(undefined)
  const [busy, setBusyState] = useState(false)
  setDocs = set
  setBusy = setBusyState
  const layout = computeLayout(docs, undefined, wrap)
  const noop = (): void => {}
  return createElement(CollectionCanvas, {
    docs,
    layout,
    busy,
    pagesDraggable: true,
    renderVersion: 0,
    selected: null,
    hiddenPageId: null,
    dragKind: null,
    draggingPage: null,
    dropTarget: null,
    collapsedId: null,
    externalCount: 0,
    canvasRef: null,
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
  // jsdom has no layout: give the canvas viewport a size.
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
  // Records its callbacks so a test can fire a resize.
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

const viewport = (): HTMLDivElement => container.querySelector('.canvas-viewport') as HTMLDivElement
const transform = (): { x: number; y: number; k: number } => {
  const t = zoomTransform(viewport())
  return { x: t.x, y: t.y, k: t.k }
}
const settle = (): Promise<void> =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, FIT_ANIMATION_MS + 150)))
const wheel = (deltaY: number): Promise<void> =>
  act(async () => {
    viewport().dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }))
  })
const layoutOf = (docs: DocEntry[], vpW = VP_W): ReturnType<typeof computeLayout> =>
  computeLayout(docs, undefined, wrapWidthForViewport(vpW))
/** Resize the viewport and let the debounced observer report it. */
const resize = async (w: number, h = vpSize.h): Promise<void> => {
  vpSize.w = w
  vpSize.h = h
  observers.forEach((cb) => cb())
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 150)))
}

// a: 12 pages (3 rows), b: 20 pages (5 rows) — tall enough that b's top can reach the top margin.
const a = doc('a', 12)
const b = doc('b', 20)

beforeEach(async () => {
  vpSize.w = VP_W
  vpSize.h = VP_H
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(createElement(Harness, { initial: [a] })))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('fit on import', () => {
  it('fits the first document to the top of the view on mount', () => {
    expect(transform().y).toBeCloseTo(FIT_TOP_MARGIN)
    expect(transform().k).toBeGreaterThan(0.9)
  })

  it('scrolls to the first new document even after the user moved the view', async () => {
    await wheel(400)
    const moved = transform()
    expect(moved.y).toBeLessThan(FIT_TOP_MARGIN - 300)

    await act(async () => setDocs([a, b]))
    await settle()

    const t = transform()
    const bTop = layoutOf([a, b]).items[1].y
    expect(bTop).toBeGreaterThan(0)
    // b's card top sits at the top margin.
    expect(FIT_TOP_MARGIN - bTop * t.k).toBeCloseTo(t.y, 0)
  })

  it('brings a short document appended at the very end into view', async () => {
    await act(async () => setDocs([a, b]))
    await settle()
    await wheel(-2000)
    const c = doc('c', 1)
    await act(async () => setDocs([a, b, c]))
    await settle()
    const t = transform()
    const cTop = layoutOf([a, b, c]).items[2].y
    // Too close to the end to reach the top margin: the fit stops at the end of the content, with
    // c's card on screen below the toolbar.
    expect(t.y + cTop * t.k).toBeGreaterThan(FIT_TOP_MARGIN)
    expect(t.y + cTop * t.k).toBeLessThan(VP_H / 2)
  })

  it('does not move the view on a reorder, delete, or page dragged out to a new document', async () => {
    await act(async () => setDocs([a, b]))
    await settle()
    await wheel(250)
    const before = transform()

    await act(async () => setDocs([b, a]))
    await settle()
    expect(transform()).toEqual(before)

    await act(async () => setDocs([b]))
    await settle()
    expect(transform()).toEqual(before)

    await act(async () =>
      setDocs(movePageToNewDoc([b], { docId: 'b', pageId: 'b-p3' }, 1, 'split'))
    )
    await settle()
    expect(transform()).toEqual(before)
  })
})

describe('fit on a multi-file import', () => {
  const c = doc('c', 20)
  const d = doc('d', 20)
  /** Import `batches` the way addFiles does: busy on, one commit per file, busy off with the last. */
  const importBatch = async (...steps: DocEntry[][]): Promise<void> => {
    await act(async () => setBusy(true))
    for (const [i, docs] of steps.entries()) {
      await act(async () => {
        setDocs(docs)
        if (i === steps.length - 1) setBusy(false)
      })
      await settle()
    }
  }
  const topOnScreen = (docs: DocEntry[], index: number): number => {
    const t = transform()
    return t.y + layoutOf(docs).items[index].y * t.k
  }

  it('lands on the FIRST document of the batch, not the last file to load', async () => {
    await wheel(400)
    await importBatch([a, b], [a, b, c], [a, b, c, d])
    expect(topOnScreen([a, b, c, d], 1)).toBeCloseTo(FIT_TOP_MARGIN, 0)
  })

  it('starts a fresh focus for the next import once the batch is over', async () => {
    await importBatch([a, b])
    expect(topOnScreen([a, b], 1)).toBeCloseTo(FIT_TOP_MARGIN, 0)
    await importBatch([a, b, c], [a, b, c, d])
    expect(topOnScreen([a, b, c, d], 2)).toBeCloseTo(FIT_TOP_MARGIN, 0)
  })
})

describe('fit on viewport resize', () => {
  it('re-fits an unmoved view even when the narrower width does not re-wrap', async () => {
    // 840 and 720 css px both wrap at MIN_DOC_WIDTH, so the layout is identical at both.
    await resize(840)
    await act(async () => setDocs([a, b]))
    await settle()
    const cw = layoutOf([a, b], 840).contentWidth
    expect(layoutOf([a, b], 720).contentWidth).toBe(cw)
    expect(transform().k).toBeCloseTo((840 * FIT_MARGIN) / cw)

    await resize(720)
    const t = transform()
    expect(t.k).toBeCloseTo((720 * FIT_MARGIN) / cw)
    // Nothing clipped on the right, and b — at the top before the resize — is still at the top.
    expect(t.x + cw * t.k).toBeLessThanOrEqual(720)
    expect(t.y + layoutOf([a, b], 720).items[1].y * t.k).toBeCloseTo(FIT_TOP_MARGIN, 0)
  })

  it('re-wraps and re-fits on a resize that changes the columns', async () => {
    await resize(900)
    const t = transform()
    const layout = layoutOf([a], 900)
    expect(layout.items[0].pages.filter((p) => p.row === 0)).toHaveLength(3)
    expect(t.k).toBeCloseTo((900 * FIT_MARGIN) / layout.contentWidth)
  })

  it('leaves a view the user moved alone', async () => {
    await resize(840)
    await wheel(200)
    const before = transform()
    await resize(720)
    expect(transform()).toEqual(before)
  })
})
