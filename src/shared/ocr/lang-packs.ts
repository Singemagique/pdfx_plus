// Language packs (DESIGN.md §3.2.5, PR9): what main tells the renderer about the downloadable
// languages and how a download or an Install from file… ended. Main owns the catalogue
// (src/main/ocr/lang-manifest.json), the files and the network; the renderer only ever names a
// catalogue code, never a path or a URL. DOM-free and Electron-free.

/** IPC channels (main ⇄ renderer, `ipcMain.handle` / `webContents.send`). */
export const LANG_CHANNELS = {
  list: 'pdfx:ocr-langs',
  download: 'pdfx:ocr-lang-download',
  cancel: 'pdfx:ocr-lang-cancel',
  installFile: 'pdfx:ocr-lang-install-file',
  /** main → renderer: download progress and list changes. */
  progress: 'pdfx:ocr-lang-progress'
} as const

/** ISO 15924 scripts the catalogue uses. */
export type LangScript = 'Latn' | 'Cyrl' | 'Grek' | 'Hans' | 'Hant' | 'Jpan' | 'Kore' | 'Deva'

/** CJK scripts: their labels carry "(printed text; photos may be less accurate)" (§3.2.5). */
export const CJK_SCRIPTS: ReadonlySet<string> = new Set(['Hans', 'Hant', 'Jpan', 'Kore'])

export interface LangPackInfo {
  code: string
  /** English name ("Russian"). */
  name: string
  /** Native name ("Русский"). */
  nativeName: string
  script: LangScript
  /** The .traineddata.gz download size in bytes. */
  bytes: number
  /** Where a download comes from ("cdn.jsdelivr.net"): the consent names it. */
  host: string
  /**
   * installed: on this computer (downloaded, installed from a file, or provisioned by an admin in
   * resources/ocr/tessdata); available: can be downloaded; downloading: in progress.
   */
  state: 'installed' | 'available' | 'downloading'
  /** While downloading: bytes so far. */
  received?: number
}

export interface LangProgress {
  code: string
  received: number
  total: number
  /** The download ended (either way) or the installed set changed: re-read the list. */
  done?: boolean
}

/** Why a download did not finish. */
export type LangDownloadError =
  /** No connection, DNS failure, connection refused or reset. */
  | 'offline'
  /** The proxy asked for a sign-in PDFx cannot give (HTTP 407). */
  | 'proxy-auth'
  /** The host answered with an error status. */
  | 'http'
  /** No response within 15 s, or no data for 30 s. */
  | 'timeout'
  /** The file did not match the catalogue (size or SHA-256): deleted, nothing installed. */
  | 'verify'
  | 'cancelled'
  /** The file could not be written (disk full, permissions). */
  | 'disk'
  | 'unknown-language'

export type LangDownloadResult =
  | { ok: true; code: string }
  | { ok: false; error: LangDownloadError }

export type LangInstallError =
  /** 100 MB or more. */
  | 'too-large'
  /** Not .traineddata or .gz. */
  | 'wrong-type'
  /** Neither its bytes nor its gunzipped bytes match a catalogue entry. */
  | 'unknown-file'
  | 'unreadable'
  | 'disk'

export type LangInstallResult =
  | { ok: true; code: string }
  | { ok: false; error: LangInstallError }
  /** The user closed the file dialog. */
  | { ok: false; error: 'cancelled' }

/** Install from file… refuses anything this size or larger (§3.2.5). */
export const INSTALL_MAX_BYTES = 100 * 1024 * 1024
