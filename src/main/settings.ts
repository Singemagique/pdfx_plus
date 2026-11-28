// App settings (DESIGN.md §3.5.2): `userData/settings.json`, read and written only by main and
// reached by the renderer through `pdfx:settings-get` / `pdfx:settings-set`. There was no settings
// store before OCR; this is deliberately tiny.
//
// - Schema-validated in main: `set` rejects unknown keys and bad values outright; a file edited by
//   hand (or from a newer version) is read leniently, keeping valid keys and defaulting the rest.
// - Atomic write: a temp file in the same directory, fsync'd, then renamed over settings.json, so a
//   crash mid-write never leaves a truncated file. Writes are serialised.
// - The directory is whatever main's userData is, so the PDFX_USER_DATA override applies (index.ts
//   sets it before anything else runs).
// - Nothing from a document is ever stored here (D8).

import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  defaultSettings,
  parseSettingsPatch,
  sanitizeSettings,
  type Settings
} from '../shared/settings'

export {
  BUNDLED_LANGUAGES,
  defaultLanguages,
  defaultSettings,
  parseSettingsPatch,
  sanitizeSettings,
  type Settings
} from '../shared/settings'

export const SETTINGS_FILE = 'settings.json'

export class SettingsStore {
  private cache: Settings | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly locale: string
  ) {}

  get path(): string {
    return join(this.dir, SETTINGS_FILE)
  }

  async get(): Promise<Settings> {
    if (!this.cache) {
      const defaults = defaultSettings(this.locale)
      let raw: unknown = null
      try {
        raw = JSON.parse(await readFile(this.path, 'utf8'))
      } catch {
        // Missing or corrupt: defaults. The next set() rewrites the file whole.
      }
      this.cache = sanitizeSettings(raw, defaults)
    }
    return { ...this.cache, 'ocr.languages': [...this.cache['ocr.languages']] }
  }

  /** Validate, merge and persist a patch; resolves with the full new settings. */
  set(patch: unknown): Promise<Settings> {
    const parsed = parseSettingsPatch(patch)
    const run = this.queue.then(async () => {
      const next = { ...(await this.get()), ...parsed }
      await this.write(next)
      this.cache = next
      return this.get()
    })
    this.queue = run.catch(() => {})
    return run
  }

  private async write(s: Settings): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = join(
      this.dir,
      `${SETTINGS_FILE}.${process.pid}.${Math.floor(Math.random() * 1e9).toString(36)}.tmp`
    )
    try {
      // Write, fsync, then rename: the rename is only ever of a complete, durable file.
      const fh = await open(tmp, 'wx', 0o600)
      try {
        await fh.writeFile(JSON.stringify(s, null, 2) + '\n', 'utf8')
        await fh.sync()
      } finally {
        await fh.close()
      }
      await rename(tmp, this.path)
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {})
      throw e
    }
  }
}
