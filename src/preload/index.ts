import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface OpenedFile {
  name: string
  data: Uint8Array
  path?: string
}

export type ZoomAction = 'in' | 'out' | 'reset'

export type MenuAction = 'open' | 'export-pdfx' | 'export-pdf' | 'export-zip'

export interface SaveFilter {
  name: string
  extensions: string[]
}

export interface SignOptions {
  passphrase?: string
  reason?: string
  name?: string
  location?: string
  /** RFC3161 Timestamp Authority URL — when set, upgrades the signature to PAdES B-T. */
  tsaUrl?: string
}

/** A token (smart card) present in a PKCS#11 module. */
export interface Pkcs11Token {
  slot: number
  label: string
  manufacturer: string
  model: string
  serial: string
}

/** Locates the signing credential on a smart card via a PKCS#11 module. */
export interface CardSignOptions {
  /** Absolute path to the PKCS#11 module (.dll/.so/.dylib). */
  modulePath: string
  /** User PIN. */
  pin: string
  /** Slot id (omit to auto-pick by tokenLabel, else the first token). */
  slot?: number
  /** Token label to match when no slot is given. */
  tokenLabel?: string
  /** Certificate label, to disambiguate a token holding several certificates. */
  certLabel?: string
}

const api = {
  platform: process.platform,
  rendererReady: (): Promise<void> => ipcRenderer.invoke('pdfx:renderer-ready'),
  chooseSavePath: (defaultName: string, filter?: SaveFilter): Promise<string | null> =>
    ipcRenderer.invoke('pdfx:choose-save-path', defaultName, filter),
  readClipboardImage: (): Promise<Uint8Array | null> =>
    ipcRenderer.invoke('pdfx:read-clipboard-image'),
  readClipboardFiles: (): Promise<OpenedFile[]> => ipcRenderer.invoke('pdfx:read-clipboard-files'),
  clearClipboard: (): Promise<void> => ipcRenderer.invoke('pdfx:clipboard-clear'),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  expandDropPaths: (paths: string[]): Promise<OpenedFile[]> =>
    ipcRenderer.invoke('pdfx:expand-drop-paths', paths),
  readResource: (
    htmlPath: string,
    ref: string
  ): Promise<{ data: Uint8Array; mime: string } | null> =>
    ipcRenderer.invoke('pdfx:read-resource', htmlPath, ref),
  markupToPdf: (html: string, fitPageHeightPx?: number): Promise<Uint8Array> =>
    ipcRenderer.invoke('pdfx:markup-to-pdf', html, fitPageHeightPx),
  writeFile: (path: string, data: Uint8Array): Promise<string> =>
    ipcRenderer.invoke('pdfx:write-file', path, data),
  signPdf: (pdf: Uint8Array, p12: Uint8Array, opts: SignOptions): Promise<Uint8Array> =>
    ipcRenderer.invoke('pdfx:sign-pdf', pdf, p12, opts),
  findCardModules: (): Promise<Array<{ path: string; label: string }>> =>
    ipcRenderer.invoke('pdfx:pkcs11-find-modules'),
  listCardTokens: (modulePath: string): Promise<Pkcs11Token[]> =>
    ipcRenderer.invoke('pdfx:pkcs11-list-tokens', modulePath),
  signPdfWithCard: (
    pdf: Uint8Array,
    card: CardSignOptions,
    opts: Omit<SignOptions, 'passphrase'>
  ): Promise<Uint8Array> => ipcRenderer.invoke('pdfx:sign-pdf-card', pdf, card, opts),
  openFiles: (): Promise<OpenedFile[]> => ipcRenderer.invoke('pdfx:open-files'),
  onFilesOpened: (callback: (files: OpenedFile[]) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, files: OpenedFile[]): void =>
      callback(files)
    ipcRenderer.on('pdfx:files-opened', listener)
    return () => ipcRenderer.removeListener('pdfx:files-opened', listener)
  },
  onZoom: (callback: (action: ZoomAction) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: ZoomAction): void =>
      callback(action)
    ipcRenderer.on('pdfx:zoom', listener)
    return () => ipcRenderer.removeListener('pdfx:zoom', listener)
  },
  onMenu: (callback: (action: MenuAction) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: MenuAction): void =>
      callback(action)
    ipcRenderer.on('pdfx:menu', listener)
    return () => ipcRenderer.removeListener('pdfx:menu', listener)
  }
}

export type PdfxApi = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.api = api
}
