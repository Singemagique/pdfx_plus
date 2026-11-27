import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type BeforeRequest = (details: { url: string }, cb: (r: { cancel: boolean }) => void) => void

// A minimal stand-in for the hidden BrowserWindow markup.ts drives: it records every instance so a
// test can tell "reused the cached window" from "created a fresh one", and tracks destroy().
const h = vi.hoisted(() => {
  const cfg = {
    hangPrint: false,
    failPrint: false,
    // Called on every loadURL, while the render that issued it is still in flight.
    onLoad: null as ((url: string) => void) | null
  }
  const session = { onBeforeRequest: null as BeforeRequest | null }

  class FakeWindow {
    destroyed = false
    loadedUrls: string[] = []
    private closedHandlers: Array<() => void> = []

    webContents = {
      on: (): void => {},
      setWindowOpenHandler: (): void => {},
      executeJavaScript: async (): Promise<boolean> => true,
      printToPDF: async (): Promise<Buffer> => {
        // Simulate a render that never returns (the case RENDER_TIMEOUT_MS exists for).
        if (cfg.hangPrint) await new Promise<never>(() => {})
        if (cfg.failPrint) throw new Error('print failed')
        return Buffer.from('%PDF-fake')
      }
    }

    constructor() {
      windows.push(this)
    }

    loadURL = async (url: string): Promise<void> => {
      this.loadedUrls.push(url)
      cfg.onLoad?.(url)
    }

    on(event: string, handler: () => void): void {
      if (event === 'closed') this.closedHandlers.push(handler)
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    destroy(): void {
      if (this.destroyed) return
      this.destroyed = true
      for (const handler of this.closedHandlers) handler()
    }
  }

  const windows: FakeWindow[] = []
  return { cfg, session, windows, FakeWindow }
})

vi.mock('electron', () => ({
  BrowserWindow: h.FakeWindow,
  session: {
    fromPartition: () => ({
      webRequest: {
        onBeforeRequest: (fn: BeforeRequest) => {
          h.session.onBeforeRequest = fn
        },
        onHeadersReceived: () => {}
      },
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => {}
    })
  }
}))

// markup.ts caches its window in module state; reload it per test for a clean slate.
let markup: typeof import('./markup')

beforeEach(async () => {
  vi.resetModules()
  h.windows.length = 0
  h.cfg.hangPrint = false
  h.cfg.failPrint = false
  h.cfg.onLoad = null
  h.session.onBeforeRequest = null
  markup = await import('./markup')
})

/** The document URL a render loaded (its first loadURL; the second is the blank reset page). */
function docUrl(winIndex = 0, loadIndex = 0): string {
  return h.windows[winIndex].loadedUrls[loadIndex]
}

/**
 * Resolves once a render loads its document. The temp file is written with real async fs before the
 * load (and the timeout timer starts right after it), so fake-timer tests must wait for this before
 * advancing the clock, or they advance past a timer that does not exist yet.
 */
function nextDocLoad(): Promise<void> {
  return new Promise((resolve) => {
    h.cfg.onLoad = () => resolve()
  })
}

/** Ask the render session's onBeforeRequest whether it would let `url` through. */
function sessionAllows(url: string): boolean {
  const handler = h.session.onBeforeRequest
  if (!handler) throw new Error('render session was never hardened')
  let cancel: boolean | undefined
  handler({ url }, (r) => {
    cancel = r.cancel
  })
  return cancel === false
}

describe('markupToPdf window lifecycle', () => {
  it('renders through a single cached hidden window', async () => {
    const pdf = await markup.markupToPdf('<p>a</p>')
    await markup.markupToPdf('<p>b</p>')
    expect(new TextDecoder().decode(pdf)).toBe('%PDF-fake')
    expect(h.windows).toHaveLength(1)
  })

  it('destroyRenderWindow destroys the cached window and a later render re-creates it', async () => {
    await markup.markupToPdf('<p>a</p>')
    expect(h.windows).toHaveLength(1)

    // Electron counts the hidden window, so it must die with the main window or window-all-closed
    // never fires (and the macOS dock activate check sees a non-empty window list).
    markup.destroyRenderWindow()
    expect(h.windows[0].destroyed).toBe(true)
    // Safe to call again when there is nothing cached / already destroyed.
    expect(() => markup.destroyRenderWindow()).not.toThrow()

    const pdf = await markup.markupToPdf('<p>b</p>')
    expect(h.windows).toHaveLength(2)
    expect(h.windows[1].destroyed).toBe(false)
    expect(new TextDecoder().decode(pdf)).toBe('%PDF-fake')
  })
})

describe('markupToPdf render timeout', () => {
  it('discards the stuck window so the next job does not race it', async () => {
    vi.useFakeTimers()
    try {
      h.cfg.hangPrint = true
      const loaded = nextDocLoad()
      const stuck = markup.markupToPdf('<p>hangs</p>')
      const rejected = expect(stuck).rejects.toThrow('markup render timed out')
      await loaded
      await vi.advanceTimersByTimeAsync(10_000)
      await rejected

      // The timed-out render still owns the shared window, so it must be gone before the chain
      // advances — otherwise the next job drives a window another render is still using.
      expect(h.windows).toHaveLength(1)
      expect(h.windows[0].destroyed).toBe(true)

      h.cfg.hangPrint = false
      const pdf = await markup.markupToPdf('<p>next</p>')
      expect(h.windows).toHaveLength(2)
      expect(new TextDecoder().decode(pdf)).toBe('%PDF-fake')
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the window alone once a render has completed', async () => {
    vi.useFakeTimers()
    try {
      await markup.markupToPdf('<p>quick</p>')
      // The timeout timer must be cleared on success; otherwise it fires later and destroys a
      // window a subsequent render is happily using.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(h.windows).toHaveLength(1)
      expect(h.windows[0].destroyed).toBe(false)

      await markup.markupToPdf('<p>later</p>')
      expect(h.windows).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('deletes the temp document even when the render times out', async () => {
    vi.useFakeTimers()
    try {
      h.cfg.hangPrint = true
      const loaded = nextDocLoad()
      const stuck = markup.markupToPdf('<p>hangs</p>')
      const rejected = expect(stuck).rejects.toThrow('markup render timed out')
      await loaded
      await vi.advanceTimersByTimeAsync(10_000)
      await rejected

      const file = fileURLToPath(docUrl())
      expect(existsSync(file)).toBe(false)
      expect(existsSync(path.dirname(file))).toBe(false)
      // ...and the hung render's document is no longer loadable through the session.
      expect(sessionAllows(docUrl())).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('markupToPdf temp document', () => {
  it('loads a large document from a file, not a data: URL Chromium would reject', async () => {
    // ~2 MiB of HTML — an inlined photo. As a base64 data: URL this is ~2.8 MB, past Chromium's
    // URL length limit, and loadURL failed with ERR_INVALID_URL (measured in Electron 38).
    const html =
      '<!doctype html><img src="data:image/jpeg;base64,' + 'A'.repeat(2 * 1024 * 1024) + '">'
    let onDisk: string | null = null
    h.cfg.onLoad = (url) => {
      if (url.startsWith('file:')) onDisk = readFileSync(fileURLToPath(url), 'utf8')
    }

    const pdf = await markup.markupToPdf(html)

    expect(new TextDecoder().decode(pdf)).toBe('%PDF-fake')
    expect(docUrl().startsWith('file:')).toBe(true)
    expect(h.windows[0].loadedUrls.every((u) => u.length < 1024)).toBe(true)
    expect(onDisk).toBe('﻿' + html) // the document, behind the UTF-8 BOM
  })

  it('forces UTF-8 decoding with a BOM, since a file: load carries no charset', async () => {
    // No <meta charset>: without the BOM Chromium sniffs/falls back and renders mojibake.
    const html = '<p>héllo — ü 中</p>'
    let raw: Buffer | null = null
    h.cfg.onLoad = (url) => {
      if (url.startsWith('file:')) raw = readFileSync(fileURLToPath(url))
    }
    await markup.markupToPdf(html)

    expect(raw).not.toBeNull()
    expect([...raw!.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]) // the UTF-8 BOM, first
    expect(raw!.subarray(3).toString('utf8')).toBe(html) // then the document, UTF-8 encoded
  })

  it('writes the document under the OS temp dir and deletes it after the render', async () => {
    let existedDuringLoad = false
    h.cfg.onLoad = (url) => {
      if (url.startsWith('file:')) existedDuringLoad = existsSync(fileURLToPath(url))
    }
    await markup.markupToPdf('<p>hello</p>')

    const file = fileURLToPath(docUrl())
    expect(existedDuringLoad).toBe(true)
    expect(path.relative(tmpdir(), file).startsWith('..')).toBe(false)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(path.dirname(file))).toBe(false)
  })

  it('deletes the temp document when the render fails', async () => {
    h.cfg.failPrint = true
    await expect(markup.markupToPdf('<p>broken</p>')).rejects.toThrow('print failed')

    const file = fileURLToPath(docUrl())
    expect(existsSync(file)).toBe(false)
    expect(existsSync(path.dirname(file))).toBe(false)

    // The failure must not wedge the chain.
    h.cfg.failPrint = false
    await expect(markup.markupToPdf('<p>ok</p>')).resolves.toBeInstanceOf(Uint8Array)
  })

  it('gives each render its own private directory', async () => {
    await markup.markupToPdf('<p>a</p>')
    await markup.markupToPdf('<p>b</p>')
    const first = fileURLToPath(docUrl(0, 0))
    const second = fileURLToPath(docUrl(0, 2))
    expect(path.dirname(first)).not.toBe(path.dirname(second))
  })
})

describe('markup render session allowlist', () => {
  it('lets through exactly the in-flight document and data: URLs, and nothing else', async () => {
    const seen: Record<string, boolean> = {}
    h.cfg.onLoad = (url) => {
      if (!url.startsWith('file:')) return
      const dir = path.dirname(fileURLToPath(url))
      seen.doc = sessionAllows(url)
      seen.data = sessionAllows('data:image/png;base64,AAAA')
      seen.sibling = sessionAllows(pathToFileURL(path.join(dir, 'evil.png')).href)
      seen.parent = sessionAllows(pathToFileURL(path.join(dir, '..', 'secret.txt')).href)
      seen.query = sessionAllows(url + '?x=1')
      seen.https = sessionAllows('https://example.com/track.png')
      seen.http = sessionAllows('http://127.0.0.1:8080/')
    }
    await markup.markupToPdf('<p>x</p>')

    expect(seen).toEqual({
      doc: true,
      data: true,
      sibling: false,
      parent: false,
      query: false,
      https: false,
      http: false
    })
    // Once the render is over, the document URL is no longer allowed either.
    expect(sessionAllows(docUrl())).toBe(false)
    expect(sessionAllows('data:text/html,')).toBe(true)
  })
})

describe('isAllowedRenderRequest', () => {
  const doc = path.join(tmpdir(), 'pdfx-markup-AB~1 é', 'document.html')
  const href = pathToFileURL(doc).href

  it('matches the document whatever way its URL is canonicalised', () => {
    // Chromium percent-encodes '~' (Windows 8.3 short names like ABCDEF~1), and whether
    // pathToFileURL does depends on the Node version; percent-hex case and drive-letter case can
    // differ too. A string compare would block the very document being rendered.
    const tilde = href.replaceAll('%7E', '~')
    const encoded = tilde.replaceAll('~', '%7E')
    expect(tilde).not.toBe(encoded)
    expect(markup.isAllowedRenderRequest(tilde, doc)).toBe(true)
    expect(markup.isAllowedRenderRequest(encoded, doc)).toBe(true)
    expect(markup.isAllowedRenderRequest(encoded.replaceAll('%7E', '%7e'), doc)).toBe(true)
  })

  it('blocks every file: URL when no render is in flight', () => {
    expect(markup.isAllowedRenderRequest(href, null)).toBe(false)
    expect(markup.isAllowedRenderRequest('data:text/html,', null)).toBe(true)
  })

  it('refuses malformed, remote-host and encoded-separator file URLs', () => {
    expect(markup.isAllowedRenderRequest('file://', doc)).toBe(false)
    expect(markup.isAllowedRenderRequest('file:///%2Fetc%2Fpasswd', doc)).toBe(false)
    expect(markup.isAllowedRenderRequest('file://evil.example/share/document.html', doc)).toBe(
      false
    )
    expect(markup.isAllowedRenderRequest(href + '#frag', doc)).toBe(true)
    expect(markup.isAllowedRenderRequest('blob:file:///x', doc)).toBe(false)
    expect(markup.isAllowedRenderRequest('javascript:alert(1)', doc)).toBe(false)
  })
})
