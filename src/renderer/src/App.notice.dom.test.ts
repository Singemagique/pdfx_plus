// The main process reports the files it could not read over a 'pdfx:notice' event. App is the only
// place that listens, so if this subscription is dropped the user is back to silent skips — the
// exact regression this pins. Everything heavy around App is a boundary and is mocked.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => {
  const state = {
    docs: [] as unknown[],
    noop: (): void => {},
    /** Set by the api stub when App subscribes; null means it never did. */
    notice: null as ((message: string) => void) | null,
    unsubscribed: false
  }
  const host = globalThis as { CSS?: { escape?: (s: string) => string } }
  if (typeof host.CSS?.escape !== 'function') {
    Object.defineProperty(globalThis, 'CSS', {
      value: { ...(host.CSS ?? {}), escape: (s: string) => s },
      configurable: true,
      writable: true
    })
  }
  // Installed at module scope, not in beforeEach: Toolbar reads window.api.platform on import.
  Object.defineProperty(window, 'api', {
    value: {
      platform: 'linux',
      onZoom: () => state.noop,
      onMenu: () => state.noop,
      onNotice: (cb: (message: string) => void) => {
        state.notice = cb
        return () => {
          state.unsubscribed = true
        }
      },
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

vi.mock('./canvas/layout', () => ({ computeLayout: () => ({ docs: [], width: 0, height: 0 }) }))
vi.mock('./components/CollectionCanvas', () => ({ CollectionCanvas: () => null }))
vi.mock('./components/FullView', () => ({ FullView: () => null }))
vi.mock('./components/edit/EditTools', () => ({ EditTools: () => null }))
vi.mock('./components/edit/SignaturePad', () => ({ SignaturePad: () => null }))
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
  stubs.notice = null
  stubs.unsubscribed = false
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('App · main-process notices', () => {
  it('shows a main-process notice in the toast', async () => {
    await act(async () => root.render(createElement(App)))
    expect(stubs.notice).toBeTypeOf('function')
    expect(container.querySelector('.toast')).toBeNull()

    await act(async () => stubs.notice?.('Could not read 2 files: a.pdf, b.pdf'))

    expect(container.querySelector('.toast')?.textContent).toBe(
      'Could not read 2 files: a.pdf, b.pdf'
    )
  })

  it('unsubscribes when it goes away', async () => {
    await act(async () => root.render(createElement(App)))
    expect(stubs.unsubscribed).toBe(false)
    // Swap App out (rather than unmounting the root, which afterEach does) so the effect cleanup
    // runs: the listener must not outlive the component that installed it.
    await act(async () => root.render(createElement('span')))
    expect(stubs.unsubscribed).toBe(true)
  })
})
