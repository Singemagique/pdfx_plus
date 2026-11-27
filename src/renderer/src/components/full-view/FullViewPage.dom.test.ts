// FullViewPage must tell PageView the CSS rotation its page box actually carries, so the detail
// canvas is planned in upright page coordinates: the page's rotation while open, but none during
// the open/close FLIP animation (whose transform has no rotate()).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

type Clip = { x0: number; y0: number; x1: number; y1: number } | null | undefined
const { pageViewProps, overlayProps, findProps } = vi.hoisted(() => {
  // geometry.ts reads window.api.platform at import time.
  ;(window as unknown as { api: { platform: string } }).api = { platform: 'win32' }
  return {
    pageViewProps: [] as Array<{ rotation?: number; clip?: Clip }>,
    overlayProps: [] as Array<{ fit: { w: number; h: number }; rot: number }>,
    findProps: [] as Array<{ box: { w: number; h: number }; window?: unknown }>
  }
})
vi.mock('../PageView', () => ({
  PageView: (props: { rotation?: number; clip?: Clip }) => {
    pageViewProps.push(props)
    return null
  }
}))
vi.mock('../edit/OverlayLayer', () => ({
  OverlayLayer: (props: { fit: { w: number; h: number }; rot: number }) => {
    overlayProps.push(props)
    return null
  }
}))
vi.mock('./FindHighlights', () => ({
  FindHighlights: (props: { box: { w: number; h: number }; window?: unknown }) => {
    findProps.push(props)
    return null
  }
}))

import { FullViewPage } from './FullViewPage'
import { EditProvider, useEditStore, type EditStore } from '../../edit/EditProvider'
import { makePageKey } from '../../edit/model'
import type { PageEntry } from '../../types'

const page: PageEntry = {
  id: 'pg-1',
  source: { id: 'src-1', bytes: new Uint8Array(), pdf: {} as PageEntry['source']['pdf'] },
  pageIndex: 0,
  width: 612,
  height: 792
}

let store: EditStore = null as unknown as EditStore

function Harness({ animating }: { animating: boolean }): ReactNode {
  const s = useEditStore()
  store = s
  const child = createElement(FullViewPage, {
    page,
    viewport: { w: 1200, h: 900 },
    isCurrent: true,
    view: { zoom: 1, x: 0, y: 0 },
    zoomed: false,
    interactive: true,
    animating,
    flip: animating ? 'translate(0px, 0px) scale(0.5)' : null,
    flipTransition: false,
    renderVersion: 0,
    resetView: () => {},
    applyZoom: () => {}
  })
  return createElement(EditProvider, { store: s, children: child })
}

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  pageViewProps.length = 0
  overlayProps.length = 0
  findProps.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const render = (animating: boolean): Promise<void> =>
  act(async () => root.render(createElement(Harness, { animating })))

describe('FullViewPage → PageView rotation', () => {
  it('passes the page rotation that the box transform carries', async () => {
    await render(false)
    expect(pageViewProps.at(-1)?.rotation).toBe(0)

    await act(async () => store.rotatePage(makePageKey(page.source.id, page.pageIndex), 90))
    const box = container.querySelector('.full-page') as HTMLElement
    expect(box.style.transform).toContain('rotate(90deg)')
    expect(pageViewProps.at(-1)?.rotation).toBe(90)
  })

  it('passes no rotation while the un-rotated FLIP transform is applied', async () => {
    await render(false)
    await act(async () => store.rotatePage(makePageKey(page.source.id, page.pageIndex), 270))
    await render(true)
    const box = container.querySelector('.full-page') as HTMLElement
    expect(box.style.transform).not.toContain('rotate')
    expect(pageViewProps.at(-1)?.rotation).toBe(0)

    await render(false)
    expect(pageViewProps.at(-1)?.rotation).toBe(270)
  })
})

describe('FullViewPage at the cropped geometry', () => {
  const key = makePageKey(page.source.id, page.pageIndex)
  // A 300 × 400 pt crop: window {x: 100, y: 192, w: 300, h: 400} of the 612 × 792 page.
  const CROP = { x: 100, y: 200, w: 300, h: 400 }
  const px = (v: string): number => parseFloat(v)
  const fullPage = (): HTMLElement => container.querySelector('.full-page') as HTMLElement
  const pageFrame = (): HTMLElement => container.querySelector('.page-frame') as HTMLElement

  it('fits the crop window to the viewport and offsets the full page inside it', async () => {
    await render(false)
    await act(async () => store.setCrop(key, CROP))
    // fitInto(300, 400, 1200×900) → 675 × 900, scale 2.25.
    const s = 900 / 400
    expect(px(fullPage().style.width)).toBeCloseTo(300 * s)
    expect(px(fullPage().style.height)).toBeCloseTo(900)
    const f = pageFrame()
    expect(px(f.style.left)).toBeCloseTo(-100 * s)
    expect(px(f.style.top)).toBeCloseTo(-192 * s)
    expect(px(f.style.width)).toBeCloseTo(612 * s)
    expect(px(f.style.height)).toBeCloseTo(792 * s)
    expect(pageViewProps.at(-1)?.clip?.x0).toBeCloseTo(100 / 612)
    // Overlays and Find highlights get the FULL-page frame, and Find the window to clip to.
    expect(overlayProps.at(-1)?.fit.w).toBeCloseTo(612 * s)
    expect(overlayProps.at(-1)?.fit.h).toBeCloseTo(792 * s)
    expect(findProps.at(-1)?.box.w).toBeCloseTo(612 * s)
    expect(findProps.at(-1)?.window).toEqual({ x: 100, y: 192, w: 300, h: 400 })
  })

  it('shows the whole page while the crop tool edits it', async () => {
    await render(false)
    await act(async () => store.setCrop(key, CROP))
    await act(async () => store.setTool('crop'))
    // The full-page fit: fitInto(612, 792, 1200×900).
    const s = 900 / 792
    expect(px(fullPage().style.width)).toBeCloseTo(612 * s)
    expect(px(fullPage().style.height)).toBeCloseTo(900)
    expect(px(pageFrame().style.left)).toBeCloseTo(0)
    expect(pageViewProps.at(-1)?.clip ?? null).toBeNull()
    expect(findProps.at(-1)?.window).toBeUndefined()
    await act(async () => store.setTool('browse'))
    expect(px(fullPage().style.width)).toBeCloseTo(300 * (900 / 400))
  })

  it('fits a rotated, cropped page by its rotated window and keeps the box upright', async () => {
    await render(false)
    await act(async () => store.setCrop(key, CROP))
    await act(async () => store.rotatePage(key, 90))
    // Displayed 400 × 300 → fitInto gives 1200 × 900 (scale 3); the upright box is 900 × 1200.
    expect(px(fullPage().style.width)).toBeCloseTo(900)
    expect(px(fullPage().style.height)).toBeCloseTo(1200)
    expect(fullPage().style.transform).toContain('rotate(90deg)')
    expect(px(pageFrame().style.width)).toBeCloseTo(612 * 3)
    expect(overlayProps.at(-1)?.rot).toBe(90)
    expect(overlayProps.at(-1)?.fit.w).toBeCloseTo(612 * 3)
  })
})
