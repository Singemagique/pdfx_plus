// FullView's own crop-aware frame: the zoom/pan clamp uses the DISPLAYED (cropped) fit, zoom and
// pan reset whenever that frame changes (crop tool on/off, crop undone), and the open/close FLIP
// always animates the exported (cropped) box so it lands on the collection cell's cropped aspect —
// even with the crop tool on, which shows the page whole only once the view is open.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

type Clip = { x0: number; y0: number; x1: number; y1: number } | null | undefined
const { pageViewProps, zoomListeners } = vi.hoisted(() => {
  const zoomListeners: Array<(action: 'in' | 'out' | 'reset') => void> = []
  // geometry.ts reads window.api.platform at import time; the input hook subscribes to onZoom.
  ;(window as unknown as { api: unknown }).api = {
    platform: 'win32',
    onZoom: (cb: (action: 'in' | 'out' | 'reset') => void) => {
      zoomListeners.push(cb)
      return () => zoomListeners.splice(zoomListeners.indexOf(cb), 1)
    }
  }
  return { pageViewProps: [] as Array<{ clip?: Clip }>, zoomListeners }
})
vi.mock('./PageView', () => ({
  PageView: (props: { clip?: Clip }) => {
    pageViewProps.push(props)
    return null
  }
}))
vi.mock('./edit/OverlayLayer', () => ({ OverlayLayer: () => null }))
vi.mock('./full-view/FindHighlights', () => ({ FindHighlights: () => null }))
vi.mock('./full-view/FullViewChrome', () => ({ FullViewChrome: () => null }))

import { FullView } from './FullView'
import { EditProvider, useEditStore, type EditStore } from '../edit/EditProvider'
import { makePageKey } from '../edit/model'
import type { DocEntry, PageEntry } from '../types'
import type { Rect } from './full-view/geometry'

const page: PageEntry = {
  id: 'pg-1',
  source: { id: 'src-1', bytes: new Uint8Array(), pdf: {} as PageEntry['source']['pdf'] },
  pageIndex: 0,
  width: 612,
  height: 792
}
const docs: DocEntry[] = [{ id: 'doc-1', name: 'a.pdf', pages: [page] }]
const key = makePageKey(page.source.id, page.pageIndex)
// A full-width strip 100 pt tall: displayed 612 × 100, wildly unlike the 612 × 792 page.
const STRIP = { x: 0, y: 0, w: 612, h: 100 }

// jsdom's window is 1024 × 768.
const VP = { w: 1024, h: 768 }
const stripFit = { w: 1024, h: (100 * 1024) / 612 } // fitInto(612, 100, VP)
const wholeFit = { w: (612 * 768) / 792, h: 768 } // fitInto(612, 792, VP)

let store: EditStore = null as unknown as EditStore
const onClose = vi.fn()

function Harness({ originRect, show }: { originRect: Rect | null; show: boolean }): ReactNode {
  const s = useEditStore()
  store = s
  if (!show) return createElement(EditProvider, { store: s, children: null })
  const child = createElement(FullView, {
    docs,
    startDocId: 'doc-1',
    startPageId: 'pg-1',
    originRect,
    onActivePageChange: () => {},
    onClose
  })
  return createElement(EditProvider, { store: s, children: child })
}

let container: HTMLDivElement
let root: Root
let cell: HTMLDivElement

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom has no CSS.escape (close() uses it to find the page's cell); the ids here need none.
  const g = globalThis as { CSS?: { escape?: (s: string) => string } }
  if (!g.CSS?.escape) g.CSS = { ...g.CSS, escape: (s: string) => s }
})

beforeEach(() => {
  pageViewProps.length = 0
  onClose.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  cell?.remove()
})

const render = (originRect: Rect | null = null, show = true): Promise<void> =>
  act(async () => root.render(createElement(Harness, { originRect, show })))
const wait = (ms: number): Promise<void> => act(() => new Promise<void>((r) => setTimeout(r, ms)))
const zoomIn = (): Promise<void> => act(async () => zoomListeners.forEach((cb) => cb('in')))
const key$ = (k: string, times = 1): Promise<void> =>
  act(async () => {
    for (let i = 0; i < times; i++) window.dispatchEvent(new KeyboardEvent('keydown', { key: k }))
  })

const fullPage = (): HTMLElement => container.querySelector('.full-page') as HTMLElement
const px = (v: string): number => parseFloat(v)
/** The view the zoomed `.full-page` transform carries, or null when it is not zoomed. */
function view(): { x: number; y: number; zoom: number } | null {
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(
    fullPage().style.transform
  )
  return m ? { x: +m[1], y: +m[2], zoom: +m[3] } : null
}

