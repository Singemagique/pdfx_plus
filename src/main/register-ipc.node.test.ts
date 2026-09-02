// register-ipc is where every renderer-facing guard lives: path/size validation on the write and
// signing routes, the PKCS#11 module-path check, the thumbprint format check and the input caps.
// The handlers are only reachable through ipcMain, so this suite captures them at registration and
// calls them directly. Each case is written so that DELETING its guard turns the test red.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const h = vi.hoisted(() => {
  const handlers = new Map<string, Handler>()
  const send = vi.fn()
  const window = {
    webContents: { send },
    isDestroyed: (): boolean => false
  }
  return {
    handlers,
    send,
    window,
    /** Swapped per test so the "no window" branches can be exercised too. */
    mainWindow: { current: null as unknown },
    showMessageBox: vi.fn(async () => ({ response: 1 })),
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
    showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: '' }))
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler): void => {
      h.handlers.set(channel, handler)
    }
  },
  dialog: {
    showMessageBox: h.showMessageBox,
    showOpenDialog: h.showOpenDialog,
    showSaveDialog: h.showSaveDialog
  },
  clipboard: {
    readImage: vi.fn(() => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) })),
    clear: vi.fn()
  }
}))

// Real fs for the reads (the open-files case needs a genuinely unreadable path), but writeFile is
// a spy: a guard that let a bad write through must be caught by an assertion, not by a stray file.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return { ...actual, stat: vi.fn(actual.stat), writeFile: vi.fn(async () => {}) }
})

vi.mock('./sign', () => ({
  signPdf: vi.fn(async () => new Uint8Array([1])),
  signPdfWithCard: vi.fn(async () => new Uint8Array([2])),
  signPdfWithWindowsCert: vi.fn(async () => new Uint8Array([3]))
}))
vi.mock('./pkcs11', () => ({
  listTokens: vi.fn(() => []),
  findModules: vi.fn(() => []),
  cardCertDer: vi.fn(() => null)
}))
vi.mock('./markup', () => ({ markupToPdf: vi.fn(async () => new Uint8Array([4])) }))
vi.mock('./windows-cert', () => ({ listWindowsCerts: vi.fn(async () => []) }))
vi.mock('./cert-info', () => ({
  certInfoFromDer: vi.fn(() => null),
  certInfoFromP12: vi.fn(() => null)
}))
vi.mock('./clipboard', () => ({ clipboardFilePaths: vi.fn(() => [] as string[]) }))
vi.mock('./window', () => ({
  getMainWindow: vi.fn(() => h.mainWindow.current),
  setRendererReady: vi.fn(),
  sendOpenPaths: vi.fn(async () => {})
}))

import { stat, writeFile } from 'fs/promises'
import { signPdf, signPdfWithCard, signPdfWithWindowsCert } from './sign'
import { cardCertDer, listTokens } from './pkcs11'
import { markupToPdf } from './markup'
import { certInfoFromP12 } from './cert-info'
import { clipboardFilePaths } from './clipboard'
import { sendOpenPaths, setRendererReady } from './window'
import { MAX_DROP_FILES } from './file-intake'
import { registerIpc } from './register-ipc'

/** A typed array whose reported byteLength is a lie — the only way to reach the size guards. */
const oversized = (byteLength: number): Uint8Array => {
  const view = new Uint8Array(8)
  Object.defineProperty(view, 'byteLength', { value: byteLength, configurable: true })
  return view
}

const invoke = (channel: string, ...args: unknown[]): unknown => {
  const handler = h.handlers.get(channel)
  if (!handler) throw new Error(`no handler registered for ${channel}`)
  return handler({}, ...args)
}

const ABS = process.platform === 'win32' ? 'C:\\tmp\\out.pdf' : '/tmp/out.pdf'
const MODULE = process.platform === 'win32' ? 'C:\\pkcs11\\opensc.dll' : '/usr/lib/opensc.so'
let pending: string[] = ['/pending/a.pdf']

