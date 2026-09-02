import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class FakeWindow {
    handlers = new Map<string, Array<() => void>>()
    destroyed = false
    send = vi.fn(() => {
      // A real webContents throws once its window is gone — that throw is what escapes
      // sendOpenPaths and rejects out of the pdfx:renderer-ready handler.
      if (this.destroyed) throw new Error('Object has been destroyed')
    })
    webContents = {
      on: (): void => {},
      setWindowOpenHandler: (): void => {},
      send: (...args: unknown[]): void => this.send(...(args as [])),
      isDestroyed: (): boolean => this.destroyed
    }
    on(event: string, handler: () => void): void {
      const list = this.handlers.get(event) ?? []
      list.push(handler)
      this.handlers.set(event, list)
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    show(): void {}
    loadFile(): void {}
    loadURL(): void {}
    emit(event: string): void {
      for (const handler of this.handlers.get(event) ?? []) handler()
    }
  }
  const windows: FakeWindow[] = []
  return { FakeWindow, windows }
})

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
  nativeTheme: { shouldUseDarkColors: true },
  BrowserWindow: class extends h.FakeWindow {
    constructor() {
      super()
      h.windows.push(this)
    }
  }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('./native/glass', () => ({
  GLASS_CONFIG: {},
  FALLBACK_BG: { dark: '#000000', light: '#ffffff' },
  applyNativeGlass: vi.fn()
}))
vi.mock('./markup', () => ({ destroyRenderWindow: vi.fn(), markupToPdf: vi.fn() }))
vi.mock('./file-intake', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./file-intake')>()
  return {
    ...actual,
    readFilesReport: vi.fn(async () => ({ files: [], skipped: [] }))
  }
})

import { destroyRenderWindow } from './markup'
import { readFilesReport } from './file-intake'

let win: typeof import('./window')

beforeEach(async () => {
  vi.resetModules()
  vi.mocked(destroyRenderWindow).mockClear()
  vi.mocked(readFilesReport).mockReset()
  vi.mocked(readFilesReport).mockResolvedValue({ files: [], skipped: [] })
  h.windows.length = 0
  win = await import('./window')
})

describe('main window teardown', () => {
  it('destroys the cached markup render window when the main window closes', async () => {
    win.createWindow()
    win.setRendererReady(true)
    expect(win.getMainWindow()).not.toBeNull()
    expect(vi.mocked(destroyRenderWindow)).not.toHaveBeenCalled()

    h.windows[0].emit('closed')

    // Without this the hidden markup window outlives the app: Electron still counts it, so
    // window-all-closed never fires and the process lingers holding the single-instance lock.
    expect(vi.mocked(destroyRenderWindow)).toHaveBeenCalledTimes(1)
    expect(win.getMainWindow()).toBeNull()
    expect(win.getRendererReady()).toBe(false)
  })
})

describe('sendOpenPaths', () => {
  it('sends the files it read to a live window', async () => {
    win.createWindow()
    const files = [{ name: 'a.pdf', data: new Uint8Array([1]), path: '/x/a.pdf' }]
    vi.mocked(readFilesReport).mockResolvedValue({ files, skipped: [] })

    await win.sendOpenPaths(['/x/a.pdf'])

    expect(h.windows[0].send).toHaveBeenCalledWith('pdfx:files-opened', files)
    expect(h.windows[0].send).toHaveBeenCalledTimes(1) // nothing skipped → no notice
  })

  it('tells the renderer about the paths it could not read', async () => {
    win.createWindow()
    vi.mocked(readFilesReport).mockResolvedValue({
      files: [{ name: 'a.pdf', data: new Uint8Array([1]), path: '/x/a.pdf' }],
      skipped: ['/x/gone.pdf', '/x/locked.pdf']
    })

    await win.sendOpenPaths(['/x/a.pdf', '/x/gone.pdf', '/x/locked.pdf'])

    // Explorer double-click / open-file / second-instance return nothing to a caller, so without
    // this the two unreadable files vanish with only a main-process console.warn.
    expect(h.windows[0].send).toHaveBeenCalledWith(
      'pdfx:notice',
      'Could not read 2 files: gone.pdf, locked.pdf'
    )
  })

  it('does not send when the window closes mid-read', async () => {
    win.createWindow()
    let finishRead = (): void => {}
    vi.mocked(readFilesReport).mockImplementation(
      () => new Promise((resolve) => (finishRead = () => resolve({ files: [], skipped: [] })))
    )

    const pending = win.sendOpenPaths(['/x/a.pdf'])
    // The user closes the window while a large batch is still being read.
    h.windows[0].destroyed = true
    h.windows[0].emit('closed')
    finishRead()

    // The webContents reference must be re-checked AFTER the await; capturing it up front sends on
    // a dead window, which throws out of the fire-and-forget open-file / renderer-ready callers.
    await expect(pending).resolves.toBeUndefined()
    expect(h.windows[0].send).not.toHaveBeenCalled()
  })

  it('does not send when the window is destroyed but not yet cleared', async () => {
    win.createWindow()
    let finishRead = (): void => {}
    vi.mocked(readFilesReport).mockImplementation(
      () => new Promise((resolve) => (finishRead = () => resolve({ files: [], skipped: [] })))
    )

    const pending = win.sendOpenPaths(['/x/a.pdf'])
    // destroy() without the 'closed' handler having run yet: mainWindow is still non-null.
    h.windows[0].destroyed = true
    finishRead()

    await expect(pending).resolves.toBeUndefined()
    expect(h.windows[0].send).not.toHaveBeenCalled()
  })
})
