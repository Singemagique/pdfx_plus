// Language packs in main (DESIGN.md §3.2.5, §3.2.6; PR9). Electron-free: lang-host.ts injects
// `net.fetch` (Chromium networking: system proxy, PAC/WPAD, NTLM/Kerberos) and the directories, so
// every rule here runs in vitest with a fake fetch (lang-packs.node.test.ts).
//
// - Only catalogue languages (lang-manifest.json, compiled in). The renderer names a code; the
//   URL, the size and both SHA-256s come from the catalogue, never from the renderer or a server.
// - Download: `<code>.traineddata.gz.part` in userData/ocr/tessdata/4.0.0_best_int/, streamed and
//   hashed as it arrives, byte count and SHA-256 checked, fsync'd, then renamed into place (atomic
//   on one volume). Anything else deletes the .part. Connect timeout 15 s (headers), idle 30 s
//   (between chunks). A 407 (or a proxy sign-in the app's `login` handler had to refuse) is told
//   apart from being offline. Stale .part files are deleted at startup. One download per language.
// - Install from file…: a `.traineddata` or `.gz` under 100 MB, accepted only if its bytes or, for
//   a .gz, its gunzipped bytes match a catalogue entry (both hashes are compiled in). The file is
//   copied in the form that matched. Anything else is refused: the engine's model parsers are the
//   code with the unfixed advisories (D6), so it never sees a file nobody hashed in advance.
// - Admin-provisioned resources/ocr/tessdata/<code>.traineddata[.gz]: the same hash rule, checked
//   at startup; a file that does not match is ignored.
// - The utility process gets only `paths()` from here (main → init / `languages`), and checks every
//   file against the same compiled hashes again before any thread sees it.

import { createHash } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import {
  INSTALL_MAX_BYTES,
  type LangDownloadError,
  type LangDownloadResult,
  type LangInstallResult,
  type LangPackInfo,
  type LangProgress,
  type LangScript
} from '../../shared/ocr/lang-packs'
import { LANG_CATALOGUE, LANG_MIRRORS, type CatalogueLang } from './process/engine-manifest'

/** What `net.fetch` / global `fetch` resolve with, as far as a download needs it. */
export interface FetchResponseLike {
  readonly status: number
  readonly ok: boolean
  readonly body: ReadableStream<Uint8Array> | null
}

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<FetchResponseLike>

export interface LangPacksOptions {
  /** userData/ocr/tessdata/4.0.0_best_int (created on demand). */
  dir: string
  /** resources/ocr/tessdata when packaged (admin-provisioned files); null in dev. */
  adminDir: string | null
  fetch: FetchLike
  catalogue?: readonly CatalogueLang[]
  mirrors?: readonly string[]
  connectTimeoutMs?: number
  idleTimeoutMs?: number
  /** Minimum ms between two progress events per download. */
  progressMs?: number
  /** Called when the set of installed languages changes (main tells the utility process). */
  onInstalled?: (paths: Record<string, string>) => void
  /** Called on progress and when a download starts or ends (main tells the renderer). */
  onProgress?: (p: LangProgress) => void
  log?: (line: string) => void
  now?: () => number
}

export const CONNECT_TIMEOUT_MS = 15_000
export const IDLE_TIMEOUT_MS = 30_000

interface Installed {
  path: string
  source: 'download' | 'file' | 'admin'
}

interface Active {
  ctrl: AbortController
  received: number
  promise: Promise<LangDownloadResult>
  timedOut: boolean
  proxyAuth: boolean
  url: string
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

/** The host a URL names ("cdn.jsdelivr.net"), for the consent wording. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

class DownloadFailure extends Error {
  constructor(readonly kind: LangDownloadError) {
    super(kind)
  }
}

/** Errors that mean "no connection" (Chromium net:: codes and Node's undici/system codes). */
function isOffline(e: unknown): boolean {
  const s = `${(e as { message?: unknown })?.message ?? ''} ${String((e as { cause?: { code?: unknown } })?.cause?.code ?? '')}`
  return /INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|CONNECTION_(REFUSED|RESET|CLOSED|FAILED|TIMED_OUT)|NETWORK_CHANGED|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|fetch failed/i.test(
    s
  )
}

const isProxyAuthError = (e: unknown): boolean =>
  /PROXY_AUTH|ERR_TUNNEL_CONNECTION_FAILED/i.test(String((e as { message?: unknown })?.message))

export class LangPacks {
  private readonly catalogue: ReadonlyMap<string, CatalogueLang>
  private readonly mirrors: readonly string[]
  private readonly installed = new Map<string, Installed>()
  private readonly active = new Map<string, Active>()
  private ready: Promise<void> | null = null

