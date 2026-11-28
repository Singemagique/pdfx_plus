// Language packs in main (PR9, DESIGN.md §3.2.5) with an injected fetch: the download's .part →
// verify → fsync → rename path and every way it can fail (hash mismatch, truncated, oversized,
// 407, timeouts, cancel, offline, HTTP errors, a mirror), the startup cleanup and check, the admin
// directory's hash rule, and Install from file… (gz, raw, re-compressed, unknown, too large).
//
// One test downloads Russian for real from the catalogue's host; it runs only with
// PDFX_OCR_NET_TEST=1 (never in CI).

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'

import { INSTALL_MAX_BYTES, type LangProgress } from '../../shared/ocr/lang-packs'
import {
  LangPacks,
  type FetchLike,
  type FetchResponseLike,
  type LangPacksOptions
} from './lang-packs'
import { LANG_CATALOGUE, type CatalogueLang } from './process/engine-manifest'

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

/** A synthetic language: deterministic "traineddata" bytes, their gzip, and a catalogue entry. */
function fakeLang(
  code: string,
  n = 50_000
): { raw: Uint8Array; gz: Uint8Array; entry: CatalogueLang } {
  const raw = new Uint8Array(n)
  let x = code.charCodeAt(0) * 7919
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    raw[i] = (x >>> 24) % 17 // compressible, not trivial
  }
  raw[0] = 0x17 // never a gzip magic
  const gz = new Uint8Array(gzipSync(raw, { level: 6 }))
  return {
    raw,
    gz,
    entry: {
      code,
      name: code.toUpperCase(),
      nativeName: code,
      script: 'Latn',
      bcp47: 'und',
      bytes: gz.length,
      sha256Gz: sha(gz),
      rawBytes: raw.length,
      sha256Raw: sha(raw),
      urls: [`https://data.example/${code}.traineddata.gz`]
    }
  }
}

const AAA = fakeLang('aaa')
const BBB = fakeLang('bbb', 30_000)

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'pdfx-langs-'))
  dirs.push(d)
  return d
}

/** A body that serves `chunks`, then (optionally) stalls forever. */
function body(chunks: Uint8Array[], stall = false): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) c.enqueue(chunks[i++])
      else if (!stall) c.close()
      else return new Promise<void>(() => {})
      return undefined
    }
  })
}

const split = (b: Uint8Array, n = 4): Uint8Array[] => {
  const out: Uint8Array[] = []
  const step = Math.ceil(b.length / n)
  for (let o = 0; o < b.length; o += step) out.push(b.slice(o, o + step))
  return out
}

const ok = (b: ReadableStream<Uint8Array>): FetchResponseLike => ({
  status: 200,
  ok: true,
  body: b
})

/** A fetch that rejects with the signal's abort, like net.fetch and undici. */
function abortable(signal: AbortSignal, p: Promise<FetchResponseLike>): Promise<FetchResponseLike> {
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    p.then(resolve, reject)
  })
}

function packs(
  fetch: FetchLike,
  more: Partial<LangPacksOptions> = {}
): {
  p: LangPacks
  dir: string
  installed: Array<Record<string, string>>
  progress: LangProgress[]
} {
  const root = tmp()
  const dir = join(root, 'ocr', 'tessdata', '4.0.0_best_int')
  const installed: Array<Record<string, string>> = []
  const progress: LangProgress[] = []
  const p = new LangPacks({
    dir,
    adminDir: null,
    fetch,
    catalogue: [AAA.entry, BBB.entry],
    mirrors: [],
    progressMs: 0,
    onInstalled: (x) => installed.push(x),
    onProgress: (x) => progress.push(x),
    ...more
  })
  return { p, dir, installed, progress }
}

const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : [])

/** Wait for a condition (no fixed sleeps: the suite also runs under full-parallel load). */
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise((res) => setTimeout(res, 5))
  }
}

