import { act, createElement, Fragment } from 'react'
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
    noop: (): void => {},
    /** The renderer's menu listener, as registered through window.api.onMenu. */
    menu: null as ((action: string) => void) | null,
    /** The canvas's "open this page in full view" (a double-click on a page in the real canvas). */
    openPage: null as ((docId: string, pageId: string) => void) | null
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
      onMenu: (cb: (action: string) => void) => {
        state.menu = cb
        return state.noop
      },
      getPathForFile: () => '',
      listCardTokens: async () => [],
      findCardModules: async () => [],
      listWindowsCerts: async () => [],
      setMenuChecked: vi.fn()
    },
    configurable: true,
    writable: true
  })
  return state
})

vi.mock('./canvas/layout', () => ({ computeLayout: () => ({ docs: [], width: 0, height: 0 }) }))
vi.mock('./components/CollectionCanvas', () => ({
  CollectionCanvas: (props: { onOpenPage: (docId: string, pageId: string) => void }) => {
    stubs.openPage = props.onOpenPage
    return null
  }
}))
vi.mock('./components/edit/EditTools', () => ({ EditTools: () => null }))
vi.mock('./components/edit/SignaturePad', () => ({ SignaturePad: () => null }))
// Stand-in for the real FullView: it fires the same `onClose` that window-level Escape reaches via
// use-full-view-input → runClose, and mounts the REAL "Show recognized text" overlay on the start
// page (its header lands in <body>: no bar slot here), so the Document menu's wiring to it is real.
vi.mock('./components/FullView', async () => {
  const { RecognizedTextLayer } = await vi.importActual<
    typeof import('./components/full-view/RecognizedTextLayer')
  >('./components/full-view/RecognizedTextLayer')
  // The page's file has no PDFx OCR layer (saved-layer.ts reads it through pdf.js).
  const pdf = { getPage: () => Promise.reject(new Error('no pdf.js here')) }
  return {
    FullView: (props: {
      onClose: () => void
      docs: Array<{ id: string; pages: Array<{ id: string; source: object }> }>
      startDocId: string
      startPageId: string
    }) => {
      const page = props.docs
        .find((d) => d.id === props.startDocId)
        ?.pages.find((p) => p.id === props.startPageId)
      return createElement(
        Fragment,
        null,
        createElement(
          'button',
          { className: 'fv-close', onClick: props.onClose },
          'close full view'
        ),
        page &&
          createElement(RecognizedTextLayer, {
            page: { ...page, source: { ...page.source, pdf } } as never,
            active: true
          })
      )
    }
  }
})
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
import { isRecognizedTextShown, setRecognizedTextShown } from './ocr/recognized-text'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  stubs.install([stubs.oneDoc()])
  // The overlay toggle is session state outside React: off at launch, as in the app.
  setRecognizedTextShown(false)
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

describe('App · Find', () => {
  it('opens the find bar from the menu and closes it with Escape', async () => {
    await act(async () => root.render(createElement(App)))
    expect(container.querySelector('.findbar')).toBeNull()

    await act(async () => stubs.menu?.('find'))
    const input = container.querySelector('.findbar-input') as HTMLInputElement | null
    expect(input).not.toBeNull()
    expect(document.activeElement).toBe(input)

    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('.findbar')).toBeNull()
  })

  it('opens the find bar with Ctrl+F', async () => {
    await act(async () => root.render(createElement(App)))
    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true })
      )
    })
    expect(container.querySelector('.findbar')).not.toBeNull()
  })

  it('ignores the menu while the Sign dialog is open', async () => {
    await act(async () => root.render(createElement(App)))
    await click(button(/^Sign$/))
    await act(async () => stubs.menu?.('find'))
    expect(container.querySelector('.findbar')).toBeNull()
  })
})

