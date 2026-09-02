import { app, nativeTheme } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { FALLBACK_BG } from './native/glass'
import { collectFileArgs } from './file-intake'
import { createWindow, getMainWindow, getRendererReady, sendOpenPaths } from './window'
import { buildMenu } from './menu'
import { registerIpc } from './register-ipc'

app.setName('PDFx')

if (process.env.PDFX_USER_DATA) {
  app.setPath('userData', process.env.PDFX_USER_DATA)
}

let pendingOpenPaths: string[] = []

app.on('open-file', (event, path) => {
  event.preventDefault()
  if (getRendererReady()) {
    // Fire-and-forget, but never as an unhandled rejection: readFiles tolerates a bad path, yet
    // the IPC send itself can still fail (window torn down mid-flight).
    sendOpenPaths([path]).catch(console.error)
  } else {
    pendingOpenPaths.push(path)
  }
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const mainWindow = getMainWindow()
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    sendOpenPaths(collectFileArgs(argv.slice(1))).catch(console.error)
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.pdfx.app')

    nativeTheme.themeSource = 'dark'

    if (process.platform === 'darwin' && is.dev) {
      const devIcon = join(app.getAppPath(), 'build', 'icon.png')
      if (existsSync(devIcon)) app.dock?.setIcon(devIcon)
    }

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window, { zoom: true })
    })

    pendingOpenPaths.push(...collectFileArgs(process.argv.slice(1)))

    registerIpc(
      () => pendingOpenPaths,
      () => {
        pendingOpenPaths = []
      }
    )

    buildMenu()
    createWindow()

    if (process.platform !== 'darwin') {
      nativeTheme.on('updated', () => {
        getMainWindow()?.setBackgroundColor(
          nativeTheme.shouldUseDarkColors ? FALLBACK_BG.dark : FALLBACK_BG.light
        )
      })
    }

    app.on('activate', () => {
      // Key off our own main window rather than the raw window count: hidden helper windows
      // (e.g. the markup renderer) also show up in getAllWindows(), and any that outlive the
      // main window would make the dock click a no-op.
      if (!getMainWindow()) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