beforeAll(() => {
  registerIpc(
    () => pending,
    () => {
      pending = []
    }
  )
})

beforeEach(() => {
  vi.clearAllMocks()
  h.mainWindow.current = h.window
})

describe('registration', () => {
  it('registers every channel the preload bridge invokes', () => {
    for (const channel of [
      'pdfx:renderer-ready',
      'pdfx:choose-save-path',
      'pdfx:confirm-integrity',
      'pdfx:read-clipboard-image',
      'pdfx:read-clipboard-files',
      'pdfx:clipboard-clear',
      'pdfx:expand-drop-paths',
      'pdfx:read-resource',
      'pdfx:markup-to-pdf',
      'pdfx:write-file',
      'pdfx:sign-pdf',
      'pdfx:p12-cert-info',
      'pdfx:pkcs11-find-modules',
      'pdfx:pkcs11-list-tokens',
      'pdfx:card-cert-info',
      'pdfx:sign-pdf-card',
      'pdfx:win-cert-list',
      'pdfx:sign-pdf-win-cert',
      'pdfx:open-files'
    ]) {
      expect(h.handlers.has(channel)).toBe(true)
    }
  })

  it('drains the pending open paths when the renderer reports ready', async () => {
    await invoke('pdfx:renderer-ready')
    expect(vi.mocked(setRendererReady)).toHaveBeenCalledWith(true)
    expect(vi.mocked(sendOpenPaths)).toHaveBeenCalledWith(['/pending/a.pdf'])
    expect(pending).toEqual([])
  })
})

describe('pdfx:write-file', () => {
  it('writes an absolute path and answers with the basename', async () => {
    await expect(invoke('pdfx:write-file', ABS, new Uint8Array([1, 2]))).resolves.toBe('out.pdf')
    expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(1)
  })

  it('refuses a relative path', async () => {
    await expect(invoke('pdfx:write-file', 'out.pdf', new Uint8Array([1]))).rejects.toThrow(
      /invalid path/
    )
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled()
  })

  it('refuses a null-byte truncation path', async () => {
    await expect(invoke('pdfx:write-file', `${ABS}\0.txt`, new Uint8Array([1]))).rejects.toThrow(
      /invalid path/
    )
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled()
  })

  it('refuses an empty or non-string path', async () => {
    await expect(invoke('pdfx:write-file', '', new Uint8Array([1]))).rejects.toThrow(/invalid path/)
    await expect(invoke('pdfx:write-file', 42, new Uint8Array([1]))).rejects.toThrow(/invalid path/)
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled()
  })

  it('refuses a payload that is not a typed array', async () => {
    await expect(invoke('pdfx:write-file', ABS, 'not bytes')).rejects.toThrow(/invalid payload/)
    await expect(invoke('pdfx:write-file', ABS, { length: 2 })).rejects.toThrow(/invalid payload/)
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled()
  })

  it('refuses a payload over the 1 GiB cap', async () => {
    await expect(invoke('pdfx:write-file', ABS, oversized(1024 * 1024 * 1024 + 1))).rejects.toThrow(
      /invalid payload/
    )
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled()
  })
})

describe('pdfx:sign-pdf', () => {
  const pdf = new Uint8Array([1])
  const p12 = new Uint8Array([2])

  it('refuses payloads that are not typed arrays', async () => {
    await expect(invoke('pdfx:sign-pdf', 'pdf', p12, {})).rejects.toThrow(/invalid payload/)
    await expect(invoke('pdfx:sign-pdf', pdf, null, {})).rejects.toThrow(/invalid payload/)
    expect(vi.mocked(signPdf)).not.toHaveBeenCalled()
  })

  it('refuses a PKCS#12 over 4 MiB', async () => {
    await expect(invoke('pdfx:sign-pdf', pdf, oversized(4 * 1024 * 1024 + 1), {})).rejects.toThrow(
      /too large/
    )
    expect(vi.mocked(signPdf)).not.toHaveBeenCalled()
  })

  it('refuses a PDF over the 1 GiB cap', async () => {
    await expect(
      invoke('pdfx:sign-pdf', oversized(1024 * 1024 * 1024 + 1), p12, {})
    ).rejects.toThrow(/too large/)
    expect(vi.mocked(signPdf)).not.toHaveBeenCalled()
  })

  it('coerces the options it forwards to the signer', async () => {
    await invoke('pdfx:sign-pdf', pdf, p12, { passphrase: 7, reason: 9, ltv: 'yes' })
    expect(vi.mocked(signPdf)).toHaveBeenCalledWith(pdf, p12, {
      passphrase: '7',
      reason: '9',
      name: undefined,
      location: undefined,
      tsaUrl: undefined,
      ltv: false
    })
  })
})

