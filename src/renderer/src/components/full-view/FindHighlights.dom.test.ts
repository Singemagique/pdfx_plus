// Find highlights in full view: drawn inside `.full-page` at the fit scale (the box's own CSS
// transform carries any rotation/zoom), only on the current page once it has landed.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.hoisted(() => {
  // geometry.ts reads window.api.platform at import time.
  ;(window as unknown as { api: { platform: string } }).api = { platform: 'win32' }
})
vi.mock('../PageView', () => ({ PageView: () => null }))
vi.mock('../edit/OverlayLayer', () => ({ OverlayLayer: () => null }))

import { FullViewPage } from './FullViewPage'
import { EditProvider, useEditStore, type EditStore } from '../../edit/EditProvider'
import { makePageKey } from '../../edit/model'
import { FindProvider, NULL_FIND_CONTROLLER } from '../../search/FindContext'
import type { FindController, PageHighlight } from '../../search/find-controller'
import type { PageEntry } from '../../types'

const page: PageEntry = {
  id: 'pg-1',
  source: { id: 'src-1', bytes: new Uint8Array(), pdf: {} as PageEntry['source']['pdf'] },
  pageIndex: 0,
  width: 612,
  height: 792
}

const HIGHLIGHTS: PageHighlight[] = [
  { rect: { x: 100, y: 80, w: 60, h: 12 }, current: false },
  { rect: { x: 100, y: 400, w: 30, h: 12 }, current: true }
]

const controller: FindController = {
  ...NULL_FIND_CONTROLLER,
  getPageHighlights: (id) => (id === page.id ? HIGHLIGHTS : [])
}

const VIEWPORT = { w: 1200, h: 900 }
let store: EditStore = null as unknown as EditStore

function Harness(props: {
  isCurrent?: boolean
  animating?: boolean
  provider?: boolean
}): ReactNode {
  const s = useEditStore()
  store = s
  const child = createElement(FullViewPage, {
    page,
    viewport: VIEWPORT,
    isCurrent: props.isCurrent ?? true,
    view: { zoom: 1, x: 0, y: 0 },
    zoomed: false,
    interactive: true,
    animating: props.animating ?? false,
    flip: null,
    flipTransition: false,
    renderVersion: 0,
    resetView: () => {},
    applyZoom: () => {}
  })
  const inner =
    props.provider === false
      ? child
      : createElement(FindProvider, { value: controller, children: child })
  return createElement(EditProvider, { store: s, children: inner })
}

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const render = (props: Parameters<typeof Harness>[0] = {}): Promise<void> =>
  act(async () => root.render(createElement(Harness, props)))

const rects = (): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>('.find-hl'))
const px = (v: string): number => parseFloat(v)

describe('FindHighlights in full view', () => {
  it('draws each match inside .full-page at the fit scale, the current one emphasised', async () => {
    await render()
    const box = container.querySelector('.full-page') as HTMLElement
    const layer = box.querySelector('.find-hl-layer')
    expect(layer).not.toBeNull()
    const s = px(box.style.width) / page.width
    expect(s).toBeCloseTo(900 / 792)
    const [a, b] = rects()
    expect(px(a.style.left)).toBeCloseTo(100 * s)
    expect(px(a.style.top)).toBeCloseTo(80 * s)
    expect(px(a.style.width)).toBeCloseTo(60 * s)
    expect(px(a.style.height)).toBeCloseTo(12 * s)
    expect(a.classList.contains('current')).toBe(false)
    expect(b.classList.contains('current')).toBe(true)
  })

  it('keeps upright page coordinates on a rotated page (the box carries the rotation)', async () => {
    await render()
    await act(async () => store.rotatePage(makePageKey(page.source.id, page.pageIndex), 90))
    const box = container.querySelector('.full-page') as HTMLElement
    expect(box.style.transform).toContain('rotate(90deg)')
    // Rotated, the upright box is fitted by its height into the viewport's width.
    const s = px(box.style.width) / page.width
    expect(px(box.style.height)).toBeCloseTo(page.height * s)
    const [a] = rects()
    expect(px(a.style.left)).toBeCloseTo(100 * s)
    expect(px(a.style.top)).toBeCloseTo(80 * s)
  })

  it('on a cropped page, draws in the full-page frame and skips matches outside the crop', async () => {
    await render()
    // Window x ∈ [50, 400], y ∈ [0, 300] (top-left): holds the first match, not the second.
    const key = makePageKey(page.source.id, page.pageIndex)
    await act(async () => store.setCrop(key, { x: 50, y: 492, w: 350, h: 300 }))
    const frame = container.querySelector('.full-page .page-frame') as HTMLElement
    expect(frame.querySelector('.find-hl-layer')).not.toBeNull()
    const s = px(frame.style.width) / page.width
    const drawn = rects()
    expect(drawn).toHaveLength(1)
    expect(drawn[0].classList.contains('current')).toBe(false)
    expect(px(drawn[0].style.left)).toBeCloseTo(100 * s)
    expect(px(drawn[0].style.top)).toBeCloseTo(80 * s)
    // Uncropped again, both are drawn.
    await act(async () => store.setCrop(key, null))
    expect(rects()).toHaveLength(2)
  })

  it('draws nothing on a page that is not current, or while animating', async () => {
    await render({ isCurrent: false })
    expect(rects()).toHaveLength(0)
    await render({ animating: true })
    expect(rects()).toHaveLength(0)
    await render()
    expect(rects()).toHaveLength(2)
  })

  it('draws nothing without a find provider', async () => {
    await render({ provider: false })
    expect(container.querySelector('.find-hl-layer')).toBeNull()
  })
})