  constructor(private readonly o: LangPacksOptions) {
    this.catalogue = new Map((o.catalogue ?? LANG_CATALOGUE).map((l) => [l.code, l]))
    this.mirrors = o.mirrors ?? LANG_MIRRORS
  }

  /**
   * Startup: delete stale `.part` files, then find the installed and admin-provisioned languages
   * whose bytes match the catalogue. Idempotent; everything else waits for it.
   */
  init(): Promise<void> {
    this.ready ??= this.scan()
    return this.ready
  }

  private async scan(): Promise<void> {
    await mkdir(this.o.dir, { recursive: true }).catch(() => {})
    let names: string[] = []
    try {
      names = await readdir(this.o.dir)
    } catch {
      names = []
    }
    for (const n of names)
      if (n.endsWith('.part')) await rm(join(this.o.dir, n), { force: true }).catch(() => {})
    const found = new Map<string, Installed>()
    const look = async (dir: string, source: Installed['source']): Promise<void> => {
      for (const code of this.catalogue.keys()) {
        if (found.has(code)) continue
        for (const name of [`${code}.traineddata.gz`, `${code}.traineddata`]) {
          const path = join(dir, name)
          const r = await this.matchFile(path).catch(() => null)
          if (r && r.code === code && r.form === (name.endsWith('.gz') ? 'gz' : 'raw')) {
            found.set(code, { path, source })
            break
          }
        }
      }
    }
    await look(this.o.dir, 'download')
    if (this.o.adminDir) await look(this.o.adminDir, 'admin')
    for (const [code, i] of found) if (!this.installed.has(code)) this.installed.set(code, i)
    if (found.size > 0) this.o.onInstalled?.(this.paths())
  }

  /** The verified installed languages, for the utility process (code → absolute path). */
  paths(): Record<string, string> {
    return Object.fromEntries([...this.installed].map(([c, i]) => [c, i.path]))
  }

  /** The catalogue as the picker shows it. */
  list(): LangPackInfo[] {
    return [...this.catalogue.values()].map((l) => {
      const a = this.active.get(l.code)
      const info: LangPackInfo = {
        code: l.code,
        name: l.name,
        nativeName: l.nativeName,
        script: l.script as LangScript,
        bytes: l.bytes,
        host: hostOf(this.urlsFor(l)[0] ?? ''),
        state: this.installed.has(l.code) ? 'installed' : a ? 'downloading' : 'available'
      }
      if (a && !this.installed.has(l.code)) info.received = a.received
      return info
    })
  }

  private urlsFor(l: CatalogueLang): string[] {
    return [...l.urls, ...this.mirrors.map((m) => m.replaceAll('{code}', l.code))]
  }

  // -------------------------------------------------------------------------------------------
  // Download.

  /**
   * Download one catalogue language (the renderer asked the user first; nothing here ever runs
   * on its own). Resolves, never rejects. A second call while one runs joins it.
   */
  download(code: string): Promise<LangDownloadResult> {
    const entry = this.catalogue.get(code)
    if (!entry) return Promise.resolve({ ok: false, error: 'unknown-language' })
    if (this.installed.has(code)) return Promise.resolve({ ok: true, code })
    const running = this.active.get(code)
    if (running) return running.promise
    const a: Active = {
      ctrl: new AbortController(),
      received: 0,
      promise: Promise.resolve({ ok: false, error: 'cancelled' }),
      timedOut: false,
      proxyAuth: false,
      url: ''
    }
    this.active.set(code, a)
    a.promise = this.run(entry, a).finally(() => {
      this.active.delete(code)
      this.o.onProgress?.({ code, received: a.received, total: entry.bytes, done: true })
    })
    this.o.onProgress?.({ code, received: 0, total: entry.bytes })
    return a.promise
  }

  /** Stop a download (its .part is deleted). */
  cancel(code: string): void {
    this.active.get(code)?.ctrl.abort()
  }

  /**
   * The app's `login` handler saw a proxy ask for credentials for `url`: if it is one of our
   * downloads, remember it (the request then fails as a sign-in PDFx can't give, not as offline).
   * Returns whether the URL is ours.
   */
  proxyAuthRequested(url: string): boolean {
    for (const a of this.active.values())
      if (a.url && (a.url === url || hostOf(a.url) === hostOf(url))) {
        a.proxyAuth = true
        return true
      }
    return false
  }

  /** Is any download running for this URL's host? (lang-host's `login` handler asks.) */
  isDownloadHost(url: string): boolean {
    const h = hostOf(url)
    return !!h && [...this.active.values()].some((a) => hostOf(a.url) === h)
  }

