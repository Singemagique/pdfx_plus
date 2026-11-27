// Find in the collection canvas: matches ring their page cells (the current one more strongly),
// and stepping to a match far down the collection animates the view to it — unless a page drag is
// in flight.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { zoomTransform } from 'd3-zoom'

vi.mock('./PageView', () => ({ PageView: () => null }))

import { CollectionCanvas } from './CollectionCanvas'
import type { CanvasHandle } from './Canvas'
import { computeLayout, type CanvasLayout } from '../canvas/layout'
import { FIT_ANIMATION_MS, REVEAL_ANIMATION_MS } from '../canvas/zoom-constants'
import { EditProvider, useEditStore } from '../edit/EditProvider'
import { FindProvider } from '../search/FindContext'
import { createFindController, type FindController } from '../search/find-controller'
import { createFindEngine } from '../search/engine'
import { buildPageText, type PageText } from '../search/extract'
import type { DocEntry, PageEntry, PdfSource } from '../types'

const VP_W = 1400
const VP_H = 900

type FakePdf = { texts: string[] }

function docOf(id: string, texts: string[]): DocEntry {
  const src = { id: `src-${id}`, bytes: new Uint8Array(), pdf: { texts } } as unknown as PdfSource
  return {
    id,
    name: `${id}.pdf`,
    pages: texts.map(
      (_, i): PageEntry => ({
        id: `${id}-p${i}`,
        source: src,
        pageIndex: i,
        width: 612,
        height: 792
      })
    )
  }
}

const filler = (n: number, words: Record<number, string> = {}): string[] =>
  Array.from({ length: n }, (_, i) => words[i] ?? `plain page ${i}`)

// 3 documents × 12 pages; "zebra" only near the end of the last one, "apple" on the first page,
// "okapi" at the top, in the middle and near the end.
const DOCS = [
  docOf('a', filler(12, { 0: 'an apple okapi' })),
  docOf('b', filler(12, { 6: 'okapi' })),
  docOf('c', filler(12, { 10: 'a zebra okapi', 11: 'another zebra' }))
]

const extract = async (pdf: unknown, pageIndex: number): Promise<PageText> => {
  const s = (pdf as FakePdf).texts[pageIndex] ?? ''
  return buildPageText(
    [
      {
        str: s,
        t: [10, 0, 0, 10, 50, 700],
        width: s.length * 5,
        height: 10,
        ascent: 0.8,
        descent: -0.2,
        vertical: false,
        rtl: false,
        hasEOL: false
      }
    ],
    [1, 0, 0, -1, 0, 792]
  )
}

let ctl: FindController
let canvas: CanvasHandle | null = null
const layoutRef: { current: CanvasLayout | null } = { current: null }
const reveal = vi.fn()

function Harness({ dragging }: { dragging: boolean }): ReactNode {
  const store = useEditStore()
  const [wrap, setWrap] = useState<number | undefined>(undefined)
  const layout = computeLayout(DOCS, undefined, wrap)
  layoutRef.current = layout
  const noop = (): void => {}
  const canvasEl = createElement(CollectionCanvas, {
    docs: DOCS,
    layout,
    busy: false,
    pagesDraggable: true,
    renderVersion: 0,
    selected: null,
    hiddenPageId: null,
    dragKind: dragging ? 'internal' : null,
    draggingPage: null,
    dropTarget: null,
    collapsedId: null,
    externalCount: 0,
    canvasRef: (h: CanvasHandle | null) => {
      canvas = h
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
  return createElement(EditProvider, {
    store,
    children: createElement(FindProvider, { value: ctl, children: canvasEl })
  })
}

const sizeProps = ['clientWidth', 'clientHeight'] as const
const saved = sizeProps.map((p) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, p))

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  for (const [prop, v] of [
    ['clientWidth', VP_W],
    ['clientHeight', VP_H]
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('canvas-viewport') ? v : 0
      }
    })
  }
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    }
  )
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

const wait = (ms: number): Promise<void> =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))

