import { beforeEach, describe, expect, it, vi } from 'vitest'

// A minimal stand-in for the hidden BrowserWindow markup.ts drives: it records every instance so a
// test can tell "reused the cached window" from "created a fresh one", and tracks destroy().
const h = vi.hoisted(() => {
  const cfg = { hangPrint: false }

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
        return Buffer.from('%PDF-fake')
      }
    }

    constructor() {
      windows.push(this)
    }

    loadURL = async (url: string): Promise<void> => {
      this.loadedUrls.push(url)
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
  return { cfg, windows, FakeWindow }
})

vi.mock('electron', () => ({
  BrowserWindow: h.FakeWindow,
  session: {
    fromPartition: () => ({
      webRequest: { onBeforeRequest: () => {}, onHeadersReceived: () => {} },
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
  markup = await import('./markup')
})

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
      const stuck = markup.markupToPdf('<p>hangs</p>')
      const rejected = expect(stuck).rejects.toThrow('markup render timed out')
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
})
