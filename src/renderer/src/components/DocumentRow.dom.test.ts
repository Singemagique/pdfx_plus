// DocumentRow draws a card straight from the layout: the add-page slot never makes the card taller
// than its rows of pages, and a narrower document's pages sit centred in the shared card width.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const cellProps = vi.hoisted(() => [] as Array<{ page: { id: string }; x: number; y: number }>)
vi.mock('./page-cell', () => ({
  PageCell: (props: { page: { id: string }; x: number; y: number }) => {
    cellProps.push(props)
    return null
  }
}))

import { DocumentRow } from './DocumentRow'
import {
  ADD_PAGE_EDGE_SIZE,
  ADD_PAGE_MIN_WIDTH,
  CARD_PAD_X,
  computeLayout,
  docHeightForRows
} from '../canvas/layout'
import type { DocPlacement } from '../canvas/layout'
import { LANDSCAPE, WRAP_5, doc, page } from '../canvas/test-utils/layout-fixtures'

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  cellProps.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const noop = (): void => {}

async function draw(item: DocPlacement): Promise<void> {
  await act(async () =>
    root.render(
      createElement(DocumentRow, {
        item,
        reflow: null,
        renderVersion: 0,
        selectedPageId: null,
        pagesDraggable: true,
        collapseId: null,
        hiddenPageId: null,
        intoGhost: null,
        onSelectPage: noop,
        onOpenPage: noop,
        onPageDragStart: noop,
        onPageDragEnd: noop,
        onAddPage: noop
      })
    )
  )
}

const card = (): HTMLElement => container.querySelector('.doc-row') as HTMLElement
const addPage = (): HTMLElement => container.querySelector('.add-page') as HTMLElement
const px = (v: string): number => parseFloat(v)

describe('DocumentRow add-page slot', () => {
  it.each([
    [5, 1],
    [10, 2]
  ])(
    '%i pages filling %i row(s): the card is that many rows tall, no add-page row',
    async (n, rows) => {
      const item = computeLayout([doc('p', n)], undefined, WRAP_5).items[0]
      await draw(item)
      expect(px(card().style.height)).toBe(docHeightForRows(rows))
      const add = addPage()
      expect(add.classList.contains('edge')).toBe(true)
      expect(px(add.style.left)).toBe(item.width - ADD_PAGE_EDGE_SIZE / 2)
      expect(px(add.style.top) + px(add.style.height)).toBeLessThan(docHeightForRows(rows))
    }
  )

  it('a shortened cell beside a nearly full row drops its label', async () => {
    // Two landscape pages and a letter one, centred in a five-letter card, leave 70 px after it.
    const d = {
      id: 'm',
      name: 'm.pdf',
      pages: [page('a', LANDSCAPE), page('b', LANDSCAPE), page('c')]
    }
    const item = computeLayout([d, doc('w', 12)], undefined, WRAP_5).items[0]
    await draw(item)
    expect(item.addPage.w).toBe(70)
    expect(item.addPage.w).toBeGreaterThanOrEqual(ADD_PAGE_MIN_WIDTH)
    expect(addPage().classList.contains('narrow')).toBe(true)
    expect(addPage().classList.contains('edge')).toBe(false)
  })

  it('a full-width cell keeps its label', async () => {
    await draw(computeLayout([doc('p', 2), doc('w', 12)], undefined, WRAP_5).items[0])
    expect(addPage().className).not.toMatch(/narrow|edge/)
    expect(px(addPage().style.width)).toBe(216)
  })
})

describe('DocumentRow page positions', () => {
  it('centres a narrower document’s pages in the shared card width', async () => {
    const [n] = computeLayout([doc('n', 2), doc('w', 12)], undefined, WRAP_5).items
    await draw(n)
    const xs = cellProps.slice(-2).map((p) => p.x)
    expect(xs[0]).toBe(n.gridX - n.x)
    expect(xs[0]).toBeGreaterThan(CARD_PAD_X)
    const right = n.width - (xs[1] + 216)
    expect(Math.abs(xs[0] - right)).toBeLessThanOrEqual(1)
  })
})
