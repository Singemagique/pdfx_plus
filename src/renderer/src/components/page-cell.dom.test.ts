// PageCell must tell PageView the rotation its `.page-rotor` wrapper applies, so the thumbnail's
// detail canvas is planned in upright page coordinates (see page-view/detail-geometry.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const pageViewProps = vi.hoisted(() => [] as Array<{ rotation?: number }>)
vi.mock('./PageView', () => ({
  PageView: (props: { rotation?: number }) => {
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