  private async run(entry: CatalogueLang, a: Active): Promise<LangDownloadResult> {
    await this.init()
    const urls = this.urlsFor(entry)
    let last: LangDownloadError = 'offline'
    for (const url of urls) {
      if (a.ctrl.signal.aborted && !a.timedOut) return { ok: false, error: 'cancelled' }
      const r = await this.fetchOne(entry, a, url)
      if (r.ok) return r
      last = r.error
      // A wrong file from one host may be a bad mirror; anything the user did, or that the next
      // host can't fix (the proxy, the disk), ends the download.
      if (r.error === 'cancelled' || r.error === 'proxy-auth' || r.error === 'disk') return r
      a.ctrl = new AbortController()
      a.timedOut = false
    }
    return { ok: false, error: last }
  }

  private async fetchOne(
    entry: CatalogueLang,
    a: Active,
    url: string
  ): Promise<LangDownloadResult> {
    const connectMs = this.o.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
    const idleMs = this.o.idleTimeoutMs ?? IDLE_TIMEOUT_MS
    const final = join(this.o.dir, `${entry.code}.traineddata.gz`)
    const part = `${final}.part`
    const signal = a.ctrl.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (ms: number): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        a.timedOut = true
        a.ctrl.abort()
      }, ms)
    }
    a.url = url
    a.received = 0
    a.proxyAuth = false
    let fh: FileHandle | null = null
    let renamed = false
    const now = this.o.now ?? Date.now
    let lastProgress = -Infinity
    try {
      arm(connectMs)
      let res: FetchResponseLike
      try {
        res = await this.o.fetch(url, { signal })
      } catch (e) {
        throw this.classify(e, a)
      }
      if (res.status === 407 || a.proxyAuth) throw new DownloadFailure('proxy-auth')
      if (!res.ok || !res.body) throw new DownloadFailure('http')
      arm(idleMs)
      try {
        await mkdir(this.o.dir, { recursive: true })
        fh = await open(part, 'w', 0o600)
      } catch {
        throw new DownloadFailure('disk')
      }
      const hash = createHash('sha256')
      const reader = res.body.getReader()
      // A timeout or cancel must end a read that is waiting on a stalled body, whether or not the
      // body itself watches the signal: cancelling the reader settles the pending read.
      const onAbort = (): void => void reader.cancel().catch(() => {})
      signal.addEventListener('abort', onAbort, { once: true })
      let drained = false
      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>
          try {
            chunk = await reader.read()
          } catch (e) {
            throw this.classify(e, a)
          }
          if (chunk.done) {
            drained = true
            break
          }
          if (signal.aborted) throw this.classify(new Error('aborted'), a)
          const bytes = chunk.value
          arm(idleMs)
          a.received += bytes.byteLength
          // More than the catalogue says: never write past it.
          if (a.received > entry.bytes) throw new DownloadFailure('verify')
          hash.update(bytes)
          try {
            await fh.write(bytes)
          } catch {
            throw new DownloadFailure('disk')
          }
          const t = now()
          if (t - lastProgress >= (this.o.progressMs ?? 100)) {
            lastProgress = t
            this.o.onProgress?.({ code: entry.code, received: a.received, total: entry.bytes })
          }
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
        // Leaving early (timeout, cancel, too many bytes, a write error): stop the transfer too.
        if (!drained) await reader.cancel().catch(() => {})
        reader.releaseLock?.()
      }
      clearTimeout(timer)
      if (signal.aborted) throw this.classify(new Error('aborted'), a)
      // Truncated, or not the catalogue's file: deleted, nothing installed.
      if (a.received !== entry.bytes || hash.digest('hex') !== entry.sha256Gz)
        throw new DownloadFailure('verify')
      try {
        await fh.sync()
        await fh.close()
        fh = null
        await rename(part, final)
        renamed = true
      } catch {
        throw new DownloadFailure('disk')
      }
      await this.syncDir()
      await rm(join(this.o.dir, `${entry.code}.traineddata`), { force: true }).catch(() => {})
      this.installed.set(entry.code, { path: final, source: 'download' })
      this.o.onInstalled?.(this.paths())
      return { ok: true, code: entry.code }
    } catch (e) {
      const kind = e instanceof DownloadFailure ? e.kind : this.classify(e, a).kind
      if (kind !== 'cancelled') this.o.log?.(`ocr: download of ${entry.code} failed (${kind})`)
      return { ok: false, error: kind }
    } finally {
      clearTimeout(timer)
      await fh?.close().catch(() => {})
      if (!renamed) await rm(part, { force: true }).catch(() => {})
    }
  }

  private classify(e: unknown, a: Active): DownloadFailure {
    if (e instanceof DownloadFailure) return e
    if (a.proxyAuth || isProxyAuthError(e)) return new DownloadFailure('proxy-auth')
    if (a.ctrl.signal.aborted) return new DownloadFailure(a.timedOut ? 'timeout' : 'cancelled')
    if (isOffline(e)) return new DownloadFailure('offline')
    return new DownloadFailure('offline')
  }

  /** fsync the directory after the rename where the OS allows it (not on Windows). */
  private async syncDir(): Promise<void> {
    if (process.platform === 'win32') return
    let d: FileHandle | null = null
    try {
      d = await open(this.o.dir, 'r')
      await d.sync()
    } catch {
      // Best effort: some filesystems refuse a directory fsync.
    } finally {
      await d?.close().catch(() => {})
    }
  }

  // -------------------------------------------------------------------------------------------
  // Install from file… and the hash rule.

  /**
   * Which catalogue language a file is, by its bytes or (for gzip) its gunzipped bytes, or null.
   * Bounded: files of INSTALL_MAX_BYTES or more are not read, and gunzipping stops past the
   * largest raw size the catalogue knows.
   */
  async matchFile(
    path: string
  ): Promise<{ code: string; form: 'gz' | 'raw'; bytes: Uint8Array } | null> {
    const s = await stat(path)
    if (!s.isFile() || s.size >= INSTALL_MAX_BYTES) return null
    const bytes = new Uint8Array(await readFile(path))
    return this.matchBytes(bytes)
  }

  private matchBytes(
    bytes: Uint8Array
  ): { code: string; form: 'gz' | 'raw'; bytes: Uint8Array } | null {
    const h = sha256(bytes)
    for (const l of this.catalogue.values()) {
      if (bytes.byteLength === l.bytes && h === l.sha256Gz)
        return { code: l.code, form: 'gz', bytes }
      if (bytes.byteLength === l.rawBytes && h === l.sha256Raw)
        return { code: l.code, form: 'raw', bytes }
    }
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      // A re-compressed copy of a catalogue file: its gunzipped bytes may still match.
      const maxRaw = Math.max(0, ...[...this.catalogue.values()].map((l) => l.rawBytes))
      let raw: Uint8Array
      try {
        raw = new Uint8Array(gunzipSync(bytes, { maxOutputLength: maxRaw + 1 }))
      } catch {
        return null
      }
      const hr = sha256(raw)
      for (const l of this.catalogue.values())
        if (raw.byteLength === l.rawBytes && hr === l.sha256Raw)
          return { code: l.code, form: 'raw', bytes: raw }
    }
    return null
  }

  /** Install from file… (main chose the path in its own open dialog; never a renderer path). */
  async installFile(path: string): Promise<LangInstallResult> {
    await this.init()
    const lower = basename(path).toLowerCase()
    if (!(lower.endsWith('.traineddata') || extname(lower) === '.gz'))
      return { ok: false, error: 'wrong-type' }
    let size: number
    try {
      const s = await stat(path)
      if (!s.isFile()) return { ok: false, error: 'unreadable' }
      size = s.size
    } catch {
      return { ok: false, error: 'unreadable' }
    }
    if (size >= INSTALL_MAX_BYTES) return { ok: false, error: 'too-large' }
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await readFile(path))
    } catch {
      return { ok: false, error: 'unreadable' }
    }
    const m = this.matchBytes(bytes)
    if (!m) return { ok: false, error: 'unknown-file' }
    const name = m.form === 'gz' ? `${m.code}.traineddata.gz` : `${m.code}.traineddata`
    const other = m.form === 'gz' ? `${m.code}.traineddata` : `${m.code}.traineddata.gz`
    const final = join(this.o.dir, name)
    const part = `${final}.part`
    let fh: FileHandle | null = null
    try {
      await mkdir(this.o.dir, { recursive: true })
      fh = await open(part, 'w', 0o600)
      await fh.writeFile(m.bytes)
      await fh.sync()
      await fh.close()
      fh = null
      await rename(part, final)
    } catch {
      await fh?.close().catch(() => {})
      await rm(part, { force: true }).catch(() => {})
      return { ok: false, error: 'disk' }
    }
    await this.syncDir()
    // One file per language: the form that matched replaces the other.
    await rm(join(this.o.dir, other), { force: true }).catch(() => {})
    this.installed.set(m.code, { path: final, source: 'file' })
    this.o.onInstalled?.(this.paths())
    this.o.onProgress?.({ code: m.code, received: 0, total: 0, done: true })
    return { ok: true, code: m.code }
  }
}
