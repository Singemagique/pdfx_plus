// The packaged self-test's shortcut check (DESIGN.md §3.8, §3.9.3 1c), the Electron half: build the
// app's own window exactly as the app does (window.ts createWindow, with the toolkit's
// watchWindowShortcuts attached on browser-window-created as index.ts attaches it, and the app
// menu), keep it HIDDEN, send the Recognize Text chord with webContents.sendInputEvent and count the
// `pdfx:menu` 'recognize-text' sends. The verdict (pass / fail, required on every OS) is selftest.ts
// `shortcutVerdict`. Menu accelerators do not fire on a hidden window (PR0) and not through
// sendInputEvent at all on macOS (PR0b), so only window.ts's handler can deliver it.

import { app, Menu, type BrowserWindow, type MenuItem } from 'electron'
import { optimizer } from '@electron-toolkit/utils'

import { buildMenu } from '../menu'
import { createWindow, getMainWindow } from '../window'
import { shortcutVerdict, type ShortcutReport } from './selftest'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** menu.ts's Document item: id 'recognize-text' (the MenuAction), labelled "Recognize Text…". */
function hasRecognizeItem(items: MenuItem[] | undefined): boolean {
  for (const i of items ?? []) {
    if (i.id === 'recognize-text' && i.label === 'Recognize Text…') return true
    if (hasRecognizeItem(i.submenu?.items)) return true
  }
  return false
}

type Mod = 'control' | 'meta' | 'shift'

export async function runShortcutCheck(): Promise<ShortcutReport> {
  // As index.ts: the toolkit's handler goes on every window first, then window.ts adds its own.
  const onCreated = (_e: unknown, w: BrowserWindow): void =>
    optimizer.watchWindowShortcuts(w, { zoom: true })
  app.on('browser-window-created', onCreated)
  let win: BrowserWindow | null = null
  try {
    buildMenu()
    createWindow()
    win = getMainWindow()
  } finally {
    app.removeListener('browser-window-created', onCreated)
  }
  if (!win)
    return shortcutVerdict({
      menuItem: false,
      sends: 0,
      wrongModifierSends: null,
      keyDowns: 0,
      loaded: false
    })
  // Never shown: window.ts shows it on ready-to-show, which has not fired yet.
  win.removeAllListeners('ready-to-show')
  const wc = win.webContents
  const recognize = { count: 0 }
  const realSend = wc.send.bind(wc)
  // Count, and keep it from the renderer: nothing should start recognising in a hidden window.
  wc.send = ((channel: string, ...args: unknown[]): void => {
    if (channel === 'pdfx:menu') {
      if (args[0] === 'recognize-text') recognize.count++
      return
    }
    realSend(channel, ...args)
  }) as typeof wc.send
  let keyDowns = 0
  wc.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.code === 'KeyR') keyDowns++
  })
  const loaded = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 20_000)
    wc.once('did-finish-load', () => {
      clearTimeout(t)
      resolve(true)
    })
    wc.once('did-fail-load', () => {
      clearTimeout(t)
      resolve(false)
    })
  })
  const press = async (modifiers: Mod[]): Promise<number> => {
    const before = recognize.count
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers })
    await sleep(500)
    return recognize.count - before
  }
  const darwin = process.platform === 'darwin'
  const sends = await press(darwin ? ['meta', 'shift'] : ['control', 'shift'])
  const wrongModifierSends = darwin ? await press(['control', 'shift']) : null
  const menuItem = hasRecognizeItem(Menu.getApplicationMenu()?.items)
  win.destroy()
  return shortcutVerdict({ menuItem, sends, wrongModifierSends, keyDowns, loaded })
}
