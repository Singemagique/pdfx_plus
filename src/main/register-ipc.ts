import { ipcMain, dialog, clipboard } from 'electron'
import { basename, isAbsolute } from 'path'
import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'
import { markupToPdf } from './markup'
import { signPdf, signPdfWithCard, signPdfWithWindowsCert } from './sign'
import { listTokens, findModules } from './pkcs11'
import { listWindowsCerts } from './windows-cert'
import { OpenedFile, IMPORTABLE, readFiles, expandDropPaths } from './file-intake'
import { clipboardFilePaths } from './clipboard'
import { readResource } from './resource'
import { getMainWindow, setRendererReady, sendOpenPaths } from './window'

const MAX_WRITE_BYTES = 1024 * 1024 * 1024 // 1 GiB cap on a single IPC write

export function registerIpc(getPending: () => string[], clearPending: () => void): void {
  ipcMain.handle('pdfx:renderer-ready', async () => {
    setRendererReady(true)
    const paths = getPending()
    clearPending()
    await sendOpenPaths(paths)
  })

  ipcMain.handle(
    'pdfx:choose-save-path',
    async (_event, defaultName: string, filter?: { name: string; extensions: string[] }) => {
      const mainWindow = getMainWindow()
      if (!mainWindow) return null
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export',
        defaultPath: defaultName,
        filters: [filter ?? { name: 'PDFX', extensions: ['pdfx'] }]
      })
      return result.canceled || !result.filePath ? null : result.filePath
    }
  )

  ipcMain.handle('pdfx:read-clipboard-image', () => {
    const image = clipboard.readImage()
    return image.isEmpty() ? null : new Uint8Array(image.toPNG())
  })

  ipcMain.handle('pdfx:read-clipboard-files', async (): Promise<OpenedFile[]> => {
    const paths = clipboardFilePaths().filter((p) => IMPORTABLE.test(p) && existsSync(p))
    return readFiles(paths)
  })

  ipcMain.handle('pdfx:clipboard-clear', () => clipboard.clear())

  ipcMain.handle(
    'pdfx:expand-drop-paths',
    async (_event, paths: string[]): Promise<OpenedFile[]> =>
      readFiles(await expandDropPaths(paths))
  )

  ipcMain.handle('pdfx:read-resource', (_event, htmlPath: string, ref: string) =>
    readResource(htmlPath, ref)
  )

  ipcMain.handle(
    'pdfx:markup-to-pdf',
    (_event, html: string, fitPageHeightPx?: number): Promise<Uint8Array> => {
      // Coerce to a finite positive number so the value can never be a string that
      // breaks out of the numeric context where markup.ts interpolates it into
      // executeJavaScript.
      const ph = Number(fitPageHeightPx)
      return markupToPdf(html, Number.isFinite(ph) && ph > 0 ? ph : undefined)
    }
  )

  ipcMain.handle('pdfx:write-file', async (_event, path: string, data: Uint8Array) => {
    // The renderer must hand us a concrete absolute path (these come from the native
    // save dialog). Reject relative paths, null-byte truncation tricks, and absurd
    // payload sizes so a compromised renderer can't turn this into a write primitive.
    if (typeof path !== 'string' || !path || path.includes('\0') || !isAbsolute(path)) {
      throw new Error('write-file: refusing invalid path')
    }
    if (!ArrayBuffer.isView(data) || data.byteLength > MAX_WRITE_BYTES) {
      throw new Error('write-file: refusing invalid payload')
    }
    await writeFile(path, data)
    return basename(path)
  })

  ipcMain.handle(
    'pdfx:sign-pdf',
    async (
      _event,
      pdf: Uint8Array,
      p12: Uint8Array,
      opts: {
        passphrase?: string
        reason?: string
        name?: string
        location?: string
        tsaUrl?: string
      }
    ): Promise<Uint8Array> => {
      if (!ArrayBuffer.isView(pdf) || !ArrayBuffer.isView(p12)) {
        throw new Error('sign-pdf: invalid payload')
      }
      // Bound payloads (parity with write-file) so a compromised renderer can't OOM the main process.
      if (pdf.byteLength > MAX_WRITE_BYTES || p12.byteLength > 4 * 1024 * 1024) {
        throw new Error('sign-pdf: payload too large')
      }
      const o = opts ?? {}
      // Coerce options to strings so a misbehaving renderer can't inject non-string values.
      return signPdf(pdf, p12, {
        passphrase: String(o.passphrase ?? ''),
        reason: o.reason != null ? String(o.reason) : undefined,
        name: o.name != null ? String(o.name) : undefined,
        location: o.location != null ? String(o.location) : undefined,
        tsaUrl: o.tsaUrl ? String(o.tsaUrl) : undefined
      })
    }
  )

  // Validate a renderer-supplied PKCS#11 module path before handing it to koffi.load (which
  // dlopen/LoadLibrary's it into the main process). The renderer is trusted, but mirror the
  // write-file guards — absolute path, no null-byte truncation, and a native-library extension.
  const validModulePath = (p: unknown): string => {
    if (typeof p !== 'string' || !p || p.includes('\0') || !isAbsolute(p)) {
      throw new Error('A valid absolute PKCS#11 module path is required')
    }
    if (!/\.(dll|so|dylib)$/i.test(p)) {
      throw new Error('PKCS#11 module must be a .dll, .so or .dylib')
    }
    return p
  }

  // Probe common install locations for PKCS#11 modules so the smart-card signer can auto-fill them.
  ipcMain.handle(
    'pdfx:pkcs11-find-modules',
    async (): Promise<Array<{ path: string; label: string }>> => findModules()
  )

  // Enumerate the tokens (cards) currently present in a PKCS#11 module, for the smart-card signer.
  ipcMain.handle(
    'pdfx:pkcs11-list-tokens',
    async (
      _event,
      modulePath: unknown
    ): Promise<
      Array<{ slot: number; label: string; manufacturer: string; model: string; serial: string }>
    > => {
      return listTokens(validModulePath(modulePath))
    }
  )

  ipcMain.handle(
    'pdfx:sign-pdf-card',
    async (
      _event,
      pdf: Uint8Array,
      pkcs11: {
        modulePath?: string
        pin?: string
        slot?: number
        tokenLabel?: string
        certLabel?: string
      },
      opts: { reason?: string; name?: string; location?: string; tsaUrl?: string }
    ): Promise<Uint8Array> => {
      if (!ArrayBuffer.isView(pdf) || pdf.byteLength > MAX_WRITE_BYTES) {
        throw new Error('sign-pdf-card: invalid payload')
      }
      const c = pkcs11 ?? {}
      const o = opts ?? {}
      // Only accept a valid non-negative 32-bit integer slot; anything else falls back to auto-pick.
      const slot =
        typeof c.slot === 'number' &&
        Number.isInteger(c.slot) &&
        c.slot >= 0 &&
        c.slot <= 0xffffffff
          ? c.slot
          : undefined
      return signPdfWithCard(
        pdf,
        {
          modulePath: validModulePath(c.modulePath),
          pin: String(c.pin ?? ''),
          slot,
          tokenLabel: c.tokenLabel != null ? String(c.tokenLabel) : undefined,
          certLabel: c.certLabel != null ? String(c.certLabel) : undefined
        },
        {
          reason: o.reason != null ? String(o.reason) : undefined,
          name: o.name != null ? String(o.name) : undefined,
          location: o.location != null ? String(o.location) : undefined,
          tsaUrl: o.tsaUrl ? String(o.tsaUrl) : undefined
        }
      )
    }
  )

  // List signing certificates in the Windows store (a CAC/PIV card's certs appear here). Win-only.
  ipcMain.handle(
    'pdfx:win-cert-list',
    async (): Promise<
      Array<{
        thumbprint: string
        subject: string
        issuer: string
        notAfter: string
        keyUsage: string
      }>
    > => {
      if (process.platform !== 'win32') return []
      return listWindowsCerts()
    }
  )

  ipcMain.handle(
    'pdfx:sign-pdf-win-cert',
    async (
      _event,
      pdf: Uint8Array,
      thumbprint: unknown,
      opts: { reason?: string; name?: string; location?: string; tsaUrl?: string }
    ): Promise<Uint8Array> => {
      if (!ArrayBuffer.isView(pdf) || pdf.byteLength > MAX_WRITE_BYTES) {
        throw new Error('sign-pdf-win-cert: invalid payload')
      }
      if (typeof thumbprint !== 'string' || !/^[0-9A-Fa-f]{40}$/.test(thumbprint)) {
        throw new Error('sign-pdf-win-cert: invalid certificate thumbprint')
      }
      const o = opts ?? {}
      return signPdfWithWindowsCert(pdf, thumbprint, {
        reason: o.reason != null ? String(o.reason) : undefined,
        name: o.name != null ? String(o.name) : undefined,
        location: o.location != null ? String(o.location) : undefined,
        tsaUrl: o.tsaUrl ? String(o.tsaUrl) : undefined
      })
    }
  )

  ipcMain.handle('pdfx:open-files', async (): Promise<OpenedFile[]> => {
    const mainWindow = getMainWindow()
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open documents',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Documents',
          extensions: [
            'pdf',
            'pdfx',
            'png',
            'jpg',
            'jpeg',
            'webp',
            'gif',
            'bmp',
            'avif',
            'txt',
            'rtf',
            'svg',
            'html',
            'htm'
          ]
        },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled) return []
    return readFiles(result.filePaths)
  })
}
