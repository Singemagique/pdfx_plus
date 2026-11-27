// FullViewPage must tell PageView the CSS rotation its page box actually carries, so the detail
// canvas is planned in upright page coordinates: the page's rotation while open, but none during
// the open/close FLIP animation (whose transform has no rotate()).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const pageViewProps = vi.hoisted(() => {
  // geometry.ts reads window.api.platform at import time.
  ;(window as unknown as { api: { platform: string } }).api = { platform: 'win32' }
  return [] as Array<{ rotation?: number }>
})
vi.mock('../PageView', () => ({
  PageView: (props: { rotation?: number }) => {
    pageViewProps.push(props)
    return null
  }
}))
vi.mock('../edit/OverlayLayer', () => ({ OverlayLayer: () => null }))

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
