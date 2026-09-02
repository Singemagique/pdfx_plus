import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class FakeWindow {
    handlers = new Map<string, Array<() => void>>()
    webContents = {
      on: (): void => {},
      setWindowOpenHandler: (): void => {},
      send: (): void => {}
    }
    on(event: string, handler: () => void): void {
      const list = this.handlers.get(event) ?? []
      list.push(handler)
      this.handlers.set(event, list)
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

import { destroyRenderWindow } from './markup'

let win: typeof import('./window')

beforeEach(async () => {
  vi.resetModules()
  vi.mocked(destroyRenderWindow).mockClear()
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