beforeEach(async () => {
  reveal.mockClear()
  ctl = createFindController({
    createEngine: (onChange) => createFindEngine({ onChange, extract: extract as never }),
    getAnchorPageId: () => null,
    onNavigate: (m) => {
      reveal(m.pageId)
      const slot = layoutRef.current?.items
        .find((i) => i.doc.id === m.docId)
        ?.pages.find((p) => p.pageId === m.pageId)
      if (slot) canvas?.revealRect(slot)
    }
  })
  ctl.setDocs(DOCS)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const render = async (dragging = false): Promise<void> => {
  await act(async () => root.render(createElement(Harness, { dragging })))
  await wait(FIT_ANIMATION_MS + 50)
}

const findFor = async (q: string): Promise<void> => {
  await act(async () => {
    ctl.open()
    ctl.setQuery(q)
  })
  await wait(400)
}

const cell = (pageId: string): HTMLElement =>
  container.querySelector(`.page[data-page-id="${pageId}"]`) as HTMLElement

const slotOf = (pageId: string) =>
  layoutRef.current!.items.flatMap((i) => i.pages).find((p) => p.pageId === pageId)!

/** The slot's on-screen box under the viewport's current transform. */
function onScreen(pageId: string): { top: number; bottom: number; left: number; right: number } {
  const t = zoomTransform(container.querySelector('.canvas-viewport') as HTMLElement)
  const s = slotOf(pageId)
  return {
    top: t.applyY(s.y),
    bottom: t.applyY(s.y + s.h),
    left: t.applyX(s.x),
    right: t.applyX(s.x + s.w)
  }
}

describe('Find in the collection canvas', () => {
  it('rings matching pages, the current one strongly, and moves with next()', async () => {
    await render()
    await findFor('zebra')
    expect(cell('c-p10').classList.contains('find-current')).toBe(true)
    expect(cell('c-p11').classList.contains('find-hit')).toBe(true)
    expect(cell('c-p11').classList.contains('find-current')).toBe(false)
    expect(cell('a-p0').className).not.toMatch(/find-/)
    expect(container.querySelectorAll('.page.find-hit, .page.find-current')).toHaveLength(2)

    await act(async () => ctl.next())
    expect(cell('c-p10').classList.contains('find-hit')).toBe(true)
    expect(cell('c-p11').classList.contains('find-current')).toBe(true)

    await act(async () => ctl.close())
    expect(container.querySelectorAll('.page.find-hit, .page.find-current')).toHaveLength(0)
  })

  it('animates the view to a match far down the collection', async () => {
    await render()
    const before = onScreen('c-p10')
    expect(before.top).toBeGreaterThan(VP_H)
    await findFor('zebra')
    expect(reveal).toHaveBeenCalledWith('c-p10')
    await wait(REVEAL_ANIMATION_MS + 100)
    const box = onScreen('c-p10')
    expect(box.top).toBeGreaterThanOrEqual(0)
    expect(box.bottom).toBeLessThanOrEqual(VP_H)
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.right).toBeLessThanOrEqual(VP_W)
  })

  it('leaves an already-visible match where it is', async () => {
    await render()
    const t0 = zoomTransform(container.querySelector('.canvas-viewport') as HTMLElement)
    await findFor('apple')
    expect(reveal).toHaveBeenCalledWith('a-p0')
    await wait(REVEAL_ANIMATION_MS + 100)
    const t1 = zoomTransform(container.querySelector('.canvas-viewport') as HTMLElement)
    expect([t1.x, t1.y, t1.k]).toEqual([t0.x, t0.y, t0.k])
  })

  // Stepping again while the previous reveal is still tweening: the new page may be on screen at
  // that instant and yet be carried off by the rest of the tween.
  it.each([20, 40, 60, 100])(
    'keeps the page in view when stepping again %i ms into a reveal',
    async (gap) => {
      await render()
      await findFor('okapi')
      expect(ctl.getCurrentMatch()?.pageId).toBe('a-p0')
      await act(async () => ctl.prev()) // wraps to c-p10, far below
      await wait(gap)
      await act(async () => ctl.prev()) // b-p6
      expect(ctl.getCurrentMatch()?.pageId).toBe('b-p6')
      await wait(REVEAL_ANIMATION_MS + 100)
      const box = onScreen('b-p6')
      expect(box.top).toBeGreaterThanOrEqual(0)
      expect(box.bottom).toBeLessThanOrEqual(VP_H)
    }
  )

  it('does not move the view while a page is being dragged', async () => {
    await render(true)
    const t0 = zoomTransform(container.querySelector('.canvas-viewport') as HTMLElement)
    await findFor('zebra')
    expect(reveal).toHaveBeenCalledWith('c-p10')
    await wait(REVEAL_ANIMATION_MS + 100)
    const t1 = zoomTransform(container.querySelector('.canvas-viewport') as HTMLElement)
    expect([t1.x, t1.y, t1.k]).toEqual([t0.x, t0.y, t0.k])
  })
})
