import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRootDragHandlers } from './root-drag-handlers'
import type { RootDragDeps } from './root-drag-handlers'

const FILES_TYPE = 'Files'

function makeDeps(overrides: Partial<RootDragDeps> = {}) {
  return {
    layout: { docs: [], width: 0, height: 0 } as unknown as RootDragDeps['layout'],
    // No canvas → clientToWorld returns undefined, so the drop falls back to deps.dropTarget.
    canvasRef: { current: null },
    dragKind: 'external' as const,
    draggingPage: null,
    dropTarget: null,
    collapsedId: null,
    externalCount: 1,
    dragDepth: { current: 1 },
    setDragKind: vi.fn(),
    setExternalCount: vi.fn(),
    setCommitting: vi.fn(),
    armDragWatchdog: vi.fn(),
    clearDrag: vi.fn(),
    updateDropTarget: vi.fn(),
    movePageInto: vi.fn(),
    movePageToNewDoc: vi.fn(),
    onExternalDrop: vi.fn(),
    onDropError: vi.fn(),
    ...overrides
  }
}

/** The slice of a React drop event the handlers actually read. */
function dropEvent(
  files: Array<{ name: string; type: string; arrayBuffer: () => Promise<ArrayBuffer> }>
) {
  return {
    preventDefault: vi.fn(),
    clientX: 0,
    clientY: 0,
    dataTransfer: { types: [FILES_TYPE], files }
  } as unknown as React.DragEvent
}

const droppedFile = (name: string, arrayBuffer: () => Promise<ArrayBuffer>) => ({
  name,
  type: 'application/pdf',
  arrayBuffer
})

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  consoleError.mockRestore()
  Reflect.deleteProperty(globalThis, 'window')
})

/** Install the minimal `window.api` the drop handler touches. */
function stubApi(api: {
  getPathForFile: (f: unknown) => string
  expandDropPaths?: () => Promise<unknown>
}): void {
  Object.defineProperty(globalThis, 'window', {
    value: { api },
    configurable: true,
    writable: true
  })
}

describe('onDrop reports a failed external drop instead of doing nothing', () => {
  it('surfaces a rejected expandDropPaths (main-process intake path)', async () => {
    stubApi({
      getPathForFile: () => 'C:\\docs\\a.pdf',
      expandDropPaths: () => Promise.reject(new Error('EACCES'))
    })
    const deps = makeDeps()

    createRootDragHandlers(deps).onDrop(
      dropEvent([droppedFile('a.pdf', async () => new ArrayBuffer(1))])
    )

    await vi.waitFor(() => expect(deps.onDropError).toHaveBeenCalledWith('Could not add files'))
    expect(deps.onExternalDrop).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalled()
  })

  it('surfaces a rejected arrayBuffer read (browser fallback path)', async () => {
    // No usable path for the dropped file → the handler reads the File objects directly.
    stubApi({ getPathForFile: () => '' })
    const deps = makeDeps()

    createRootDragHandlers(deps).onDrop(
      dropEvent([droppedFile('a.pdf', () => Promise.reject(new Error('NotReadableError')))])
    )

    await vi.waitFor(() => expect(deps.onDropError).toHaveBeenCalledWith('Could not add files'))
    expect(deps.onExternalDrop).not.toHaveBeenCalled()
  })

  it('does not blame the intake step for a failure inside onExternalDrop', async () => {
    // `onDropError`'s contract is "the drop failed BEFORE any file reached onExternalDrop" — that
    // one reports its own errors. A trailing `.catch` after `.then(deliver)` would also swallow
    // this rejection and flash a second, wrong message.
    const late = Promise.reject(new Error('import blew up after intake'))
    late.catch(() => {}) // the handler must not adopt this promise, so keep it handled here
    stubApi({
      getPathForFile: () => 'C:\\docs\\a.pdf',
      expandDropPaths: () => Promise.resolve([{ name: 'a.pdf', data: new Uint8Array([1]) }])
    })
    const deps = makeDeps({
      onExternalDrop: vi.fn(() => late) as unknown as RootDragDeps['onExternalDrop']
    })

    createRootDragHandlers(deps).onDrop(
      dropEvent([droppedFile('a.pdf', async () => new ArrayBuffer(1))])
    )

    await vi.waitFor(() => expect(deps.onExternalDrop).toHaveBeenCalled())
    // Drain the microtask queue so a (wrongly) chained rejection handler would have run by now.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(deps.onDropError).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('still forwards a successful drop without reporting an error', async () => {
    const files = [{ name: 'a.pdf', data: new Uint8Array([1]) }]
    stubApi({
      getPathForFile: () => 'C:\\docs\\a.pdf',
      expandDropPaths: () => Promise.resolve(files)
    })
    const deps = makeDeps()

    createRootDragHandlers(deps).onDrop(
      dropEvent([droppedFile('a.pdf', async () => new ArrayBuffer(1))])
    )

    await vi.waitFor(() => expect(deps.onExternalDrop).toHaveBeenCalledWith(files, null))
    expect(deps.onDropError).not.toHaveBeenCalled()
  })
})
