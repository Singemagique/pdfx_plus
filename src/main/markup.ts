import { BrowserWindow, session } from 'electron'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PARTITION = 'pdfx-markup-render'
const RENDER_TIMEOUT_MS = 10_000

let renderWin: BrowserWindow | null = null
let sessionHardened = false
let chain: Promise<unknown> = Promise.resolve()
/**
 * The temp file the in-flight render is loading, or null between renders. Renders are serialised
 * through `chain`, so there is at most one, and it is the ONLY file: URL the session will load.
 */
let allowedDocPath: string | null = null

function samePath(a: string, b: string): boolean {
  const x = path.resolve(a)
  const y = path.resolve(b)
  // NTFS is case-insensitive; elsewhere compare exactly (a mismatch can only block, never allow).
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/**
 * The render session's network allowlist: `data:` URLs (inlined images/fonts/styles and the
 * blank page loaded between renders) and exactly the one temp document being rendered. Every
 * other request — http(s), any other file (a sibling in the temp dir, `../`, a UNC share), a
 * query-string variant of the document — is cancelled.
 *
 * Compares decoded filesystem paths, not URL strings: Chromium's file-URL canonicalisation need not
 * match Node's `pathToFileURL` (Chromium percent-encodes `~`, as in Windows 8.3 short names like
 * `ABCDEF~1` in the temp path; Node does or does not depending on version), so a string compare
 * could block the very document being rendered.
 */
export function isAllowedRenderRequest(url: string, docPath: string | null): boolean {
  if (url.startsWith('data:')) return true
  if (docPath == null || !url.startsWith('file:')) return false
  let requested: string
  try {
    const u = new URL(url)
    if (u.search !== '') return false
    // Throws on a non-local host (POSIX) or an encoded path separator — both refused.
    requested = fileURLToPath(u)
  } catch {
    return false
  }
  return samePath(requested, docPath)
}

/**
 * Write the markup to a private temp file for the render window to load.
 *
 * The document used to be handed over as a base64 `data:` URL, but Chromium rejects URLs past
 * ~2 MB (ERR_INVALID_URL), so any page with an inlined photo (>~1.57 MB of HTML, once base64'd)
 * failed to open at all. A file has no such limit; the 64 MiB IPC cap in register-ipc still bounds
 * it. The directory is created by mkdtemp (0700 on POSIX) and the file is 0600, so other local
 * users cannot read the document while it exists.
 */
async function writeTempDocument(
  html: string
): Promise<{ file: string; dispose: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pdfx-markup-'))
  const dispose = (): Promise<void> => rm(dir, { recursive: true, force: true }).catch(() => {})
  try {
    const file = path.join(dir, 'document.html')
    await writeFile(file, html, { encoding: 'utf8', mode: 0o600 })
    return { file, dispose }
  } catch (err) {
    await dispose()
    throw err
  }
}

function hardenSession(): void {
  if (sessionHardened) return
  sessionHardened = true
  const ses = session.fromPartition(PARTITION)
  ses.webRequest.onBeforeRequest((details, cb) =>
    cb({ cancel: !isAllowedRenderRequest(details.url, allowedDocPath) })
  )
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

async function renderOnce(docPath: string, fitPageHeightPx?: number): Promise<Uint8Array> {
  const win = getRenderWindow()
  await win.loadURL(pathToFileURL(docPath).href)
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

async function renderJob(html: string, fitPageHeightPx?: number): Promise<Uint8Array> {
  const doc = await writeTempDocument(html)
  allowedDocPath = doc.file
  try {
    return await withTimeout(renderOnce(doc.file, fitPageHeightPx), RENDER_TIMEOUT_MS)
  } finally {
    // Outside withTimeout on purpose: a timed-out render never settles, but its window has been
    // destroyed by then, so revoking the allowlist entry and deleting the file here is safe — and
    // it happens before the chain advances to the next job.
    allowedDocPath = null
    await doc.dispose()
  }
}

export function markupToPdf(html: string, fitPageHeightPx?: number): Promise<Uint8Array> {
  const job = chain.then(() => renderJob(html, fitPageHeightPx))
  chain = job.catch(() => undefined)
  return job
}
