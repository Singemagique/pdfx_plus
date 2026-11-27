// PageCell must tell PageView the rotation its `.page-rotor` wrapper applies, so the thumbnail's
// detail canvas is planned in upright page coordinates (see page-view/detail-geometry.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

type Clip = { x0: number; y0: number; x1: number; y1: number } | null | undefined
const pageViewProps = vi.hoisted(() => [] as Array<{ rotation?: number; clip?: Clip }>)
vi.mock('./PageView', () => ({
  PageView: (props: { rotation?: number; clip?: Clip }) => {
    pageViewProps.push(props)
    return null
  }
}))

import { PageCell } from './page-cell'
import { EditProvider, useEditStore, type EditStore } from '../edit/EditProvider'
import { makePageKey } from '../edit/model'
import type { PageEntry } from '../types'

const page: PageEntry = {
  id: 'pg-1',
  source: { id: 'src-1', bytes: new Uint8Array(), pdf: {} as PageEntry['source']['pdf'] },
  pageIndex: 0,
  width: 612,
  height: 792
}

let store: EditStore = null as unknown as EditStore

function Harness(): ReactNode {
  const s = useEditStore()
  store = s
  const child = createElement(PageCell, {
    docId: 'doc-1',
    page,
    x: 0,
    y: 0,
    width: 155,
    pageHeight: 200,
    renderVersion: 0,
    selected: false,
    collapsed: false,
    hidden: false,
    pagesDraggable: false,
    visibleNumber: 1,
    onSelectPage: () => {},
    onOpenPage: () => {},
    onPageDragStart: () => {},
    onPageDragEnd: () => {}
  })
  return createElement(EditProvider, { store: s, children: child })
}

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(async () => {
  pageViewProps.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(createElement(Harness)))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('PageCell → PageView rotation', () => {
  it('passes no rotation for an upright page', () => {
    expect(pageViewProps.at(-1)?.rotation ?? 0).toBe(0)
  })

  it.each([90, 180, 270])('passes the rotor rotation (%i°)', async (deg) => {
    await act(async () => store.rotatePage(makePageKey(page.source.id, page.pageIndex), deg))
    const rotor = container.querySelector('.page-rotor') as HTMLElement
    expect(rotor.style.transform).toContain(`rotate(${deg}deg)`)
    expect(pageViewProps.at(-1)?.rotation).toBe(deg)
  })
})

describe('PageCell at the cropped geometry', () => {
  const key = makePageKey(page.source.id, page.pageIndex)
  // 300 × 400 pt, i.e. the window {x: 100, y: 192} of the 612 × 792 page.
  const CROP = { x: 100, y: 200, w: 300, h: 400 }
  const rotor = (): HTMLElement | null => container.querySelector('.page-rotor')
  const frame = (): HTMLElement | null => container.querySelector('.page-frame')
  const px = (v: string): number => parseFloat(v)

  it('shows only the crop window: a clipping window, the full page offset inside it', async () => {
    await act(async () => store.setCrop(key, CROP))
    expect(container.querySelector('.cell-crop-mask')).toBeNull()
    const r = rotor()!
    // `clip`, not `hidden`: a `hidden` box is a scroll container and could be scrolled off the crop.
    expect(r.style.overflow).toBe('clip')
    expect([px(r.style.width), px(r.style.height)]).toEqual([155, 200])
    // Window 300×400 contained in 155×200: scale 0.5, centred horizontally (2.5 px spare each side).
    const f = frame()!
    expect(px(f.style.left)).toBeCloseTo(-100 * 0.5 + 2.5)
    expect(px(f.style.top)).toBeCloseTo(-192 * 0.5)
    expect(px(f.style.width)).toBeCloseTo(612 * 0.5)
    expect(px(f.style.height)).toBeCloseTo(792 * 0.5)
    const clip = pageViewProps.at(-1)?.clip
    expect(clip?.x0).toBeCloseTo(100 / 612)
    expect(clip?.y0).toBeCloseTo(192 / 792)
    expect(clip?.x1).toBeCloseTo(400 / 612)
    expect(clip?.y1).toBeCloseTo(592 / 792)
  })

  it('swaps the window box for a rotated, cropped page', async () => {
    await act(async () => store.setCrop(key, CROP))
    await act(async () => store.rotatePage(key, 90))
    const r = rotor()!
    expect([px(r.style.width), px(r.style.height)]).toEqual([200, 155])
    expect(r.style.transform).toContain('rotate(90deg)')
    expect(pageViewProps.at(-1)?.rotation).toBe(90)
    expect(pageViewProps.at(-1)?.clip).not.toBeNull()
  })

  it('restores the plain page when uncropped, and follows undo / redo', async () => {
    await act(async () => store.setCrop(key, CROP))
    expect(frame()).not.toBeNull()
    await act(async () => store.setCrop(key, null))
    expect(rotor()).toBeNull()
    expect(frame()).toBeNull()
    expect(pageViewProps.at(-1)?.clip ?? null).toBeNull()
    await act(async () => store.undo())
    expect(frame()).not.toBeNull()
    await act(async () => store.undo())
    expect(frame()).toBeNull()
    await act(async () => store.redo())
    expect(frame()).not.toBeNull()
  })
})
