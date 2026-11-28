// The port protocol validators (DESIGN.md §3.3.1): every message shape the coordinator accepts from
// the renderer and from main, and everything main accepts from the utility process. Each "rejects"
// case below is one a compromised or buggy peer could send.

import { describe, expect, it } from 'vitest'

import { pack, type OcrStatus, type PackedOcrPage } from './types'

/** A real-shaped packed page: two lines, char edges on one word, a line language. */
const PACKED: PackedOcrPage = pack({
  v: 1,
  engineId: 'tess-lstm/core-7.0.0/simd/fork-2a9c1c4',
  dataHashes: { eng: 'a'.repeat(64) },
  langs: ['eng'],
  pipelineVersion: 1,
  pageClass: 'scanned',
  renderDpi: 300,
  physDpi: 300,
  orientation: 0,
  skewDeg: 0,
  meanConfCal: 0.93,
  confSource: 'word',
  status: 'ok',
  lines: [
    {
      angle: 0,
      size: 11,
      lang: 'eng',
      words: [
        {
          t: 'Hello',
          x: 24,
          y: 700,
          w: 27.5,
          conf: 96,
          confCal: 0.96,
          chars: new Float32Array([0, 5, 10, 15, 20, 27.5])
        },
        { t: 'world', x: 55, y: 700, w: 30, conf: null, confCal: null }
      ]
    },
    { angle: 0.05, size: 9, words: [{ t: 'two', x: 24, y: 680, w: 15, conf: 80, confCal: 0.8 }] }
  ]
})
import {
  OCR_STATUSES,
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
    recognition: PACKED
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

  it('progress may name the pages in flight: page indices, bounded', () => {
    const p = { jobId: 'j1', doneOrFailed: 3, total: 9, inflightFrac: 1.4 }
    expect(parseFromOcr({ progress: { ...p, inflight: [4, 5] } })).toEqual({
      progress: { ...p, inflight: [4, 5] }
    })
    for (const bad of [[-1], [1.5], ['2'], null, Array.from({ length: 65 }, (_, i) => i)])
      expect(() => parseFromOcr({ progress: { ...p, inflight: bad } })).toThrow(OcrError)
  })

  it("accepts every OcrStatus of the result model (types.ts) and nothing PR2's model lacks", () => {
    // The type-level half (a status missing from the list fails to compile) is in protocol.ts.
    const all: OcrStatus[] = [
      'ok',
      'low-confidence',
      'no-text',
      'timeout',
      'failed',
      'too-large',
      'skipped-has-text',
      'skipped-protected',
      'needs-language'
    ]
    expect([...OCR_STATUSES].sort()).toEqual([...all].sort())
    for (const status of OCR_STATUSES)
      expect(
        parseFromOcr({ result: { jobId: 'j1', src: 's1', index: 0, page: { ...result, status } } })
      ).toMatchObject({ result: { page: { status } } })
  })

  it('checks every array, offset and number of a packed page (it is baked into PDFs)', () => {
    const msg = (recognition: unknown): unknown => ({
      result: { jobId: 'j1', src: 's1', index: 0, page: { ...result, recognition } }
    })
    // Round-trips through structured clone (what the port delivers).
    expect(parseFromOcr(structuredClone(msg(PACKED)))).toEqual(msg(PACKED))
    const bad: Array<[string, Partial<Record<keyof PackedOcrPage, unknown>>]> = [
      ['text shorter than the offsets', { text: 'Hi' }],
      ['offsets not monotone', { wordOff: new Uint32Array([0, 6, 5, 13]) }],
      ['plain array for offsets', { wordOff: [0, 5, 10, 13] }],
      ['geometry length', { wordGeom: new Float32Array(10) }],
      ['NaN position', { wordGeom: PACKED.wordGeom.map((v, i) => (i === 0 ? NaN : v)) }],
      ['conf out of range', { wordGeom: PACKED.wordGeom.map((v, i) => (i === 3 ? 400 : v)) }],
      ['line offsets past the words', { wordLine: new Uint32Array([0, 2, 4]) }],
      ['line geometry length', { lineGeom: new Float32Array(3) }],
      ['infinite size', { lineGeom: new Float32Array([0, Infinity, 0, 9]) }],
      ['line languages length', { lineLang: ['eng'] }],
      ['char offsets without edges', { charEdges: undefined }],
      ['char offsets past the edges', { charOff: new Uint32Array([0, 6, 6, 9]) }],
      ['bad data hash', { dataHashes: { eng: 'xyz' } }],
      ['bad language', { langs: ['../'] }],
      ['bad orientation', { orientation: 45 }],
      ['bad class', { pageClass: 'whatever' }],
      ['bad engine id', { engineId: 'a b' }],
      ['unknown field', { extra: 1 } as never]
    ]
    for (const [what, patch] of bad) {
      const p: Record<string, unknown> = { ...PACKED, ...patch }
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete p[k]
      expect(() => parseFromOcr(msg(p)), what).toThrow()
    }
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
  const dir = process.platform === 'win32' ? 'C:\\app\\ocr\\tessdata\\' : '/app/ocr/tessdata/'
  const engine = {
    ocrCore: process.platform === 'win32' ? 'C:\\app\\ocr' : '/app/ocr',
    tessdata: { eng: `${dir}eng.traineddata.gz`, deu: `${dir}deu.traineddata.gz` }
  }

  it('accepts init with an absolute pdfium.wasm path and the control messages', () => {
    const good = [
      { init: { limits, paths: { pdfiumWasm: wasm, ...engine } } },
      {
        init: {
          limits,
          paths: { pdfiumWasm: '/opt/PDFx/resources/app.asar/x/pdfium.wasm', ...engine }
        }
      },
      { port: {} },
      { limits: { ...limits, onBattery: true, divisor: 4 } },
      { heartbeat: {} },
      { shutdown: {} }
    ]
    for (const m of good) expect(parseMainToOcr(m)).toEqual(m)
  })

  it('rejects a relative or foreign init path and payload on the empty messages', () => {
    for (const p of ['pdfium.wasm', './pdfium.wasm', '/app/evil.wasm', '/app/pdfium.wasm\0'])
      rejects(() => parseMainToOcr({ init: { limits, paths: { pdfiumWasm: p, ...engine } } }))
    // The engine paths: absolute, and each language only its own <lang>.traineddata.gz.
    for (const tessdata of [
      { eng: 'eng.traineddata.gz' },
      { eng: `${dir}deu.traineddata.gz` },
      { eng: `${dir}xeng.traineddata.gz` },
      { 'e/g': `${dir}e/g.traineddata.gz` },
      { eng: `${dir}eng.traineddata` }
    ])
      rejects(() =>
        parseMainToOcr({
          init: { limits, paths: { pdfiumWasm: wasm, ocrCore: engine.ocrCore, tessdata } }
        })
      )
    rejects(() =>
      parseMainToOcr({ init: { limits, paths: { pdfiumWasm: wasm, ...engine, ocrCore: 'ocr' } } })
    )
    rejects(() => parseMainToOcr({ init: { limits, paths: { pdfiumWasm: wasm } } }))
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
    const selfCheck = { checked: ['process._linkedBinding', 'dns.promises.Resolver'], failed: [] }
    for (const m of [
      {
        ready: {
          tripwire: 0,
          electronNet: ['fetch', 'request', 'resolveHost', 'isOnline'],
          selfCheck
        }
      },
      { ready: { tripwire: 0, electronNet: [], selfCheck: { checked: [], failed: ['fetch'] } } },
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
    rejects(() => parseOcrToMain({ ready: { tripwire: 0, electronNet: ['download'], selfCheck } }))
    rejects(() => parseOcrToMain({ ready: { tripwire: 0, electronNet: [] } }), /missing selfCheck/)
    rejects(() =>
      parseOcrToMain({
        ready: { tripwire: 0, electronNet: [], selfCheck: { ...selfCheck, failed: ['page text!'] } }
      })
    )
    // The heartbeat's tripwire flag is a boolean, nothing else.
    for (const v of ['yes', 1, null])
      rejects(() => parseOcrToMain({ heartbeat: { ...hb, tripwireIntact: v } }))
    rejects(() => parseOcrToMain({ stderr: 'x' }))
  })
})

describe('unknown keys named after Object.prototype members', () => {
  // `k in obj` finds inherited members, so these names were dropped instead of rejected. Each
  // message goes through structuredClone first: that is what a port delivers, and JSON.parse is
  // how a `__proto__` key becomes an own property.
  const clone = <T>(json: string): T => structuredClone(JSON.parse(json)) as T
  const PROTO_NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']
  const hb = {
    tripwire: { process: 0, raster: 0, recognize: 0 },
    tripwireIntact: true,
    rss: 1,
    threads: { raster: 0, recognize: 0 },
    pending: 0,
    concurrency: 1
  }
  const limits = { onBattery: false, thermal: 'nominal', speedLimit: 100, divisor: 1 }

  for (const name of PROTO_NAMES) {
    const extra = `${JSON.stringify(name)}: {"polluted": 1}`
    it(`rejects ${name} in every direction`, () => {
      rejects(
        () => parseToOcr(clone(`{"focus": {"src": "a", "index": 0, ${extra}}}`)),
        /unknown key/
      )
      rejects(
        () => parseToOcr({ open: { src: 's', bytes, ...clone<object>(`{${extra}}`) } }),
        /unknown key/
      )
      rejects(() => parseFromOcr(clone(`{"evicted": {"src": "s", ${extra}}}`)), /unknown key/)
      rejects(
        () =>
          parseMainToOcr(
            clone(
              `{"init": {"limits": ${JSON.stringify(limits)}, "paths": {"pdfiumWasm": "/app/pdfium.wasm", ${extra}}}}`
            )
          ),
        /unknown key/
      )
      rejects(
        () =>
          parseOcrToMain(clone(`{"heartbeat": {${JSON.stringify(hb).slice(1, -1)}, ${extra}}}`)),
        /unknown key/
      )
      // And as the message key itself.
      rejects(() => parseToOcr(clone(`{${extra}}`)), /unknown message/)
    })
  }

  it('still never hands back an object with a polluted prototype', () => {
    expect(Object.prototype).not.toHaveProperty('polluted')
  })
})

describe('PR6 fields: the edit rotation in, rotateBy out (§3.4.5)', () => {
  it('accepts editRotation 0/90/180/270 on a page request and nothing else', () => {
    for (const editRotation of [0, 90, 180, 270]) {
      const m = { recognize: { ...recognize.recognize, pages: [{ ...page, editRotation }] } }
      expect(parseToOcr(m)).toEqual(m)
    }
    for (const bad of [45, -90, 360, '90', null])
      rejects(() =>
        parseToOcr({
          recognize: { ...recognize.recognize, pages: [{ ...page, editRotation: bad }] }
        })
      )
  })

  it('accepts rotateBy 90/180/270 on a page result; 0 is never sent', () => {
    const result = (rotateBy: unknown): unknown => ({
      result: {
        jobId: 'j1',
        src: 's1',
        index: 0,
        page: {
          status: 'no-text',
          renderDpi: 300,
          raster: { width: 10, height: 10 },
          recognition: null,
          rotateBy
        }
      }
    })
    for (const r of [90, 180, 270]) expect(() => parseFromOcr(result(r) as never)).not.toThrow()
    for (const r of [0, 45, '90']) rejects(() => parseFromOcr(result(r) as never))
  })
})
