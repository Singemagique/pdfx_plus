import { shell, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { GLASS_CONFIG, FALLBACK_BG, applyNativeGlass } from './native/glass'
import { readFilesReport, skippedNotice } from './file-intake'
import { destroyRenderWindow } from './markup'

let mainWindow: BrowserWindow | null = null
let rendererReady = false

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function getRendererReady(): boolean {
  return rendererReady
}

export function setRendererReady(value: boolean): void {
  rendererReady = value
}

export function toggleDevTools(): void {
  const wc = mainWindow?.webContents
  if (!wc) return
  if (wc.isDevToolsOpened()) wc.closeDevTools()
  else wc.openDevTools({ mode: 'detach' })
}

/**
 * The main window's own shortcuts, handled before the page sees the key (`before-input-event`):
 * - Ctrl+Shift+I / Alt+Cmd+I: developer tools;
 * - Ctrl+Shift+R / Cmd+Shift+R: Recognize Text… (DESIGN.md §3.8). Not a menu accelerator: the
 *   toolkit's watchWindowShortcuts preventDefaults every Ctrl/Cmd+R combination in packaged builds,
 *   which blocks the menu accelerator too (PR0 measured 0 fires). This handler fires whatever the
 *   toolkit did (Electron runs every listener), so the action arrives exactly once in dev and
 *   packaged builds alike; the menu item shows the shortcut with `registerAccelerator: false`.
 */
export function onShortcutInput(
  wc: Pick<Electron.WebContents, 'send'>,
  event: { preventDefault: () => void },
  input: Pick<Electron.Input, 'type' | 'code' | 'control' | 'meta' | 'shift' | 'alt'> & {
    isAutoRepeat?: boolean
  }
): void {
  if (input.type !== 'keyDown') return
  const mod = process.platform === 'darwin' ? input.meta : input.control
  if (input.code === 'KeyI') {
    if (mod && (input.shift || input.alt)) {
      event.preventDefault()
      toggleDevTools()
    }
    return
  }
  if (input.code === 'KeyR' && mod && input.shift && !input.alt) {
    event.preventDefault()
    // A held key repeats keyDown: the dialog opens once per press.
    if (!input.isAutoRepeat) wc.send('pdfx:menu', 'recognize-text')
  }
}

export async function sendOpenPaths(paths: string[]): Promise<void> {
  if (!mainWindow || paths.length === 0) return
  const { files, skipped } = await readFilesReport(paths)
  // Re-check after the await: the window can be torn down mid-read (the user closes it while a
  // large batch is loading), and sending on a destroyed webContents throws — which would surface
  // as a rejection out of the pdfx:renderer-ready handler / the fire-and-forget open-file paths.
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('pdfx:files-opened', files)
  // These routes (Explorer double-click, macOS open-file, a second instance) have no return value
  // the caller can inspect, so an unreadable path would otherwise vanish with only a main-process
  // console.warn to show for it.
  if (skipped.length > 0) mainWindow.webContents.send('pdfx:notice', skippedNotice(skipped))
}

export function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    ...GLASS_CONFIG,
    ...(process.platform === 'darwin'
      ? {}
      : {
          backgroundColor: nativeTheme.shouldUseDarkColors ? FALLBACK_BG.dark : FALLBACK_BG.light
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  applyNativeGlass(mainWindow)
  mainWindow.on('closed', () => {
    mainWindow = null
    rendererReady = false
    // The markup renderer keeps a hidden BrowserWindow cached forever. Electron counts it, so
    // unless it dies with the main window, `window-all-closed` never fires (the app lingers
    // invisibly holding the single-instance lock) and macOS `activate` sees a non-empty window
    // list. This is the one place that always runs when the main window goes away — the app can
    // be quit from the menu, the window chrome, or an OS shutdown — so the teardown belongs here.
    destroyRenderWindow()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Only hand genuine web/mail links to the OS; never blindly open arbitrary
    // schemes (file:, custom protocols, etc.) that a compromised renderer could craft.
    let protocol = ''
    try {
      protocol = new URL(details.url).protocol
    } catch {
      protocol = ''
    }
    if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  // The renderer is a local single-page app; the only legitimate top-level
  // navigation is the dev server. Block everything else (defense in depth).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (is.dev && devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
  })

  const wc = mainWindow.webContents
  wc.on('before-input-event', (event, input) => onShortcutInput(wc, event, input))

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
