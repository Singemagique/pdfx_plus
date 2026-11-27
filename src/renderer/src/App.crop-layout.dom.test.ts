import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasLayout } from './canvas/layout'
import type { EditStore } from './edit/EditProvider'

// App's layout memo must re-run when a page's crop changes (set, undo, redo, clear), so the page's
// cell takes its cropped geometry. The real layout runs; the canvas is a stand-in that records the
// layout it is handed and grabs the edit store from context.
const stubs = vi.hoisted(() => {
  const state = {
    docs: [
      {
        id: 'd1',
        name: 'a.pdf',
        pages: [{ id: 'p1', source: { id: 's1' }, pageIndex: 0, width: 612, height: 792 }]
      }
    ] as unknown[],
    layouts: [] as unknown[],
    store: null as unknown,
    noop: (): void => {}
  }
  Object.defineProperty(window, 'api', {
    value: {
      platform: 'linux',
      onZoom: () => state.noop,
      onMenu: () => state.noop,
      getPathForFile: () => '',
      listCardTokens: async () => [],
      findCardModules: async () => [],
      listWindowsCerts: async () => []
    },
    configurable: true,
    writable: true
  })
  return state
})

vi.mock('./components/CollectionCanvas', async () => {
  const { useEdits } = await import('./edit/EditProvider')
  return {
    CollectionCanvas: (props: { layout: unknown }) => {
      stubs.store = useEdits()
      stubs.layouts.push(props.layout)
      return null
    }
  }
})
vi.mock('./components/edit/EditTools', () => ({ EditTools: () => null }))
vi.mock('./components/edit/SignaturePad', () => ({ SignaturePad: () => null }))
vi.mock('./components/FullView', () => ({ FullView: () => null }))
vi.mock('./app/useCollection', () => ({
  useCollection: () => ({
    docs: stubs.docs,
    selected: null,
    setDocs: stubs.noop,
    docsRef: { current: stubs.docs },
    movePageInto: stubs.noop,
    movePageToNewDoc: stubs.noop,
    deletePage: stubs.noop,
    duplicatePage: stubs.noop,
    copySelected: stubs.noop,
    clearSelection: stubs.noop,
    selectPage: stubs.noop,
    moveDoc: stubs.noop,
    removeDoc: stubs.noop,
    renameDoc: stubs.noop
  })
}))
vi.mock('./app/useExport', () => ({
  useExport: () => ({
    exportCollection: stubs.noop,
    exportZip: stubs.noop,
    signAndExport: stubs.noop,
    signWithCardAndExport: stubs.noop,
    signWithWindowsCertAndExport: stubs.noop
  })
}))
vi.mock('./app/useImport', () => ({
  useImport: () => ({
    addFiles: stubs.noop,
    openViaDialog: stubs.noop,
    addPagesToDoc: stubs.noop,
    handleExternalDropFiles: stubs.noop
  })
}))
vi.mock('./app/usePaste', () => ({ usePaste: () => ({ handlePaste: async () => {} }) }))
vi.mock('./app/useDragController', () => ({
  useDragController: () => ({
    dragKind: null,
    draggingPage: null,
    dropTarget: null,
    collapsedId: null,
    externalCount: 0,
    committing: false,
    startPageDrag: stubs.noop,
    clearDrag: stubs.noop,
    handlers: {
      onDragEnter: stubs.noop,
      onDragOver: stubs.noop,
      onDragLeave: stubs.noop,
      onDrop: stubs.noop
    }
  })
}))

import App from './App'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  stubs.layouts.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const cell = (): { w: number; h: number } => {
  const l = stubs.layouts.at(-1) as CanvasLayout
  const { w, h } = l.items[0].pages[0]
  return { w, h }
}
const store = (): EditStore => stubs.store as EditStore

describe('App · the collection layout follows crops', () => {
  it('re-lays the cell out at the crop geometry on set, undo, redo and clear', async () => {
    await act(async () => root.render(createElement(App)))
    const full = cell()
    expect(full).toEqual({ w: 216, h: 280 }) // letter at the 280 px thumbnail height

    // A square crop makes a square cell.
    await act(async () => store().setCrop('s1#0', { x: 0, y: 0, w: 300, h: 300 }))
    expect(cell()).toEqual({ w: 280, h: 280 })

    await act(async () => store().undo())
    expect(cell()).toEqual(full)
    await act(async () => store().redo())
    expect(cell()).toEqual({ w: 280, h: 280 })

    // Rotated on top of the crop: a 2:1 crop turned 90° is a 1:2 cell.
    await act(async () => store().setCrop('s1#0', { x: 0, y: 0, w: 400, h: 200 }))
    expect(cell()).toEqual({ w: 560, h: 280 })
    await act(async () => store().rotatePage('s1#0', 90))
    expect(cell()).toEqual({ w: 140, h: 280 })

    await act(async () => store().setCrop('s1#0', null))
    expect(cell()).toEqual({ w: Math.round((280 * 792) / 612), h: 280 })
  })

  it('keeps the same layout object across unrelated edits', async () => {
    await act(async () => root.render(createElement(App)))
    const before = stubs.layouts.at(-1)
    await act(async () => store().setTool('ink'))
    expect(stubs.layouts.at(-1)).toBe(before)
  })
})
