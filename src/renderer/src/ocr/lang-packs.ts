// The renderer's view of the language packs (DESIGN.md §3.2.5, §3.8 "Language picker"; PR9): the
// catalogue main reports, download progress, and the last outcome per language. Main does every
// download and every file check; this store only ever names a catalogue code. Nothing here starts
// a download on its own: `download()` is called by the consent prompt's button and nothing else.

import type {
  LangDownloadError,
  LangDownloadResult,
  LangInstallResult,
  LangPackInfo,
  LangProgress
} from '../../../shared/ocr/lang-packs'
import { registerLangNames } from './ocr-ui'

/** `window.api.ocrLangs` (preload). */
export interface LangPacksApi {
  list(): Promise<LangPackInfo[]>
  download(code: string): Promise<LangDownloadResult>
  cancel(code: string): Promise<void>
  installFromFile(): Promise<LangInstallResult>
  onProgress(callback: (p: LangProgress) => void): () => void
}

export interface LangPacksSnapshot {
  /** The catalogue (empty until main answers, or when there is no API). */
  list: readonly LangPackInfo[]
  loaded: boolean
  /** Downloads in progress: code → bytes so far / total. */
  progress: ReadonlyMap<string, { received: number; total: number }>
  /** The last download that did not finish, per language (cleared by the next try). */
  errors: ReadonlyMap<string, LangDownloadError>
}

export interface LangPacksStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): LangPacksSnapshot
  /** Ask main for the list again (cheap). */
  refresh(): Promise<void>
  /** The user agreed to download `code` (the consent prompt). */
  download(code: string): Promise<LangDownloadResult>
  cancel(code: string): void
  /** Install from file…: main shows the open dialog and checks the file. */
  installFromFile(): Promise<LangInstallResult>
  /** Put a language's download address on the clipboard (the manual route). False: refused. */
  copyText(text: string): Promise<boolean>
  /** Installed (downloaded, from a file, or provisioned by an admin) catalogue codes. */
  installed(): ReadonlySet<string>
  info(code: string): LangPackInfo | undefined
  dispose(): void
}

/**
 * `writeText`: `window.api.writeClipboardText` (main writes the clipboard; `navigator.clipboard`
 * needs user activation the app can't count on).
 */
export function createLangPacks(
  api: LangPacksApi | null,
  writeText: ((text: string) => Promise<void>) | null = null
): LangPacksStore {
  let snap: LangPacksSnapshot = {
    list: [],
    loaded: false,
    progress: new Map(),
    errors: new Map()
  }
  let installedSet: ReadonlySet<string> = new Set()
  const listeners = new Set<() => void>()
  const emit = (next: Partial<LangPacksSnapshot>): void => {
    snap = { ...snap, ...next }
    if (next.list) {
      installedSet = new Set(next.list.filter((l) => l.state === 'installed').map((l) => l.code))
      registerLangNames(next.list)
    }
    for (const l of [...listeners]) l()
  }

  let refreshing: Promise<void> | null = null
  const refresh = (): Promise<void> => {
    if (!api) return Promise.resolve()
    refreshing ??= api
      .list()
      .then(
        (list) => emit({ list, loaded: true }),
        () => emit({ loaded: true })
      )
      .finally(() => {
        refreshing = null
      })
    return refreshing
  }

  const off = api?.onProgress((p) => {
    const progress = new Map(snap.progress)
    if (!p.done && p.total > 0) progress.set(p.code, { received: p.received, total: p.total })
    else progress.delete(p.code)
    emit({ progress })
    // Installed, failed or stopped: the list (installed / available) may have changed.
    if (p.done) void refresh()
  })

  if (api) void refresh()

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snap,
    refresh,
    async download(code) {
      if (!api) return { ok: false, error: 'offline' }
      const errors = new Map(snap.errors)
      errors.delete(code)
      const progress = new Map(snap.progress)
      const total = snap.list.find((l) => l.code === code)?.bytes ?? 0
      progress.set(code, { received: 0, total })
      emit({ errors, progress })
      let r: LangDownloadResult
      try {
        r = await api.download(code)
      } catch {
        r = { ok: false, error: 'offline' }
      }
      const after = new Map(snap.progress)
      after.delete(code)
      const errs = new Map(snap.errors)
      if (!r.ok && r.error !== 'cancelled') errs.set(code, r.error)
      emit({ progress: after, errors: errs })
      await refresh()
      return r
    },
    cancel(code) {
      void api?.cancel(code).catch(() => {})
    },
    async installFromFile() {
      if (!api) return { ok: false, error: 'cancelled' }
      let r: LangInstallResult
      try {
        r = await api.installFromFile()
      } catch {
        r = { ok: false, error: 'unreadable' }
      }
      if (r.ok) await refresh()
      return r
    },
    async copyText(text) {
      if (!writeText) return false
      try {
        await writeText(text)
        return true
      } catch {
        return false
      }
    },
    installed: () => installedSet,
    info: (code) => snap.list.find((l) => l.code === code),
    dispose() {
      off?.()
      listeners.clear()
    }
  }
}