describe('download', () => {
  it('streams to .part, verifies, renames, and reports the new path', async () => {
    const urls: string[] = []
    const { p, dir, installed, progress } = packs(async (url) => {
      urls.push(url)
      return ok(body(split(AAA.gz)))
    })
    expect(await p.download('aaa')).toEqual({ ok: true, code: 'aaa' })
    expect(urls).toEqual(['https://data.example/aaa.traineddata.gz'])
    expect(files(dir)).toEqual(['aaa.traineddata.gz'])
    expect(sha(readFileSync(join(dir, 'aaa.traineddata.gz')))).toBe(AAA.entry.sha256Gz)
    expect(p.paths()).toEqual({ aaa: join(dir, 'aaa.traineddata.gz') })
    expect(installed.at(-1)).toEqual({ aaa: join(dir, 'aaa.traineddata.gz') })
    expect(progress.at(-1)).toEqual({
      code: 'aaa',
      received: AAA.gz.length,
      total: AAA.gz.length,
      done: true
    })
    // Progress before the end is never marked done.
    expect(progress.slice(0, -1).every((x) => !x.done)).toBe(true)
    expect(p.list().find((l) => l.code === 'aaa')).toMatchObject({
      state: 'installed',
      host: 'data.example',
      bytes: AAA.gz.length
    })
    // Installed: a second download asks nothing.
    expect(await p.download('aaa')).toEqual({ ok: true, code: 'aaa' })
    expect(urls).toHaveLength(1)
  })

  it('a hash mismatch deletes the file and installs nothing', async () => {
    const bad = AAA.gz.slice()
    bad[100] ^= 0xff
    const { p, dir, installed } = packs(async () => ok(body(split(bad))))
    expect(await p.download('aaa')).toEqual({ ok: false, error: 'verify' })
    expect(files(dir)).toEqual([])
    expect(p.paths()).toEqual({})
    expect(installed).toEqual([])
  })

  it('a truncated body is refused and deleted', async () => {
    const { p, dir } = packs(async () => ok(body([AAA.gz.slice(0, AAA.gz.length - 10)])))
    expect(await p.download('aaa')).toEqual({ ok: false, error: 'verify' })
    expect(files(dir)).toEqual([])
  })

  it('more bytes than the catalogue says stops the download', async () => {
    const { p, dir } = packs(async () => ok(body([AAA.gz, new Uint8Array(1_000_000)], true)))
    expect(await p.download('aaa')).toEqual({ ok: false, error: 'verify' })
    expect(files(dir)).toEqual([])
  })

  it('HTTP 407 is a proxy sign-in, not offline', async () => {
    const { p, dir } = packs(async () => ({ status: 407, ok: false, body: null }))
    expect(await p.download('aaa')).toEqual({ ok: false, error: 'proxy-auth' })
    expect(files(dir)).toEqual([])
  })

  it('a proxy sign-in the login hook refused ends as proxy-auth', async () => {
    let fail!: (e: unknown) => void
    const { p } = packs((_url, { signal }) =>
      abortable(
        signal,
        new Promise((_, reject) => {
          fail = reject
        })
      )
    )
    const r = p.download('aaa')
    await until(() => p.isDownloadHost('https://data.example/x'))
    // What lang-host's app.on('login') does for a proxy challenge on our download.
    expect(p.isDownloadHost('https://data.example/aaa.traineddata.gz')).toBe(true)
    expect(p.proxyAuthRequested('https://data.example/aaa.traineddata.gz')).toBe(true)
    fail(new Error('net::ERR_FAILED'))
    expect(await r).toEqual({ ok: false, error: 'proxy-auth' })
    expect(p.proxyAuthRequested('https://elsewhere.example/x')).toBe(false)
  })

  it('no response within the connect timeout', async () => {
    const { p, dir } = packs((_url, { signal }) => abortable(signal, new Promise(() => {})), {
      connectTimeoutMs: 30
    })
    expect(await p.download('aaa')).toEqual({ ok: false, error: 'timeout' })
    expect(files(dir)).toEqual([])
  })

  it('a body that stops sending hits the idle timeout; the .part goes', async () => {
    const { p, dir } = packs(async () => ok(body([AAA.gz.slice(0, 1000)], true)), {
      idleTimeoutMs: 300
    })
    const r = p.download('aaa')
    // The first chunk was written to the .part, then nothing more arrives.
    await until(() => p.list().find((l) => l.code === 'aaa')?.received === 1000)
    expect(files(dir)).toEqual(['aaa.traineddata.gz.part'])
    expect(await r).toEqual({ ok: false, error: 'timeout' })
    expect(files(dir)).toEqual([])
  })

  it('cancel stops it and deletes the .part', async () => {
    const { p, dir } = packs(async () => ok(body([AAA.gz.slice(0, 1000)], true)))
    const r = p.download('aaa')
    // Joining: the same download.
    expect(p.download('aaa')).toBe(r)
    await until(() => p.list().find((l) => l.code === 'aaa')?.received === 1000)
    expect(p.list().find((l) => l.code === 'aaa')).toMatchObject({
      state: 'downloading',
      received: 1000
    })
    p.cancel('aaa')
    expect(await r).toEqual({ ok: false, error: 'cancelled' })
    expect(files(dir)).toEqual([])
    expect(p.list().find((l) => l.code === 'aaa')?.state).toBe('available')
  })

  it('no connection is offline; an error status is http', async () => {
    const off = packs(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await off.p.download('aaa')).toEqual({ ok: false, error: 'offline' })
    const net = packs(async () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED')
    })
    expect(await net.p.download('aaa')).toEqual({ ok: false, error: 'offline' })
    const http = packs(async () => ({ status: 404, ok: false, body: null }))
    expect(await http.p.download('aaa')).toEqual({ ok: false, error: 'http' })
  })

  it('tries the optional mirrors after the entry’s own host, with the same checks', async () => {
    const urls: string[] = []
    const { p } = packs(
      async (url) => {
        urls.push(url)
        if (url.includes('data.example')) return { status: 503, ok: false, body: null }
        return ok(body([BBB.gz]))
      },
      { mirrors: ['https://mirror.example/ocr-data-1/{code}.traineddata.gz'] }
    )
    expect(await p.download('bbb')).toEqual({ ok: true, code: 'bbb' })
    expect(urls).toEqual([
      'https://data.example/bbb.traineddata.gz',
      'https://mirror.example/ocr-data-1/bbb.traineddata.gz'
    ])
  })

  it('refuses a code that is not in the catalogue, without a request', async () => {
    let calls = 0
    const { p } = packs(async () => {
      calls++
      return ok(body([]))
    })
    expect(await p.download('ara')).toEqual({ ok: false, error: 'unknown-language' })
    expect(calls).toBe(0)
  })
})