describe('pdfx:p12-cert-info', () => {
  it('refuses a non-view or oversized PKCS#12', async () => {
    await expect(invoke('pdfx:p12-cert-info', 'p12', '')).rejects.toThrow(/invalid payload/)
    await expect(invoke('pdfx:p12-cert-info', oversized(4 * 1024 * 1024 + 1), '')).rejects.toThrow(
      /invalid payload/
    )
    expect(vi.mocked(certInfoFromP12)).not.toHaveBeenCalled()
  })

  it('coerces a missing passphrase to an empty string', async () => {
    const p12 = new Uint8Array([1])
    await invoke('pdfx:p12-cert-info', p12, undefined)
    expect(vi.mocked(certInfoFromP12)).toHaveBeenCalledWith(p12, '')
  })
})

describe('pdfx:confirm-integrity', () => {
  it('clamps the renderer-supplied detail to 2000 characters', async () => {
    await invoke('pdfx:confirm-integrity', 'x'.repeat(5000))
    const [, options] = vi.mocked(h.showMessageBox).mock.calls[0] as unknown as [
      unknown,
      { detail: string; buttons: string[] }
    ]
    expect(options.detail.startsWith('x'.repeat(2000))).toBe(true)
    expect(options.detail.startsWith('x'.repeat(2001))).toBe(false)
    expect(options.buttons).toHaveLength(3)
  })

  it('returns the button the user chose', async () => {
    await expect(invoke('pdfx:confirm-integrity', 'short')).resolves.toBe(1)
  })

  it('answers "open without edits" when there is no window to ask in', async () => {
    h.mainWindow.current = null
    await expect(invoke('pdfx:confirm-integrity', 'short')).resolves.toBe(0)
    expect(vi.mocked(h.showMessageBox)).not.toHaveBeenCalled()
  })
})

describe('pdfx:sign-pdf-win-cert', () => {
  const pdf = new Uint8Array([1])

  it('refuses a thumbprint that is not 40 hex characters', async () => {
    for (const bad of ['', 'abc', 'z'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 1234]) {
      await expect(invoke('pdfx:sign-pdf-win-cert', pdf, bad, {})).rejects.toThrow(/thumbprint/)
    }
    expect(vi.mocked(signPdfWithWindowsCert)).not.toHaveBeenCalled()
  })

  it('accepts a well-formed thumbprint', async () => {
    const thumbprint = 'AbCdEf0123456789abcdef0123456789ABCDEF01'
    await invoke('pdfx:sign-pdf-win-cert', pdf, thumbprint, { tsaUrl: '' })
    expect(vi.mocked(signPdfWithWindowsCert)).toHaveBeenCalledWith(
      pdf,
      thumbprint,
      expect.objectContaining({ tsaUrl: undefined, ltv: false })
    )
  })

  it('refuses a payload that is not a typed array', async () => {
    await expect(invoke('pdfx:sign-pdf-win-cert', 'pdf', 'a'.repeat(40), {})).rejects.toThrow(
      /invalid payload/
    )
    expect(vi.mocked(signPdfWithWindowsCert)).not.toHaveBeenCalled()
  })
})