describe('App · Document menu (OCR, DESIGN.md §3.8)', () => {
  const menu = (action: string): Promise<void> =>
    act(async () => {
      stubs.menu!(action)
      await new Promise((r) => setTimeout(r, 0))
    })
  const toast = (): string | null => container.querySelector('.toast')?.textContent ?? null
  const setMenuChecked = (): ReturnType<typeof vi.fn> =>
    (window.api as unknown as { setMenuChecked: ReturnType<typeof vi.fn> }).setMenuChecked

  it('Recognize Text… (also Ctrl/Cmd+Shift+R) opens the dialog; Replace… opens it in Replace mode', async () => {
    await act(async () => root.render(createElement(App)))
    await menu('recognize-text')
    expect(container.querySelector('.ocr-dialog h2')?.textContent).toBe('Recognize Text')
    // A second command while the dialog is open is ignored (it is modal).
    await menu('replace-recognized-text')
    expect(container.querySelector('.ocr-dialog h2')?.textContent).toBe('Recognize Text')
    await click(button(/^Cancel$/))
    expect(container.querySelector('.ocr-dialog')).toBeNull()
    await menu('replace-recognized-text')
    expect(container.querySelector('.ocr-dialog h2')?.textContent).toBe('Replace Recognized Text')
  })

  it('the two checkboxes: Show toggles (and is mirrored), Include flips the export setting', async () => {
    await act(async () => root.render(createElement(App)))
    // Mounted with the toggle off: the native checkbox is told so.
    expect(setMenuChecked()).toHaveBeenCalledWith('show-recognized-text', false)
    setMenuChecked().mockClear()
    // Show drives the overlay's own toggle (recognized-text.ts), with or without full view open.
    await menu('show-recognized-text')
    expect(isRecognizedTextShown()).toBe(true)
    expect(setMenuChecked()).toHaveBeenCalledWith('show-recognized-text', true)
    await menu('show-recognized-text')
    expect(isRecognizedTextShown()).toBe(false)
    expect(setMenuChecked()).toHaveBeenLastCalledWith('show-recognized-text', false)
    await menu('include-recognized-text')
    expect(setMenuChecked()).toHaveBeenCalledWith('include-recognized-text', false)
    await menu('include-recognized-text')
    expect(setMenuChecked()).toHaveBeenLastCalledWith('include-recognized-text', true)
  })

  it('Show Recognized Text shows the full-view overlay; its Hide unticks the menu', async () => {
    await act(async () => root.render(createElement(App)))
    const header = (): Element | null => document.body.querySelector('.ocr-text-header')
    const lastShow = (): unknown =>
      setMenuChecked()
        .mock.calls.filter((c) => c[0] === 'show-recognized-text')
        .at(-1)?.[1]
    await act(async () => stubs.openPage!('d1', 'p1'))
    expect(container.querySelector('.fv-close')).not.toBeNull()
    expect(header()).toBeNull()

    await menu('show-recognized-text')
    expect(header()).not.toBeNull()
    // No OCR ran: the overlay says so rather than drawing nothing silently.
    expect(header()!.textContent).toContain('No recognized text on this page')
    expect(lastShow()).toBe(true)

    // Hide, from inside the overlay: the toggle goes off and the native checkbox follows.
    await click(header()!.querySelector('.ocr-text-header-hide')!)
    expect(header()).toBeNull()
    expect(isRecognizedTextShown()).toBe(false)
    expect(lastShow()).toBe(false)

    // Closing full view keeps the session toggle (and so the tick); reopening shows it again.
    await menu('show-recognized-text')
    expect(lastShow()).toBe(true)
    await click(container.querySelector('.fv-close')!)
    expect(container.querySelector('.fv-close')).toBeNull()
    expect(header()).toBeNull()
    expect(isRecognizedTextShown()).toBe(true)
    expect(lastShow()).toBe(true)
    await act(async () => stubs.openPage!('d1', 'p1'))
    expect(header()).not.toBeNull()
    // Unticked from the menu outside full view, the next full view opens without it.
    await click(container.querySelector('.fv-close')!)
    await menu('show-recognized-text')
    expect(lastShow()).toBe(false)
    await act(async () => stubs.openPage!('d1', 'p1'))
    expect(header()).toBeNull()
  })

  it('no Document command runs behind the open Recognize dialog (it is modal)', async () => {
    await act(async () => root.render(createElement(App)))
    await menu('recognize-text')
    expect(container.querySelector('.ocr-dialog')).not.toBeNull()
    for (const a of ['remove-recognized-text', 'copy-page-text', 'recognize-all-scanned']) {
      await menu(a)
      expect(toast()).toBeNull()
    }
    expect(container.querySelector('.ocr-dialog h2')?.textContent).toBe('Recognize Text')
  })

  it('the toast text goes through an always-mounted live region (announced, not just shown)', async () => {
    await act(async () => root.render(createElement(App)))
    const region = (): Element | null =>
      [...container.querySelectorAll('.sr-only[role="status"][aria-live="polite"]')].find(
        (e) => !e.closest('.toolbar')
      ) ?? null
    expect(region()).not.toBeNull() // there before any toast
    expect(region()!.textContent).toBe('')
    await menu('recognize-all-scanned')
    expect(region()!.textContent).toBe('No scanned pages are waiting for text recognition')
    // The visible toast is not a second live region.
    expect(container.querySelector('.toast')!.getAttribute('role')).toBeNull()
  })

  it('Copy Page Text, Remove and Recognize All say what they could not do', async () => {
    await act(async () => root.render(createElement(App)))
    await menu('copy-page-text')
    expect(toast()).toBe('Select a page to copy its text')
    await menu('remove-recognized-text')
    expect(toast()).toBe('No recognized text to remove')
    await menu('recognize-all-scanned')
    expect(toast()).toBe('No scanned pages are waiting for text recognition')
  })
})
