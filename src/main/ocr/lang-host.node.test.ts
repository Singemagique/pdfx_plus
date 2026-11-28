// lang-host.ts (PR9): the IPC guards around language packs. Only the app window's top frame is
// answered; only a catalogue-shaped code crosses; Install from file… opens main's own dialog (the
// renderer never names a path); downloads go through `net.fetch` in main; the `login` hook marks a
// proxy challenge on our download as a sign-in PDFx can't give, and leaves every other one alone.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const h = vi.hoisted(() => {
  const mainFrame = { id: 'top' }
  const webContents = { send: vi.fn(), mainFrame }
  return {
    handlers: new Map<string, Handler>(),
    appListeners: new Map<string, (...a: unknown[]) => void>(),
    userData: { current: '' },
    webContents,
    window: { webContents, isDestroyed: () => false },
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
    fetch: vi.fn(async () => ({ status: 404, ok: false, body: null }))
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: (n: string) => {
      if (n !== 'userData') throw new Error(n)
      return h.userData.current
    },
    isPackaged: false,
    on: (event: string, l: (...a: unknown[]) => void) => h.appListeners.set(event, l)
  },
  ipcMain: { handle: (c: string, fn: Handler) => h.handlers.set(c, fn) },
  dialog: { showOpenDialog: h.showOpenDialog },
  net: { fetch: h.fetch }
}))
vi.mock('../window', () => ({ getMainWindow: () => h.window }))

import { LANG_CHANNELS } from '../../shared/ocr/lang-packs'
import { langPacks, langPacksDir, registerOcrLangs } from './lang-host'

const fromApp = { sender: h.webContents, senderFrame: h.webContents.mainFrame }
const fromSubframe = { sender: h.webContents, senderFrame: { id: 'iframe' } }
const fromOther = { sender: { mainFrame: {} }, senderFrame: {} }
const call = (channel: string, event: unknown, ...args: unknown[]): unknown =>
  h.handlers.get(channel)!(event, ...args)

const installed: Array<Record<string, string>> = []

beforeAll(() => {
  h.userData.current = mkdtempSync(join(tmpdir(), 'pdfx-langhost-'))
  registerOcrLangs((p) => installed.push(p))
})
afterAll(() => rmSync(h.userData.current, { recursive: true, force: true }))
beforeEach(() => {
  h.showOpenDialog.mockClear()
  h.fetch.mockClear()
})

describe('lang-host IPC', () => {
  it('registers its channels and keeps packs under userData/ocr/tessdata/4.0.0_best_int', () => {
    for (const c of [
      LANG_CHANNELS.list,
      LANG_CHANNELS.download,
      LANG_CHANNELS.cancel,
      LANG_CHANNELS.installFile
    ])
      expect(h.handlers.has(c), c).toBe(true)
    expect(langPacksDir()).toBe(join(h.userData.current, 'ocr', 'tessdata', '4.0.0_best_int'))
  })

  it('answers the app window’s top frame only', async () => {
    const list = (await call(LANG_CHANNELS.list, fromApp)) as Array<{ code: string }>
    expect(list.map((l) => l.code)).toContain('rus')
    expect(await call(LANG_CHANNELS.list, fromSubframe)).toEqual([])
    expect(await call(LANG_CHANNELS.list, fromOther)).toEqual([])
    expect(await call(LANG_CHANNELS.download, fromSubframe, 'rus')).toEqual({
      ok: false,
      error: 'cancelled'
    })
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('takes a language code and nothing else; downloads go through net.fetch', async () => {
    for (const bad of ['../x', 'https://evil.example/x.gz', 42, null, 'RUS'])
      expect(() => call(LANG_CHANNELS.download, fromApp, bad)).toThrow(/invalid language code/)
    expect(await call(LANG_CHANNELS.download, fromApp, 'ara')).toEqual({
      ok: false,
      error: 'unknown-language'
    })
    expect(h.fetch).not.toHaveBeenCalled()
    expect(await call(LANG_CHANNELS.download, fromApp, 'rus')).toEqual({ ok: false, error: 'http' })
    expect(h.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = h.fetch.mock.calls[0] as unknown as [string, { signal: AbortSignal }]
    expect(url).toBe(
      'https://cdn.jsdelivr.net/npm/@tesseract.js-data/rus@1.0.0/4.0.0_best_int/rus.traineddata.gz'
    )
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('Install from file… uses main’s own dialog and the chosen file only', async () => {
    expect(await call(LANG_CHANNELS.installFile, fromApp, '/renderer/path.gz')).toEqual({
      ok: false,
      error: 'cancelled'
    })
    expect(h.showOpenDialog).toHaveBeenCalledTimes(1)
    const f = join(h.userData.current, 'not-a-language.traineddata')
    writeFileSync(f, 'nope')
    h.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [f] })
    expect(await call(LANG_CHANNELS.installFile, fromApp)).toEqual({
      ok: false,
      error: 'unknown-file'
    })
    expect(await call(LANG_CHANNELS.installFile, fromSubframe)).toEqual({
      ok: false,
      error: 'cancelled'
    })
    expect(h.showOpenDialog).toHaveBeenCalledTimes(2)
    expect(installed).toEqual([])
  })

  it('the login hook only notes proxy challenges with no page behind them', () => {
    const login = h.appListeners.get('login')!
    const spy = vi.spyOn(langPacks(), 'proxyAuthRequested')
    login(
      { preventDefault: vi.fn() },
      null,
      { url: 'https://cdn.jsdelivr.net/x' },
      { isProxy: false }
    )
    login({}, { id: 1 }, { url: 'https://cdn.jsdelivr.net/x' }, { isProxy: true })
    expect(spy).not.toHaveBeenCalled()
    const event = { preventDefault: vi.fn() }
    login(event, null, { url: 'https://cdn.jsdelivr.net/x' }, { isProxy: true })
    expect(spy).toHaveBeenCalledWith('https://cdn.jsdelivr.net/x')
    // Electron's default (cancel the sign-in) stands: PDFx never supplies credentials.
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
})
