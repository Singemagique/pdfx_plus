import { BrowserWindow, session } from 'electron'

const PARTITION = 'pdfx-markup-render'
const RENDER_TIMEOUT_MS = 10_000

let renderWin: BrowserWindow | null = null
let sessionHardened = false
let chain: Promise<unknown> = Promise.resolve()

function hardenSession(): void {
  if (sessionHardened) return
  sessionHardened = true
  const ses = session.fromPartition(PARTITION)
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith('data:') }))
  ses.webRequest.onHeadersReceived((details, cb) =>
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:"
        ]
      }
    })
  )
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
}

function getRenderWindow(): BrowserWindow {
  if (renderWin && !renderWin.isDestroyed()) return renderWin
  hardenSession()
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webgl: false,
      webSecurity: true,
      partition: PARTITION
    }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.on('will-redirect', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('closed', () => {
    if (renderWin === win) renderWin = null
  })
  renderWin = win
  return win
}

/**
 * Tear down the cached hidden render window.
 *
 * Electron counts this window in `getAllWindows()`, so leaving it alive after the main window is
 * gone keeps `window-all-closed` from ever firing (the app lingers invisibly, still holding the
 * single-instance lock, so a relaunch is silently dead) and makes the macOS dock `activate` check
 * see a non-empty window list. `getRenderWindow()` re-creates lazily, so destroying it here never
 * breaks a later markupToPdf.
 */
export function destroyRenderWindow(): void {
  const win = renderWin
  renderWin = null
  if (win && !win.isDestroyed()) win.destroy()
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        // Rejecting only unblocks the wrapper: the timed-out render keeps driving the SHARED
        // window, so the next job in the chain would race it (blank PDF or spurious failure).
        // Destroy the window BEFORE the chain advances so the next job gets a fresh one.
        destroyRenderWindow()
        reject(new Error('markup render timed out'))
      }, ms)
    })
  ]).finally(() => clearTimeout(timer))
}

async function renderOnce(html: string, fitPageHeightPx?: number): Promise<Uint8Array> {
  const win = getRenderWindow()
  const dataUrl =
    'data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64')
  await win.loadURL(dataUrl)
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true).catch(() => true)')

  if (fitPageHeightPx != null) {
    await win.webContents.executeJavaScript(
      `(() => {
        const b = document.body
        b.style.transformOrigin = 'top left'
        const h = b.scrollHeight, ph = ${fitPageHeightPx}
        if (h > ph + 1) b.style.transform = 'scale(' + (ph / h) + ')'
        return true
      })()`
    )
  }

  const data = await win.webContents.printToPDF({
    printBackground: true,
    preferCSSPageSize: true,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    ...(fitPageHeightPx != null ? { pageRanges: '1' } : {})
  })
  await win.loadURL('data:text/html,').catch(() => {})
  return new Uint8Array(data)
}

export function markupToPdf(html: string, fitPageHeightPx?: number): Promise<Uint8Array> {
  const job = chain.then(() => withTimeout(renderOnce(html, fitPageHeightPx), RENDER_TIMEOUT_MS))
  chain = job.catch(() => undefined)
  return job
}