describe('PKCS#11 module path', () => {
  it('refuses a relative, empty, null-byte or non-library module path', async () => {
    for (const bad of ['opensc.so', '', `${MODULE}\0.txt`, 42]) {
      await expect(invoke('pdfx:pkcs11-list-tokens', bad)).rejects.toThrow(/absolute PKCS#11/)
    }
    const wrongExt = process.platform === 'win32' ? 'C:\\pkcs11\\evil.exe' : '/usr/lib/evil.txt'
    await expect(invoke('pdfx:pkcs11-list-tokens', wrongExt)).rejects.toThrow(
      /\.dll, \.so or \.dylib/
    )
    expect(vi.mocked(listTokens)).not.toHaveBeenCalled()
  })

  it('loads a valid absolute native module path', async () => {
    await invoke('pdfx:pkcs11-list-tokens', MODULE)
    expect(vi.mocked(listTokens)).toHaveBeenCalledWith(MODULE)
  })

  it('is enforced on the card routes too', async () => {
    await expect(invoke('pdfx:card-cert-info', { modulePath: 'opensc.so' })).rejects.toThrow(
      /absolute PKCS#11/
    )
    await expect(
      invoke('pdfx:sign-pdf-card', new Uint8Array([1]), { modulePath: 'opensc.so' }, {})
    ).rejects.toThrow(/absolute PKCS#11/)
    expect(vi.mocked(cardCertDer)).not.toHaveBeenCalled()
    expect(vi.mocked(signPdfWithCard)).not.toHaveBeenCalled()
  })
})

describe('smart-card slot coercion', () => {
  it('drops a slot that is not a non-negative 32-bit integer', async () => {
    for (const bad of ['3', -1, 1.5, Number.NaN, 0x1_0000_0000, null]) {
      vi.mocked(cardCertDer).mockClear()
      await invoke('pdfx:card-cert-info', { modulePath: MODULE, slot: bad })
      expect(vi.mocked(cardCertDer).mock.calls[0][0].slot).toBeUndefined()
    }
  })

  it('keeps a valid slot', async () => {
    await invoke('pdfx:card-cert-info', { modulePath: MODULE, slot: 3, tokenLabel: 7 })
    expect(vi.mocked(cardCertDer).mock.calls[0][0]).toMatchObject({
      slot: 3,
      pin: '',
      tokenLabel: '7'
    })
  })

  it('drops a bad slot on the signing route as well', async () => {
    await invoke('pdfx:sign-pdf-card', new Uint8Array([1]), { modulePath: MODULE, slot: '3' }, {})
    expect(vi.mocked(signPdfWithCard).mock.calls[0][1].slot).toBeUndefined()
    expect(vi.mocked(signPdfWithCard).mock.calls[0][1].pin).toBe('')
  })

  it('refuses a PDF payload that is not a typed array', async () => {
    await expect(invoke('pdfx:sign-pdf-card', 'pdf', { modulePath: MODULE }, {})).rejects.toThrow(
      /invalid payload/
    )
    expect(vi.mocked(signPdfWithCard)).not.toHaveBeenCalled()
  })
})

describe('pdfx:markup-to-pdf', () => {
  // This handler is synchronous, so the guard throws rather than rejecting (ipcMain turns that into
  // a rejection on the renderer side either way).
  it('refuses HTML that is not a string', () => {
    expect(() => invoke('pdfx:markup-to-pdf', { toString: () => 'x' })).toThrow(/too large/)
    expect(vi.mocked(markupToPdf)).not.toHaveBeenCalled()
  })

  it('refuses HTML over 64 MiB', () => {
    expect(() => invoke('pdfx:markup-to-pdf', 'a'.repeat(64 * 1024 * 1024 + 1))).toThrow(
      /too large/
    )
    expect(vi.mocked(markupToPdf)).not.toHaveBeenCalled()
  })

  it('coerces a non-numeric or non-positive fit height to undefined', async () => {
    for (const bad of ['tall', {}, 0, -5, Number.POSITIVE_INFINITY, null]) {
      vi.mocked(markupToPdf).mockClear()
      await invoke('pdfx:markup-to-pdf', '<p>hi</p>', bad)
      expect(vi.mocked(markupToPdf)).toHaveBeenCalledWith('<p>hi</p>', undefined)
    }
  })

  it('passes a real height through as a number', async () => {
    await invoke('pdfx:markup-to-pdf', '<p>hi</p>', '720')
    expect(vi.mocked(markupToPdf)).toHaveBeenCalledWith('<p>hi</p>', 720)
  })
})

describe('pdfx:expand-drop-paths', () => {
  let dir: string
  let good: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pdfx-ipc-drop-'))
    good = join(dir, 'good.pdf')
    writeFileSync(good, '%PDF-1.7\n')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns nothing for a payload that is not an array', async () => {
    for (const bad of ['/x/a.pdf', null, undefined, { 0: '/x/a.pdf', length: 1 }]) {
      await expect(invoke('pdfx:expand-drop-paths', bad)).resolves.toEqual([])
    }
    // Without the Array.isArray gate this would have thrown (or, for the array-like, walked it) —
    // either way the filesystem must never be touched.
    expect(vi.mocked(stat)).not.toHaveBeenCalled()
  })

  it('never lets a non-string entry reach the filesystem', async () => {
    const files = (await invoke('pdfx:expand-drop-paths', [1, null, {}, good])) as Array<{
      path?: string
    }>
    expect(files.map((f) => f.path)).toEqual([good])
    for (const call of vi.mocked(stat).mock.calls) expect(String(call[0])).toBe(good)
  })

  it('caps the requested list before expanding it', async () => {
    const passthrough = vi.mocked(stat).getMockImplementation()
    vi.mocked(stat).mockRejectedValue(new Error('nope'))
    const many = Array.from({ length: MAX_DROP_FILES + 3 }, (_, i) => `/drop/f${i}.pdf`)

    await expect(invoke('pdfx:expand-drop-paths', many)).resolves.toEqual([])

    // expandDropPaths only bounds its OUTPUT, so without the input slice a huge list would still
    // drive one stat() per entry.
    expect(vi.mocked(stat).mock.calls.length).toBe(MAX_DROP_FILES)
    if (passthrough) vi.mocked(stat).mockImplementation(passthrough)
  })
})

