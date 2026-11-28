// Ctrl/Cmd+Shift+R (Recognize Text…, DESIGN.md §3.8) through the REAL before-input-event chain of
// the main window: @electron-toolkit's watchWindowShortcuts handler (registered first, as index.ts
// does on browser-window-created) and window.ts's own, with is.dev true and false. The toolkit
// preventDefaults every Ctrl/Cmd+R in packaged builds, which would block a menu accelerator; our
// handler must still deliver exactly one 'recognize-text' per press, on every platform's modifier.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: { preventDefault: () => void }, input: Record<string, unknown>) => void

const h = vi.hoisted(() => {
  class FakeWebContents {
    handlers = new Map<string, Handler[]>()
    send = vi.fn()
    on(event: string, handler: Handler): void {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    }
    setWindowOpenHandler(): void {}
    isDevToolsOpened(): boolean {
      return false
    }
    openDevTools(): void {}
    closeDevTools(): void {}
    isDestroyed(): boolean {
      return false
    }
  }
  class FakeWindow {
    webContents = new FakeWebContents()
    constructor() {
      state.windows.push(this)
      // Electron emits app 'browser-window-created' from the constructor: index.ts attaches the
      // toolkit's handler there, so it runs BEFORE window.ts's own.
      state.onCreated?.(this)
    }
    on(): void {}
    isDestroyed(): boolean {
      return false
    }
    show(): void {}
    loadFile(): void {}
    loadURL(): void {}
    close(): void {}
  }
  const state = {
    packaged: true,
    windows: [] as FakeWindow[],
    onCreated: null as ((w: FakeWindow) => void) | null,
    FakeWindow
  }
  return state
})

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.packaged
    }
  },
  session: {},
  ipcMain: { on: vi.fn() },
  shell: { openExternal: vi.fn() },
  nativeTheme: { shouldUseDarkColors: true },
  BrowserWindow: class extends h.FakeWindow {}
}))
// window.ts's own `is` (will-navigate only); the chain uses the real toolkit, loaded below.
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false }, optimizer: {} }))
vi.mock('./native/glass', () => ({
  GLASS_CONFIG: {},
  FALLBACK_BG: { dark: '#000000', light: '#ffffff' },
  applyNativeGlass: vi.fn()
}))
vi.mock('./markup', () => ({ destroyRenderWindow: vi.fn(), markupToPdf: vi.fn() }))
vi.mock('./file-intake', () => ({ readFilesReport: vi.fn(), skippedNotice: vi.fn() }))

import * as electron from 'electron'

interface Toolkit {
  is: { dev: boolean }
  optimizer: { watchWindowShortcuts: (w: unknown, o?: { zoom?: boolean }) => void }
}

/**
 * The toolkit's REAL code (its published CJS build), evaluated afresh against the mocked
 * 'electron', so `is.dev` (computed once, from `app.isPackaged`, when the module loads) follows
 * `h.packaged`. (vitest neither routes an externalised dependency's own `require('electron')`
 * through vi.mock nor re-runs a mock factory after resetModules.)
 */
function loadToolkit(): Toolkit {
  const req = createRequire(import.meta.url)
  const src = readFileSync(req.resolve('@electron-toolkit/utils'), 'utf8')
  const mod = { exports: {} as Record<string, unknown> }
  new Function('require', 'module', 'exports', src)(
    (id: string) => (id === 'electron' ? electron : req(id)),
    mod,
    mod.exports
  )
  return mod.exports as unknown as Toolkit
}