describe('startup', () => {
  it('deletes stale .part files and keeps only installed files that match the catalogue', async () => {
    const { p, dir, installed } = packs(async () => ok(body([])))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'aaa.traineddata.gz.part'), AAA.gz.slice(0, 100))
    writeFileSync(join(dir, 'bbb.traineddata.gz.part'), 'x')
    writeFileSync(join(dir, 'aaa.traineddata.gz'), AAA.gz)
    const tampered = BBB.raw.slice()
    tampered[5] ^= 1
    writeFileSync(join(dir, 'bbb.traineddata'), tampered)
    await p.init()
    expect(files(dir)).toEqual(['aaa.traineddata.gz', 'bbb.traineddata'])
    expect(p.paths()).toEqual({ aaa: join(dir, 'aaa.traineddata.gz') })
    expect(installed).toEqual([{ aaa: join(dir, 'aaa.traineddata.gz') }])
  })

  it('admin-provisioned files obey the same hash rule', async () => {
    const admin = tmp()
    writeFileSync(join(admin, 'aaa.traineddata'), AAA.raw) // a matching raw file
    const bad = BBB.gz.slice()
    bad[50] ^= 1
    writeFileSync(join(admin, 'bbb.traineddata.gz'), bad) // tampered
    writeFileSync(join(admin, 'eng.traineddata.gz'), 'bundled, not ours to judge')
    const { p } = packs(async () => ok(body([])), { adminDir: admin })
    await p.init()
    expect(p.paths()).toEqual({ aaa: join(admin, 'aaa.traineddata') })
    expect(p.list().find((l) => l.code === 'bbb')?.state).toBe('available')
  })
})

