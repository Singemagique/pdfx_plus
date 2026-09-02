import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// App's real value here is its own wiring — the placement state machine that spans the Sign dialog,
// the edit tool and full view. Everything heavy around it (the pdf.js/d3 canvas, the export/import/
// paste/drag hooks) is a boundary and is mocked; useFullView, the edit store, Toolbar and SignDialog
// stay REAL, because they are the pieces the state machine actually talks to.
const stubs = vi.hoisted(() => {
  const oneDoc = (): unknown => ({
    id: 'd1',
    name: 'a.pdf',
    pages: [{ id: 'p1', source: { id: 's1' }, pageIndex: 0, width: 200, height: 300 }]
  })
  const state = {
    docs: [] as unknown[],
    /** Reset between tests — the mock factory closes over this array, so it must not leak state. */
    install: (docs: unknown[]): void => {
      state.docs.length = 0
      state.docs.push(...docs)
    },
    oneDoc,
    noop: (): void => {}
  }
  // jsdom ships no `CSS` global, and useFullView.openPage escapes the page id with CSS.escape.
  const host = globalThis as { CSS?: { escape?: (s: string) => string } }
  if (typeof host.CSS?.escape !== 'function') {
    Object.defineProperty(globalThis, 'CSS', {
      value: { ...(host.CSS ?? {}), escape: (s: string) => s },
      configurable: true,
      writable: true
    })
  }
  // Installed here, not in beforeEach: Toolbar reads `window.api.platform` at module scope, and the
  // static `import App` below runs before any hook.
  Object.defineProperty(window, 'api', {
    value: {
      // Non-Windows keeps SignDialog on the certificate-file tab, so no cert-store probe runs.
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

vi.mock('./canvas/layout', () => ({ computeLayout: () => ({ docs: [], width: 0, height: 0 }) }))
vi.mock('./components/CollectionCanvas', () => ({ CollectionCanvas: () => null }))
vi.mock('./components/edit/EditTools', () => ({ EditTools: () => null }))
vi.mock('./components/edit/SignaturePad', () => ({ SignaturePad: () => null }))
// Stand-in for the real FullView: the only thing this test needs from it is the ability to fire the
// same `onClose` that window-level Escape reaches via use-full-view-input → runClose.
vi.mock('./components/FullView', () => ({
  FullView: (props: { onClose: () => void }) =>
    createElement('button', { className: 'fv-close', onClick: props.onClose }, 'close full view')
}))
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
  stubs.install([stubs.oneDoc()])
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const button = (re: RegExp): HTMLButtonElement => {
  const found = Array.from(container.querySelectorAll('button')).find((b) =>
    re.test(b.textContent ?? '')
  )
  if (!found) throw new Error(`no button matching ${re}`)
  return found
}

const click = async (el: Element): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const overlay = (): HTMLElement | null => container.querySelector('.sign-overlay')

describe('App · abandoning a signature placement', () => {
  it('fully closes the hidden Sign dialog when full view closes, so Sign still works', async () => {
    await act(async () => root.render(createElement(App)))

    await click(button(/^Sign$/))
    expect(overlay()).not.toBeNull()
    expect(overlay()!.classList.contains('hidden')).toBe(false)

    // "Place on page…" opens full view and hides (not unmounts) the dialog.
    await click(button(/Place on page/))
    expect(container.querySelector('.fv-close')).not.toBeNull()
    expect(overlay()!.classList.contains('hidden')).toBe(true)

    // Escape closes full view without ever touching the edit tool, so the tool-switch abandon path
    // never fires. The dialog must not be left mounted-but-invisible.
    await click(container.querySelector('.fv-close')!)
    expect(overlay()).toBeNull()

    // The regression this pins: with signOpen stuck at true, setSignOpen(true) was a no-op and the
    // toolbar's Sign button never brought the dialog back.
    await click(button(/^Sign$/))
    expect(overlay()).not.toBeNull()
    expect(overlay()!.classList.contains('hidden')).toBe(false)
  })

  it('keeps the dialog visible when there is no page to place on', async () => {
    stubs.install([{ id: 'd2', name: 'empty.pdf', pages: [] }])
    await act(async () => root.render(createElement(App)))

    await click(button(/^Sign$/))
    await click(button(/Place on page/))

    // No full view could open, so placing mode was never entered — the dialog stays usable rather
    // than being hidden and then immediately abandoned by the effect.
    expect(container.querySelector('.fv-close')).toBeNull()
    expect(overlay()).not.toBeNull()
    expect(overlay()!.classList.contains('hidden')).toBe(false)
  })
})