describe('FullView zoom/pan clamp at the cropped geometry', () => {
  it('clamps pan to the displayed crop window, not the whole page', async () => {
    await render()
    await act(async () => store.setCrop(key, STRIP))
    await zoomIn()
    await zoomIn() // 1.96
    await key$('ArrowUp') // pan down 80 px: the zoomed strip is still shorter than the viewport
    await key$('ArrowLeft', 10) // pan right: clamped at the strip's half-overflow
    const v = view()!
    expect(v.zoom).toBeCloseTo(1.96)
    expect(v.y).toBeCloseTo(0) // whole page: min(80, (768 × 1.96 − 768) / 2) = 80
    expect(v.x).toBeCloseTo((stripFit.w * 1.96 - VP.w) / 2) // whole page: ≈ 69.6
  })
})

describe('FullView resets zoom when the displayed frame changes', () => {
  it('re-fits on entering/leaving the crop tool and on undoing the crop', async () => {
    await render()
    await act(async () => store.setCrop(key, STRIP))
    await zoomIn()
    expect(view()?.zoom).toBeCloseTo(1.4)

    await act(async () => store.setTool('crop'))
    expect(view()).toBeNull()
    expect(px(fullPage().style.width)).toBeCloseTo(wholeFit.w)

    await zoomIn()
    expect(view()?.zoom).toBeCloseTo(1.4)
    await act(async () => store.setTool('browse'))
    expect(view()).toBeNull()
    expect(px(fullPage().style.width)).toBeCloseTo(stripFit.w)

    await zoomIn()
    expect(view()?.zoom).toBeCloseTo(1.4)
    await act(async () => store.undo())
    expect(view()).toBeNull()
    expect(px(fullPage().style.height)).toBeCloseTo(wholeFit.h)
  })
})

describe('FullView open/close FLIP on a cropped page with the crop tool on', () => {
  // The collection cell has the cropped aspect (612 × 100).
  const CELL: Rect = { left: 100, top: 200, width: 306, height: 50 }
  const scaleOf = (t: string): number => +(/scale\(([-\d.e]+)\)/.exec(t)?.[1] ?? NaN)

  it('closes from the cropped box onto the cell, not a ballooning whole page', async () => {
    cell = document.createElement('div')
    cell.dataset.pageId = page.id
    cell.getBoundingClientRect = () =>
      ({ ...CELL, right: CELL.left + CELL.width, bottom: CELL.top + CELL.height }) as DOMRect
    document.body.appendChild(cell)

    await render()
    await act(async () => store.setCrop(key, STRIP))
    await act(async () => store.setTool('crop'))
    expect(px(fullPage().style.width)).toBeCloseTo(wholeFit.w) // whole page while open

    await key$('Escape')
    await wait(30) // the target transform is applied on the next animation frame
    const fp = fullPage()
    expect(px(fp.style.width)).toBeCloseTo(stripFit.w)
    expect(px(fp.style.height)).toBeCloseTo(stripFit.h)
    // flipTo(stripBox, VP, CELL): lands exactly on the cell.
    expect(scaleOf(fp.style.transform)).toBeCloseTo(CELL.width / stripFit.w)
    expect(fp.style.transform).toContain(`translate(${CELL.left}px, `)
    expect(scaleOf(fp.style.transform) * stripFit.h).toBeCloseTo(CELL.height)
    // …showing only the crop window while it animates.
    expect(pageViewProps.at(-1)?.clip).toBeTruthy()
  })

  it('opens from the cell at the cropped box, then shows the page whole for editing', async () => {
    // Crop and tool set before the view opens (the tool stays selected across close/reopen).
    await render(null, false)
    await act(async () => store.setCrop(key, STRIP))
    await act(async () => store.setTool('crop'))
    await render(CELL)
    const fp = fullPage()
    // Still opening (TRANSITION_MS has not elapsed): the exported, cropped box…
    expect(px(fp.style.width)).toBeCloseTo(stripFit.w)
    expect(px(fp.style.height)).toBeCloseTo(stripFit.h)
    expect(pageViewProps.at(-1)?.clip).toBeTruthy()
    await wait(420)
    // Open: the crop tool shows the whole page.
    expect(px(fullPage().style.width)).toBeCloseTo(wholeFit.w)
    expect(px(fullPage().style.height)).toBeCloseTo(wholeFit.h)
    expect(pageViewProps.at(-1)?.clip ?? null).toBeNull()
  })
})
