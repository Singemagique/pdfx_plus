import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  OCR_CONNECT_CHANNEL,
  OCR_DISCONNECTED_CHANNEL,
  OCR_DISCONNECT_REASONS,
  OCR_PORT_CHANNEL,
  type FromOcr,
  type OcrDisconnectReason,
  type OcrLinkEvent,
  type ToOcr
} from '../shared/ocr/protocol'
import type { Settings } from '../shared/settings'

export type { FromOcr, OcrLinkEvent, Settings, ToOcr }

/** What `ocr.onMessage` delivers: protocol messages from the port, plus link events. */
export type OcrMessage = FromOcr | OcrLinkEvent

// The OCR port (DESIGN.md §3.3.1). Main hands this preload the renderer's end of a fresh
// MessageChannelMain on 'ocr:port'; the port itself never crosses contextBridge, only the three
// functions in `api.ocr` do. Posts never use a transfer list: a renderer-side transfer delivers
// `null` to the utility process and detaches the source (PR0).
let ocrPort: MessagePort | null = null
let ocrConnecting = false
const ocrQueue: ToOcr[] = []
const ocrListeners = new Set<(message: OcrMessage) => void>()

function ocrEmit(message: OcrMessage): void {
  for (const listener of [...ocrListeners]) {
    try {
      listener(message)
    } catch (error) {
      console.error(error)
    }
  }
}

function ocrDrop(reason: OcrDisconnectReason): void {
  const hadLink = ocrPort !== null || ocrConnecting
  ocrPort?.close()
  ocrPort = null
  ocrConnecting = false
  ocrQueue.length = 0
  if (hadLink) ocrEmit({ link: { state: 'disconnected', reason } })
}

ipcRenderer.on(OCR_PORT_CHANNEL, (event) => {
  const port = event.ports[0]
  if (!port) return
  // A port is never reused: a new one replaces the old one outright.
  ocrPort?.close()
  ocrPort = port
  ocrConnecting = false
  port.onmessage = (e: MessageEvent): void => {
    if (ocrPort === port) ocrEmit(e.data as FromOcr)
  }
  port.addEventListener('close', () => {
    if (ocrPort === port) ocrDrop('closed')
  })
  port.start()
  ocrEmit({ link: { state: 'connected' } })
  for (const message of ocrQueue.splice(0)) port.postMessage(message)
})

ipcRenderer.on(OCR_DISCONNECTED_CHANNEL, (_event, info: { reason?: unknown } | null) => {
  const reason = (OCR_DISCONNECT_REASONS as readonly unknown[]).includes(info?.reason)
    ? (info!.reason as OcrDisconnectReason)
    : 'closed'
  ocrDrop(reason)
})

export interface OpenedFile {
  name: string
  data: Uint8Array
  path?: string
}

export type ZoomAction = 'in' | 'out' | 'reset'

export type MenuAction = 'open' | 'export-pdfx' | 'export-pdf' | 'export-zip' | 'find'

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
  /** When set, embed a DSS (cert chain + OCSP/CRL) for long-term validation (PAdES B-LT). */
  ltv?: boolean
}

/** A token (smart card) present in a PKCS#11 module. */
export interface Pkcs11Token {
  slot: number
  label: string
  manufacturer: string
  model: string
  serial: string
}

/** A signing certificate in the Windows store (its key may be on a smart card). */
export interface WindowsCert {
  thumbprint: string
  subject: string
  issuer: string
  notAfter: string
  keyUsage: string
}

/** A signer's certificate identity (X.500 DN strings) for the visible signature appearance. */
export interface SignerInfo {
  subject: string
  issuer: string
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
  // Tamper-gate prompt for a .pdfx whose content no longer matches its saved edits. Resolves to the
  // chosen button: 0 = open without edits, 1 = load edits anyway, 2 = cancel.
  confirmIntegrity: (detail: string): Promise<number> =>
    ipcRenderer.invoke('pdfx:confirm-integrity', detail),
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
  /** Subject + issuer of a PKCS#12's signing certificate (for the appearance); null if unreadable. */
  p12CertInfo: (p12: Uint8Array, passphrase: string): Promise<SignerInfo | null> =>
    ipcRenderer.invoke('pdfx:p12-cert-info', p12, passphrase),
  findCardModules: (): Promise<Array<{ path: string; label: string }>> =>
    ipcRenderer.invoke('pdfx:pkcs11-find-modules'),
  listCardTokens: (modulePath: string): Promise<Pkcs11Token[]> =>
    ipcRenderer.invoke('pdfx:pkcs11-list-tokens', modulePath),
  /** Subject + issuer of a smart card's signing certificate (no PIN prompt); null if unreadable. */
  cardCertInfo: (card: Omit<CardSignOptions, 'pin'>): Promise<SignerInfo | null> =>
    ipcRenderer.invoke('pdfx:card-cert-info', card),
  signPdfWithCard: (
    pdf: Uint8Array,
    card: CardSignOptions,
    opts: Omit<SignOptions, 'passphrase'>
  ): Promise<Uint8Array> => ipcRenderer.invoke('pdfx:sign-pdf-card', pdf, card, opts),
  listWindowsCerts: (): Promise<WindowsCert[]> => ipcRenderer.invoke('pdfx:win-cert-list'),
  signPdfWithWindowsCert: (
    pdf: Uint8Array,
    thumbprint: string,
    opts: Omit<SignOptions, 'passphrase'>
  ): Promise<Uint8Array> => ipcRenderer.invoke('pdfx:sign-pdf-win-cert', pdf, thumbprint, opts),
  openFiles: (): Promise<OpenedFile[]> => ipcRenderer.invoke('pdfx:open-files'),
  onFilesOpened: (callback: (files: OpenedFile[]) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, files: OpenedFile[]): void =>
      callback(files)
    ipcRenderer.on('pdfx:files-opened', listener)
    return () => ipcRenderer.removeListener('pdfx:files-opened', listener)
  },
  /** Short main-process messages for the toast (e.g. files that could not be read on open/drop). */
  onNotice: (callback: (message: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string): void => callback(message)
    ipcRenderer.on('pdfx:notice', listener)
    return () => ipcRenderer.removeListener('pdfx:notice', listener)
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
  },
  /** App settings (userData/settings.json), validated in main. */
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('pdfx:settings-get'),
  /** Merge a patch; main rejects unknown keys or invalid values. Resolves with the new settings. */
  setSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('pdfx:settings-set', patch),
  /** Text recognition: a port to the "pdfx-ocr" utility process, kept inside this preload. */
  ocr: {
    /** Ask main for a fresh port (spawns the OCR process if needed). Posts queue until it arrives. */
    connect: (): void => {
      ocrConnecting = true
      ipcRenderer.send(OCR_CONNECT_CHANNEL)
    },
    /** Post a protocol message. False if there is no port and no connect in flight. */
    post: (message: ToOcr): boolean => {
      if (ocrPort) {
        ocrPort.postMessage(message)
        return true
      }
      if (ocrConnecting) {
        ocrQueue.push(message)
        return true
      }
      return false
    },
    /** Subscribe to protocol messages and link events. Returns an unsubscribe function. */
    onMessage: (callback: (message: OcrMessage) => void): (() => void) => {
      ocrListeners.add(callback)
      return () => {
        ocrListeners.delete(callback)
      }
    }
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