describe('Install from file…', () => {
  const src = (name: string, bytes: Uint8Array | string): string => {
    const d = tmp()
    const f = join(d, name)
    writeFileSync(f, bytes)
    return f
  }

  it('installs a .gz whose bytes match a catalogue entry', async () => {
    const { p, dir, installed } = packs(async () => ok(body([])))
    expect(await p.installFile(src('anything.gz', AAA.gz))).toEqual({ ok: true, code: 'aaa' })
    expect(files(dir)).toEqual(['aaa.traineddata.gz'])
    expect(installed.at(-1)).toEqual({ aaa: join(dir, 'aaa.traineddata.gz') })
  })

  it('installs a raw .traineddata whose bytes match, kept raw', async () => {
    const { p, dir } = packs(async () => ok(body([])))
    expect(await p.installFile(src('bbb.traineddata', BBB.raw))).toEqual({ ok: true, code: 'bbb' })
    expect(files(dir)).toEqual(['bbb.traineddata'])
    expect(sha(readFileSync(join(dir, 'bbb.traineddata')))).toBe(BBB.entry.sha256Raw)
  })

  it('installs a re-compressed copy by its gunzipped bytes (stored raw)', async () => {
    const regz = new Uint8Array(gzipSync(AAA.raw, { level: 1 }))
    expect(sha(regz)).not.toBe(AAA.entry.sha256Gz)
    const { p, dir } = packs(async () => ok(body([])))
    expect(await p.installFile(src('aaa.traineddata.gz', regz))).toEqual({ ok: true, code: 'aaa' })
    expect(files(dir)).toEqual(['aaa.traineddata'])
    expect(sha(readFileSync(join(dir, 'aaa.traineddata')))).toBe(AAA.entry.sha256Raw)
  })

  it('refuses a file no catalogue entry matches, and writes nothing', async () => {
    const { p, dir } = packs(async () => ok(body([])))
    const other = AAA.raw.slice()
    other[10] ^= 1
    expect(await p.installFile(src('aaa.traineddata', other))).toEqual({
      ok: false,
      error: 'unknown-file'
    })
    expect(await p.installFile(src('x.gz', gzipSync(other)))).toEqual({
      ok: false,
      error: 'unknown-file'
    })
    expect(await p.installFile(src('junk.gz', 'not gzip at all'))).toEqual({
      ok: false,
      error: 'unknown-file'
    })
    expect(files(dir)).toEqual([])
  })

  it('refuses 100 MB or more without reading it, and other file types', async () => {
    const { p, dir } = packs(async () => ok(body([])))
    const big = src('huge.traineddata', '')
    truncateSync(big, INSTALL_MAX_BYTES)
    expect(await p.installFile(big)).toEqual({ ok: false, error: 'too-large' })
    expect(await p.installFile(src('aaa.zip', AAA.gz))).toEqual({ ok: false, error: 'wrong-type' })
    expect(await p.installFile(join(tmp(), 'gone.traineddata'))).toEqual({
      ok: false,
      error: 'unreadable'
    })
    expect(files(dir)).toEqual([])
  })

  it('one file per language: installing the other form replaces the first', async () => {
    const { p, dir } = packs(async () => ok(body([])))
    await p.installFile(src('a.traineddata', AAA.raw))
    await p.installFile(src('a.gz', AAA.gz))
    expect(files(dir)).toEqual(['aaa.traineddata.gz'])
  })
})

describe('the compiled catalogue', () => {
  it('serves every language from jsDelivr’s versioned npm URL', () => {
    for (const l of LANG_CATALOGUE)
      expect(l.urls).toEqual([
        `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${l.code}@1.0.0/4.0.0_best_int/${l.code}.traineddata.gz`
      ])
  })
})

// A real download from the catalogue's host (Node's fetch stands in for net.fetch; both are WHATWG
// fetch). Opt-in: PDFX_OCR_NET_TEST=1.
describe.runIf(process.env.PDFX_OCR_NET_TEST === '1')('real download (PDFX_OCR_NET_TEST=1)', () => {
  it('downloads Russian, verifies it and installs it', async () => {
    const rus = LANG_CATALOGUE.find((l) => l.code === 'rus')!
    const root = tmp()
    const dir = join(root, '4.0.0_best_int')
    const p = new LangPacks({
      dir,
      adminDir: null,
      fetch: (url, init) =>
        fetch(url, {
          signal: init.signal,
          headers: { 'user-agent': 'pdfx-test' }
        }) as Promise<FetchResponseLike>
    })
    const t0 = performance.now()
    const r = await p.download('rus')
    const ms = Math.round(performance.now() - t0)
    expect(r).toEqual({ ok: true, code: 'rus' })
    const got = readFileSync(join(dir, 'rus.traineddata.gz'))
    expect(got.length).toBe(rus.bytes)
    expect(sha(got)).toBe(rus.sha256Gz)
    console.log(`[measured] rus ${rus.bytes} B from ${new URL(rus.urls[0]).host} in ${ms} ms`)
  }, 120_000)
})
