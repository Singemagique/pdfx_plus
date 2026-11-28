// Electron wiring for language packs (DESIGN.md §3.2.5, PR9). Everything with logic is in
// lang-packs.ts; this file supplies `net.fetch` (Chromium networking: system proxy, PAC/WPAD,
// NTLM/Kerberos), the userData and resources directories, the IPC and the `login` hook.
//
// Downloads happen here in main and only here: the utility process gets the verified paths in its
// `init` or a `languages` message and never touches the network (its tripwire stays at 0).

import { app, dialog, ipcMain, net, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'

import { LANG_RE } from '../../shared/ocr/protocol'
import { LANG_CHANNELS, type LangInstallResult } from '../../shared/ocr/lang-packs'
import { getMainWindow } from '../window'
import { LangPacks, type FetchLike } from './lang-packs'
import { RESOURCES_TESSDATA_DIR, TESSDATA_VERSION } from './process/engine-manifest'

let packs: LangPacks | null = null
let installedListener: ((paths: Record<string, string>) => void) | null = null

/** userData/ocr/tessdata/4.0.0_best_int (PDFX_USER_DATA applies: index.ts sets userData first). */
export function langPacksDir(): string {
  return join(app.getPath('userData'), 'ocr', 'tessdata', TESSDATA_VERSION)
}

const netFetch: FetchLike = (url, init) =>
  net.fetch(url, { signal: init.signal, redirect: 'follow', cache: 'no-store' })

/** The one LangPacks of the app (created on first use, after the userData override). */
export function langPacks(): LangPacks {
  packs ??= new LangPacks({
    dir: langPacksDir(),
    adminDir: app.isPackaged ? join(process.resourcesPath, RESOURCES_TESSDATA_DIR) : null,
    fetch: netFetch,
    onInstalled: (paths) => installedListener?.(paths),
    onProgress: (p) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) win.webContents.send(LANG_CHANNELS.progress, p)
    },
    log: (line) => console.warn(line)
  })
  return packs
}

/** Only the app window's top frame may list, download or install languages. */
function fromAppWindow(event: IpcMainInvokeEvent): boolean {
  const main = getMainWindow()
  return (
    !!main && event.sender === main.webContents && event.senderFrame === main.webContents.mainFrame
  )
}

const code = (x: unknown): string => {
  if (typeof x !== 'string' || !LANG_RE.test(x)) throw new Error('ocr-lang: invalid language code')
  return x
}

/**
 * IPC for the picker and the summary row, the startup check of installed files, and the proxy
 * sign-in hook. `onInstalled` hears every change of the installed set (main forwards it to the
 * utility process). Call once, after ready.
 */
export function registerOcrLangs(onInstalled: (paths: Record<string, string>) => void): void {
  installedListener = onInstalled
  const p = langPacks()
  // Startup: stale .part files go, installed and admin-provisioned files are checked.
  void p.init()

  ipcMain.handle(LANG_CHANNELS.list, async (event) => {
    if (!fromAppWindow(event)) return []
    await p.init()
    return p.list()
  })
  // The renderer asked the user first (§3.2.5 consent); nothing in main starts a download itself.
  ipcMain.handle(LANG_CHANNELS.download, (event, c: unknown) => {
    if (!fromAppWindow(event)) return { ok: false, error: 'cancelled' }
    return p.download(code(c))
  })
  ipcMain.handle(LANG_CHANNELS.cancel, (event, c: unknown) => {
    if (fromAppWindow(event)) p.cancel(code(c))
  })
  // Install from file…: main shows the dialog, so the renderer never hands main a path.
  ipcMain.handle(LANG_CHANNELS.installFile, async (event): Promise<LangInstallResult> => {
    const win = getMainWindow()
    if (!win || !fromAppWindow(event)) return { ok: false, error: 'cancelled' }
    const r = await dialog.showOpenDialog(win, {
      title: 'Install language data',
      properties: ['openFile'],
      filters: [
        { name: 'Tesseract language data', extensions: ['traineddata', 'gz'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'cancelled' }
    return p.installFile(r.filePaths[0])
  })

  // A proxy asking our download for a sign-in (HTTP 407). PDFx has no credentials to give and
  // never prompts for them: Electron's default (cancel) stands, and the download reports
  // 'proxy-auth' instead of 'offline'. NTLM / Kerberos proxies are answered by Chromium itself.
  app.on('login', (_event, webContents, details, authInfo) => {
    if (!authInfo.isProxy || webContents) return
    p.proxyAuthRequested(details.url)
  })
}