const realPlatform = process.platform
const setPlatform = (p: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

/** A fresh main window with both handlers, for `dev` (is.dev) on `platform`. */
async function mainWindow(dev: boolean, platform: NodeJS.Platform) {
  vi.resetModules()
  h.windows.length = 0
  h.packaged = !dev
  setPlatform(platform)
  const toolkit = loadToolkit()
  expect(toolkit.is.dev).toBe(dev)
  h.onCreated = (w) => toolkit.optimizer.watchWindowShortcuts(w as never, { zoom: true })
  const win = await import('./window')
  win.createWindow()
  const wc = h.windows[0].webContents
  const handlers = wc.handlers.get('before-input-event') ?? []
  /** One keyDown through the whole chain, as Electron runs it: every listener, in order. */
  const press = (input: Record<string, unknown>): boolean => {
    let prevented = false
    const event = { preventDefault: () => (prevented = true) }
    const full = {
      type: 'keyDown',
      control: false,
      meta: false,
      shift: false,
      alt: false,
      ...input
    }
    for (const handler of handlers) handler(event, full)
    return prevented
  }
  const sends = (): unknown[][] => wc.send.mock.calls.filter((c) => c[0] === 'pdfx:menu')
  return { handlers, press, sends }
}

beforeEach(() => {
  h.onCreated = null
})

afterEach(() => {
  setPlatform(realPlatform)
})

describe.each([
  ['packaged (is.dev false)', false],
  ['dev (is.dev true)', true]
])('Recognize Text shortcut, %s', (_label, dev) => {
  it('Windows / Linux: Ctrl+Shift+R sends recognize-text exactly once and is consumed', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const w = await mainWindow(dev, platform)
      // The toolkit's handler and ours: the chain under test really is two listeners.
      expect(w.handlers).toHaveLength(2)
      const prevented = w.press({ code: 'KeyR', key: 'R', control: true, shift: true })
      expect(prevented).toBe(true)
      expect(w.sends()).toEqual([['pdfx:menu', 'recognize-text']])
      // Meta (the Windows key) is not the modifier there.
      w.press({ code: 'KeyR', key: 'R', meta: true, shift: true })
      expect(w.sends()).toHaveLength(1)
    }
  })

  it('macOS: Cmd+Shift+R sends it once; Ctrl+Shift+R does not', async () => {
    const w = await mainWindow(dev, 'darwin')
    w.press({ code: 'KeyR', key: 'R', control: true, shift: true })
    expect(w.sends()).toHaveLength(0)
    expect(w.press({ code: 'KeyR', key: 'R', meta: true, shift: true })).toBe(true)
    expect(w.sends()).toEqual([['pdfx:menu', 'recognize-text']])
  })

  it('one send per press: key-up, auto-repeat, plain Ctrl+R and Ctrl+Alt+Shift+R send nothing', async () => {
    const w = await mainWindow(dev, 'win32')
    w.press({ type: 'keyUp', code: 'KeyR', control: true, shift: true })
    w.press({ code: 'KeyR', control: true, shift: true, isAutoRepeat: true })
    w.press({ code: 'KeyR', control: true })
    w.press({ code: 'KeyR', control: true, shift: true, alt: true })
    w.press({ code: 'KeyT', control: true, shift: true })
    expect(w.sends()).toHaveLength(0)
    w.press({ code: 'KeyR', control: true, shift: true })
    w.press({ code: 'KeyR', control: true, shift: true })
    expect(w.sends()).toHaveLength(2)
  })
})

it('in a packaged build the toolkit alone already consumes Ctrl+R (why the menu cannot deliver it)', async () => {
  vi.resetModules()
  h.packaged = true
  setPlatform('win32')
  const toolkit = loadToolkit()
  const wc = new (h.FakeWindow as unknown as new () => {
    webContents: { handlers: Map<string, Handler[]> }
  })().webContents
  toolkit.optimizer.watchWindowShortcuts({ webContents: wc } as never, { zoom: true })
  let prevented = false
  for (const handler of wc.handlers.get('before-input-event')!)
    handler(
      { preventDefault: () => (prevented = true) },
      {
        type: 'keyDown',
        code: 'KeyR',
        control: true,
        shift: true
      }
    )
  expect(prevented).toBe(true)
})