// The silent-skip fix: routes that hand files to the renderer must say what they could not read.
describe('unreadable files raise a notice', () => {
  let dir: string
  let good: string
  let missing: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pdfx-ipc-open-'))
    good = join(dir, 'good.pdf')
    missing = join(dir, 'gone.pdf')
    writeFileSync(good, '%PDF-1.7\n')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('tells the renderer which of the opened files could not be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(h.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [good, missing] })

    const files = (await invoke('pdfx:open-files')) as Array<{ path?: string }>

    expect(files.map((f) => f.path)).toEqual([good])
    expect(h.send).toHaveBeenCalledWith('pdfx:notice', 'Could not read 1 file: gone.pdf')
    warn.mockRestore()
  })

  it('stays quiet when every file read', async () => {
    vi.mocked(h.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [good] })
    await invoke('pdfx:open-files')
    expect(h.send).not.toHaveBeenCalled()
  })

  it('also covers the clipboard route', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(clipboardFilePaths).mockReturnValue([good, missing])

    const files = (await invoke('pdfx:read-clipboard-files')) as Array<{ path?: string }>

    expect(files.map((f) => f.path)).toEqual([good])
    expect(h.send).toHaveBeenCalledWith('pdfx:notice', 'Could not read 1 file: gone.pdf')
    warn.mockRestore()
  })

  it('does not try to notify when the window is gone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.mainWindow.current = null
    vi.mocked(clipboardFilePaths).mockReturnValue([missing])

    await expect(invoke('pdfx:read-clipboard-files')).resolves.toEqual([])

    expect(h.send).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
