// The port protocol validators (DESIGN.md §3.3.1): every message shape the coordinator accepts from
// the renderer and from main, and everything main accepts from the utility process. Each "rejects"
// case below is one a compromised or buggy peer could send.

import { describe, expect, it } from 'vitest'

import {
  OcrError,
  parseFromOcr,
  parseMainToOcr,
  parseOcrToMain,
  parseToOcr,
  type ToOcr
} from './protocol'

const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])
const page = { index: 0, userUnit: 1, width: 612, height: 792 }
const recognize = {
  recognize: { jobId: 'j1', src: 's1', pages: [page], opts: { langs: ['eng'] } }
}

function rejects(fn: () => unknown, match?: RegExp): void {
  let err: unknown
  try {
    fn()
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(OcrError)
  expect((err as OcrError).code).toBe('bad-message')
  if (match) expect((err as OcrError).message).toMatch(match)
}

describe('parseToOcr (renderer → coordinator)', () => {
  it('accepts every well-formed message', () => {
    const good: ToOcr[] = [
      { open: { src: 's1', bytes } },
      { triage: { src: 's1' } },
      { triage: { src: 's1', pages: [0, 3] } },
      recognize as ToOcr,
      {
        recognize: {
          jobId: 'job_2',
          src: 'src-9',
          pages: [page, { index: 4, userUnit: 1, width: 595.5, height: 842.25 }],
          opts: { langs: ['eng', 'deu', 'chi_sim'], renderDpi: 300 }
        }
      },
      { cancel: 'j1' },
      { close: 's1' },
      { focus: { src: 's1', index: 2 } }
    ]
    for (const m of good) expect(parseToOcr(m)).toEqual(m)
  })

  it('keeps the bytes as the same view (no copy in the validator)', () => {
    const m = parseToOcr({ open: { src: 's1', bytes } }) as { open: { bytes: Uint8Array } }
    expect(m.open.bytes).toBe(bytes)
  })

  it('rejects unknown messages and unknown keys at every level', () => {
    rejects(() => parseToOcr({ openFile: { src: 's1' } }), /unknown message/)
    rejects(() => parseToOcr({ open: { src: 's1', bytes, path: '/etc/passwd' } }), /unknown key/)
    rejects(() => parseToOcr({ ...recognize, extra: 1 }), /exactly one key/)
    rejects(() => parseToOcr({ recognize: { ...recognize.recognize, priority: 1 } }), /unknown key/)
    rejects(
      () => parseToOcr({ recognize: { ...recognize.recognize, pages: [{ ...page, rotate: 90 }] } }),
      /unknown key/
    )
    rejects(
      () =>
        parseToOcr({
          recognize: { ...recognize.recognize, opts: { langs: ['eng'], tessdata: '/x' } }
        }),
      /unknown key/
    )
  })

  it('never accepts a file path, in any string field', () => {
    const paths = [
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      '..\\..\\x',
      '../x',
      'file:///x',
      '\\\\server\\share',
      'a.pdf',
      'x\0y'
    ]
    for (const p of paths) {
      rejects(() => parseToOcr({ open: { src: p, bytes } }))
      rejects(() => parseToOcr({ close: p }))
      rejects(() => parseToOcr({ cancel: p }))
      rejects(() => parseToOcr({ recognize: { ...recognize.recognize, jobId: p } }))
      rejects(() => parseToOcr({ recognize: { ...recognize.recognize, opts: { langs: [p] } } }))
    }
    // A path where the bytes belong is not bytes.
    rejects(() => parseToOcr({ open: { src: 's1', bytes: '/tmp/a.pdf' } }), /Uint8Array/)
  })

  it('rejects wrong types and shapes', () => {
    rejects(() => parseToOcr(null))
    rejects(() => parseToOcr('open'))
    rejects(() => parseToOcr([{ close: 's1' }]))
    rejects(() => parseToOcr({}), /exactly one key/)
    rejects(() => parseToOcr({ close: 5 }))
    rejects(() => parseToOcr({ cancel: { jobId: 'j1' } }))
    rejects(() => parseToOcr({ open: { src: 's1' } }), /missing bytes/)
    rejects(() => parseToOcr({ open: { src: 's1', bytes: [1, 2, 3] } }))
    rejects(() => parseToOcr({ open: { src: 's1', bytes: new Uint16Array(4) } }))
    rejects(() => parseToOcr({ open: { src: 's1', bytes: new ArrayBuffer(4) } }))
    rejects(() => parseToOcr({ open: { src: 's1', bytes: new Uint8Array(0) } }), /empty/)
    rejects(() => parseToOcr({ open: { src: '', bytes } }))
    rejects(() => parseToOcr({ open: { src: 'x'.repeat(65), bytes } }))
  })

  it('rejects objects that are not plain (class instances, null-proto is fine)', () => {
    class Evil {
      src = 's1'
      bytes = bytes
    }
    rejects(() => parseToOcr({ open: new Evil() }))
    const bare = Object.assign(Object.create(null), { src: 's1', bytes }) as object
    expect(parseToOcr({ open: bare })).toEqual({ open: { src: 's1', bytes } })
  })

  it('range-checks every number', () => {
    const withPage = (p: Record<string, unknown>): unknown => ({
      recognize: { ...recognize.recognize, pages: [{ ...page, ...p }] }
    })
    for (const bad of [-1, 1.5, Number.NaN, Infinity, 1_000_001, '0'])
      rejects(() => parseToOcr(withPage({ index: bad })))
    for (const bad of [0, -2, Number.NaN, Infinity, 1001]) {
      rejects(() => parseToOcr(withPage({ userUnit: bad })))
      rejects(() => parseToOcr(withPage({ width: bad === 1001 ? 100_001 : bad })))
    }
    for (const bad of [35, 1201, 300.5, '300'])
      rejects(() =>
        parseToOcr({
          recognize: { ...recognize.recognize, opts: { langs: ['eng'], renderDpi: bad } }
        })
      )
    rejects(() => parseToOcr({ focus: { src: 's1', index: -1 } }))
  })

  it('rejects empty, oversized and duplicate lists', () => {
    rejects(() => parseToOcr({ recognize: { ...recognize.recognize, pages: [] } }))
    rejects(
      () => parseToOcr({ recognize: { ...recognize.recognize, pages: [page, page] } }),
      /duplicate page/
    )
    rejects(() => parseToOcr({ recognize: { ...recognize.recognize, opts: { langs: [] } } }))
    rejects(() =>
      parseToOcr({
        recognize: { ...recognize.recognize, opts: { langs: ['eng', 'deu', 'fra', 'spa'] } }
      })
    )
    rejects(
      () => parseToOcr({ recognize: { ...recognize.recognize, opts: { langs: ['eng', 'eng'] } } }),
      /duplicate language/
    )
    for (const bad of ['ENG', 'en', 'english', 'eng+deu', 'chi_simplified'])
      rejects(() => parseToOcr({ recognize: { ...recognize.recognize, opts: { langs: [bad] } } }))
  })

  it('never echoes a value in its error message', () => {
    try {
      parseToOcr({ open: { src: 'secret text from a page', bytes } })
    } catch (e) {
      expect((e as Error).message).not.toContain('secret')
      expect((e as Error).message).toBe('ToOcr.open.src: expected a token')
    }
  })
})

describe('parseFromOcr (coordinator → renderer)', () => {
  const result = {
    status: 'ok',
    renderDpi: 150,
    raster: { width: 1275, height: 1650 },
    recognition: { stub: true, width: 1275, height: 1650, meanGrey: 240.5, inkFrac: 0.04 }
  }

  it('accepts every well-formed message', () => {
    const good = [
      { opened: { src: 's1', pageCount: 12 } },
      { evicted: { src: 's1' } },
      { result: { jobId: 'j1', src: 's1', index: 0, page: result } },
      {
        result: {
          jobId: 'j1',
          src: 's1',
          index: 3,
          page: {
            status: 'failed',
            reason: 'frame-mismatch',
            renderDpi: null,
            raster: null,
            recognition: null
          }
        }
      },
      { progress: { jobId: 'j1', doneOrFailed: 3, total: 9, inflightFrac: 1.4 } },
      { jobDone: { jobId: 'j1', done: 8, failed: 1, cancelled: false } },
      { error: { code: 'not-open', message: 'no such source', src: 's1' } }
    ]
    for (const m of good) expect(parseFromOcr(m)).toEqual(m)
  })

  it('rejects unknown statuses, reasons and error codes', () => {
    rejects(() =>
      parseFromOcr({
        result: { jobId: 'j1', src: 's1', index: 0, page: { ...result, status: 'meh' } }
      })
    )
    rejects(() =>
      parseFromOcr({
        result: { jobId: 'j1', src: 's1', index: 0, page: { ...result, reason: 'because' } }
      })
    )
    rejects(() => parseFromOcr({ error: { code: 'oops', message: '' } }))
    rejects(() => parseFromOcr({ error: { code: 'internal', message: 'x'.repeat(501) } }))
  })
})

describe('main ⇄ coordinator', () => {
  const limits = { onBattery: false, thermal: 'nominal', speedLimit: 100, divisor: 1 }
  const wasm = process.platform === 'win32' ? 'C:\\app\\pdfium.wasm' : '/app/pdfium.wasm'

  it('accepts init with an absolute pdfium.wasm path and the control messages', () => {
    const good = [
      { init: { limits, paths: { pdfiumWasm: wasm } } },
      { init: { limits, paths: { pdfiumWasm: '/opt/PDFx/resources/app.asar/x/pdfium.wasm' } } },
      { port: {} },
      { limits: { ...limits, onBattery: true, divisor: 4 } },
      { heartbeat: {} },
      { shutdown: {} }
    ]
    for (const m of good) expect(parseMainToOcr(m)).toEqual(m)
  })

  it('rejects a relative or foreign init path and payload on the empty messages', () => {
    for (const p of ['pdfium.wasm', './pdfium.wasm', '/app/evil.wasm', '/app/pdfium.wasm\0'])
      rejects(() => parseMainToOcr({ init: { limits, paths: { pdfiumWasm: p } } }))
    rejects(() => parseMainToOcr({ port: { src: 's1' } }))
    rejects(() => parseMainToOcr({ limits: { ...limits, divisor: 0 } }))
    rejects(() => parseMainToOcr({ limits: { ...limits, thermal: 'hot' } }))
  })

  it('validates everything the utility process says to main', () => {
    const hb = {
      tripwire: { process: 0, raster: 0, recognize: 0 },
      tripwireIntact: true,
      rss: 90_000_000,
      threads: { raster: 1, recognize: 2 },
      pending: 4,
      concurrency: 2
    }
    for (const m of [
      { ready: { tripwire: 0, electronNet: ['fetch', 'request', 'resolveHost', 'isOnline'] } },
      { ready: { tripwire: 0, electronNet: [] } },
      { activity: { busy: true, done: 1, total: 3 } },
      { heartbeat: hb },
      { fatal: { code: 'init', message: 'PDFium failed to start' } }
    ])
      expect(parseOcrToMain(m)).toEqual(m)
    rejects(() =>
      parseOcrToMain({ heartbeat: { ...hb, tripwire: { process: -1, raster: 0, recognize: 0 } } })
    )
    rejects(() => parseOcrToMain({ heartbeat: { ...hb, log: 'page text' } }))
    rejects(() => parseOcrToMain({ ready: {} }))
    rejects(() => parseOcrToMain({ ready: { tripwire: 0, electronNet: ['download'] } }))
    rejects(() => parseOcrToMain({ stderr: 'x' }))
  })
})
