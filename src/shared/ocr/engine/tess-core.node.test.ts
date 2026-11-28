// The loader's contract with the glue (DESIGN.md §3.2.2), against a scripted fake module so every
// failure shape PR0/PR0b measured can be produced on demand: the instantiateWasm path with the
// posted Module, the locateFile tripwire, print dropped and printErr into the ring, FS writes,
// debug_file before and after Init, PGM input, the exit-code reset after a glue quit, and the OOM
// classification (rc −1, or empty hOCR with an allocation failure on printErr). The real core runs
// in tier 1 (engine.ocr.test.ts).

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ALLOC_FAILURE_RE,
  ENGINE_ID,
  LineRing,
  TessError,
  configHashInput,
  createTess,
  encodePgm,
  fullPageParams,
  type EmscriptenOpts,
  type TessApi,
  type TessModule
} from './tess-core'

const EMPTY_WASM = new WebAssembly.Module(
  new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
)

interface FakeScript {
  initRc?: number
  recognizeRc?: number
  hocr?: string
  stderrDuringRecognize?: string[]
  quitIn?: 'Init' | 'Recognize'
  abortIn?: 'Recognize'
  /** The RuntimeError message of `abortIn` (default: the bare abort this build throws). */
  abortMessage?: string
  /** Recognize throws this instead (e.g. a RangeError from the glue). */
  throwInRecognize?: Error
  /** SetImageFile reports that no 8-bit image was set. */
  imageRejected?: boolean
}

function fake(script: FakeScript = {}) {
  const calls: string[] = []
  const files = new Map<string, Uint8Array>()
  let opts!: EmscriptenOpts
  const factory = async (o: EmscriptenOpts): Promise<TessModule> => {
    opts = o
    await new Promise<void>((resolve) => {
      o.instantiateWasm({}, (inst, mod) => {
        calls.push(`instantiated:${inst instanceof WebAssembly.Instance}:${mod === EMPTY_WASM}`)
        resolve()
      })
    })
    o.print('stdout line')
    const quit = (code: number): never => {
      ;(process as { exitCode?: number }).exitCode = code
      throw { name: 'ExitStatus', message: `exit(${code})`, status: code }
    }
    class Api implements TessApi {
      SetVariable(k: string, v: string): boolean {
        calls.push(`set:${k}=${v}`)
        return !k.startsWith('bogus')
      }
      Init(path: string, langs: string, oem: number): number {
        calls.push(`init:${path}:${langs}:${oem}`)
        if (script.quitIn === 'Init') quit(3)
        return script.initRc ?? 0
      }
      SetImageFile(): boolean {
        calls.push('setImageFile')
        return script.imageRejected !== true
      }
      Recognize(): number {
        calls.push('recognize')
        for (const l of script.stderrDuringRecognize ?? []) o.printErr(l)
        if (script.quitIn === 'Recognize') quit(7)
        if (script.abortIn === 'Recognize') {
          // Whatever the glue left in the exit code must not survive the call.
          ;(process as { exitCode?: number }).exitCode = 7
          throw new WebAssembly.RuntimeError(
            script.abortMessage ??
              'Aborted(native code called abort()). Build with -sASSERTIONS for more info.'
          )
        }
        if (script.throwInRecognize) {
          ;(process as { exitCode?: number }).exitCode = 7
          throw script.throwInRecognize
        }
        return script.recognizeRc ?? 0
      }
      GetHOCRText(): string {
        return script.hocr ?? "<div class='ocr_page' title='bbox 0 0 1 1'></div>"
      }
      End(): void {
        calls.push('end')
      }
    }
    return {
      FS: {
        mkdir: (p) => calls.push(`mkdir:${p}`),
        writeFile: (p, d) => {
          files.set(p, d)
          calls.push(`write:${p}`)
        },
        unlink: (p) => {
          files.delete(p)
          calls.push(`unlink:${p}`)
        }
      },
      TessBaseAPI: Api
    }
  }
  return { factory, calls, files, opts: () => opts }
}

const IMG = { width: 3, height: 2, data: new Uint8Array([0, 1, 2, 3, 4, 5]) }
const DATA = { eng: new Uint8Array([1, 2, 3]), deu: new Uint8Array([4]) }

afterEach(() => {
  ;(process as { exitCode?: number }).exitCode = undefined
})

describe('createTess', () => {
  it('instantiates the posted Module, writes the data, sets debug_file around Init (OEM 1)', async () => {
    const f = fake()
    const lines: string[] = []
    const tess = await createTess(
      {
        factory: f.factory,
        wasmModule: EMPTY_WASM,
        traineddata: DATA,
        stderr: (l) => lines.push(l)
      },
      ['eng', 'deu']
    )
    expect(f.calls.slice(0, 7)).toEqual([
      'instantiated:true:true',
      'mkdir:/tessdata',
      'write:/tessdata/eng.traineddata',
      'write:/tessdata/deu.traineddata',
      'set:debug_file=/dev/null',
      'init:/tessdata:eng+deu:1',
      'set:debug_file=/dev/null'
    ])
    expect(f.files.get('/tessdata/eng.traineddata')).toBe(DATA.eng)
    // The fetch path is never taken; its locateFile hook points nowhere.
    expect(f.opts().locateFile('tesseract-core-simd-lstm.wasm')).toBe('/nonexistent/no-wasm-fetch')
    expect(lines).toEqual([]) // print is dropped, not forwarded
    expect(tess.langs).toEqual(['eng', 'deu'])
    tess.end()
    tess.end()
    expect(f.calls.filter((c) => c === 'end')).toHaveLength(1)
  })

  it('recognises a PGM with the pass parameters and returns the hOCR', async () => {
    const f = fake({ hocr: '<hocr/>' })
    const tess = await createTess(
      { factory: f.factory, wasmModule: EMPTY_WASM, traineddata: DATA },
      ['eng']
    )
    const r = tess.recognize(IMG, fullPageParams(300))
    expect(r).toEqual({ hocr: '<hocr/>', stderrLines: 0 })
    const tail = f.calls.slice(f.calls.indexOf('set:tessedit_pageseg_mode=3'))
    expect(tail).toEqual([
      'set:tessedit_pageseg_mode=3',
      'set:user_defined_dpi=300',
      'set:preserve_interword_spaces=1',
      'set:hocr_char_boxes=1',
      'set:thresholding_method=0',
      'write:/input',
      'setImageFile',
      'recognize',
      'unlink:/input'
    ])
  })

  it('refuses an unknown language and a failing Init', async () => {
    const f = fake()
    await expect(
      createTess({ factory: f.factory, wasmModule: EMPTY_WASM, traineddata: DATA }, ['fra'])
    ).rejects.toMatchObject({ kind: 'init' })
    await expect(
      createTess({ factory: f.factory, wasmModule: EMPTY_WASM, traineddata: DATA }, [])
    ).rejects.toMatchObject({ kind: 'init' })
    const g = fake({ initRc: -1 })
    await expect(
      createTess({ factory: g.factory, wasmModule: EMPTY_WASM, traineddata: DATA }, ['eng'])
    ).rejects.toMatchObject({ kind: 'init' })
  })

  it('a glue quit (ExitStatus) resets process.exitCode and poisons the module', async () => {
    const f = fake({ quitIn: 'Recognize' })
    const tess = await createTess(
      { factory: f.factory, wasmModule: EMPTY_WASM, traineddata: DATA },
      ['eng']
    )
    expect(() => tess.recognize(IMG, fullPageParams(300))).toThrow(TessError)
    expect(process.exitCode).toBe(0)
    expect(tess.broken).toBe(true)
    expect(() => tess.recognize(IMG, fullPageParams(300))).toThrow(/no longer trusted/)
    const g = fake({ quitIn: 'Init' })
    await expect(
      createTess({ factory: g.factory, wasmModule: EMPTY_WASM, traineddata: DATA }, ['eng'])
    ).rejects.toMatchObject({ kind: 'exit' })
    expect(process.exitCode).toBe(0)
  })

  it('an abort is a RuntimeError → kind abort, module never trusted again', async () => {
    const f = fake({ abortIn: 'Recognize' })
    const tess = await createTess(
      { factory: f.factory, wasmModule: EMPTY_WASM, traineddata: DATA },
      ['eng']
    )
    expect(() => tess.recognize(IMG, fullPageParams(300))).toThrow(
      expect.objectContaining({ kind: 'abort' })
    )
    expect(tess.broken).toBe(true)
  })

  it('WASM OOM: rc −1, or empty hOCR with a Leptonica allocation failure, is OOM-shaped', async () => {
    const leptonica = ['Error in pixCreateNoInit: pixdata_malloc fail for data']
    const rc = fake({ recognizeRc: -1, stderrDuringRecognize: leptonica })
    const t1 = await createTess(
      { factory: rc.factory, wasmModule: EMPTY_WASM, traineddata: DATA },
      ['eng']
    )
    const e1 = ((): TessError | null => {
      try {
        t1.recognize(IMG, fullPageParams(300))
        return null
      } catch (e) {
        return e as TessError
      }
    })()
    expect(e1).toMatchObject({ kind: 'oom', name: 'OcrOutOfMemory' })
    expect(rc.calls).toContain('unlink:/input')

    const empty = fake({ hocr: '', stderrDuringRecognize: leptonica })
    const t2 = await createTess(
      { factory: empty.factory, wasmModule: EMPTY_WASM, traineddata: DATA },
      ['eng']
    )
    expect(() => t2.recognize(IMG, fullPageParams(300))).toThrow(
      expect.objectContaining({ kind: 'oom' })
    )
    // Empty hOCR without an allocation failure is still a failure, never "no text".
    const quiet = fake({ hocr: '' })
    const t3 = await createTess(
      { factory: quiet.factory, wasmModule: EMPTY_WASM, traineddata: DATA },
      ['eng']
    )
    expect(() => t3.recognize(IMG, fullPageParams(300))).toThrow(
      expect.objectContaining({ kind: 'empty' })
    )
  })

  it('rc −1 alone (no printErr line at all) is OOM-shaped, never "empty"', async () => {
    const f = fake({ recognizeRc: -1 })
    const tess = await createTess(
      { factory: f.factory, wasmModule: EMPTY_WASM, traineddata: DATA },
      ['eng']
    )
    expect(() => tess.recognize(IMG, fullPageParams(300))).toThrow(
      expect.objectContaining({ kind: 'oom', name: 'OcrOutOfMemory' })
    )
    expect(tess.broken).toBe(true)
  })

  it('a refused input image is a params error, never OOM-shaped, and Recognize never runs', async () => {
    const f = fake({ imageRejected: true })
    const tess = await createTess(
      { factory: f.factory, wasmModule: EMPTY_WASM, traineddata: DATA },
      ['eng']
    )
    expect(() => tess.recognize(IMG, fullPageParams(300))).toThrow(
      expect.objectContaining({ kind: 'params', name: 'TessError' })
    )
    expect(f.calls).toContain('setImageFile')
    expect(f.calls).not.toContain('recognize')
    expect(tess.broken).toBe(true)
  })

  const thrown = async (script: FakeScript): Promise<TessError> => {
    const f = fake(script)
    const tess = await createTess(
      { factory: f.factory, wasmModule: EMPTY_WASM, traineddata: DATA },
      ['eng']
    )
    try {
      tess.recognize(IMG, fullPageParams(300))
    } catch (e) {
      expect(tess.broken).toBe(true)
      return e as TessError
    }
    throw new Error('recognize did not throw')
  }

  it('an abort or glue error that is an allocation failure is OOM-shaped (and resets the exit code)', async () => {
    const cases: Array<[string, FakeScript]> = [
      // A failed operator new: the bare abort, but Leptonica said why on printErr first.
      [
        'printErr malloc fail, then a bare Aborted()',
        {
          abortIn: 'Recognize',
          stderrDuringRecognize: ['Error in pixCreateNoInit: pixdata_malloc fail for data']
        }
      ],
      [
        'abort message names it',
        { abortIn: 'Recognize', abortMessage: 'Aborted(Cannot enlarge memory arrays)' }
      ],
      [
        'abort message: Leptonica',
        { abortIn: 'Recognize', abortMessage: 'Aborted(pixdata_malloc fail for data)' }
      ],
      [
        'RangeError from the glue',
        { throwInRecognize: new RangeError('Array buffer allocation failed') }
      ]
    ]
    for (const [what, script] of cases) {
      ;(process as { exitCode?: number }).exitCode = undefined
      const e = await thrown(script)
      expect(e, what).toBeInstanceOf(TessError)
      expect(e, what).toMatchObject({ kind: 'oom', name: 'OcrOutOfMemory' })
      expect(process.exitCode, what).toBe(0)
    }
  })

  it('an abort without an allocation failure stays an abort; a stack overflow is not memory', async () => {
    // A printErr line before the call does not count: only lines since the call began.
    const bare = await thrown({ abortIn: 'Recognize' })
    expect(bare).toMatchObject({ kind: 'abort', name: 'TessError' })
    expect(process.exitCode).toBe(0)
    const unrelated = await thrown({
      abortIn: 'Recognize',
      stderrDuringRecognize: ['Warning: Invalid resolution 0 dpi. Using 70 instead.']
    })
    expect(unrelated.kind).toBe('abort')
    const stack = await thrown({
      throwInRecognize: new RangeError('Maximum call stack size exceeded')
    })
    expect(stack.kind).toBe('abort')
  })

  it('a failed instantiate of the posted Module rejects createTess instead of hanging', async () => {
    // The fake factory, like the real glue (7.0.0's and ours), only ever resolves through instantiateWasm's
    // success callback: before the race, this promise never settled (PR5 review).
    // A module importing a function the imports object does not provide: instantiate rejects.
    const importing = new WebAssembly.Module(
      new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x02,
        0x08, 0x01, 0x02, 0x7a, 0x7a, 0x01, 0x66, 0x00, 0x00
      ])
    )
    const f = fake()
    const settled = await Promise.race([
      createTess({ factory: f.factory, wasmModule: importing, traineddata: DATA }, ['eng']).then(
        () => 'resolved',
        (e: unknown) => e
      ),
      new Promise((r) => setTimeout(() => r('still pending'), 2000))
    ])
    expect(settled).toBeInstanceOf(TessError)
    expect(settled).toMatchObject({ kind: 'init', message: expect.stringMatching(/instantiate/) })
    expect(f.calls.some((c) => c.startsWith('instantiated'))).toBe(false)

    // V8's out-of-memory shape for a failed Wasm memory reservation is OOM-shaped.
    const spy = vi
      .spyOn(WebAssembly, 'instantiate')
      .mockRejectedValueOnce(
        new RangeError(
          'WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance'
        )
      )
    try {
      await expect(
        createTess({ factory: fake().factory, wasmModule: EMPTY_WASM, traineddata: DATA }, ['eng'])
      ).rejects.toMatchObject({ kind: 'oom', name: 'OcrOutOfMemory' })
    } finally {
      spy.mockRestore()
    }
  })

  it('a factory that throws or rejects becomes an init error', async () => {
    const sync = (() => {
      throw new Error('glue exploded')
    }) as unknown as Parameters<typeof createTess>[0]['factory']
    await expect(
      createTess({ factory: sync, wasmModule: EMPTY_WASM, traineddata: DATA }, ['eng'])
    ).rejects.toMatchObject({ kind: 'init' })
    await expect(
      createTess(
        {
          factory: async () => Promise.reject(new TypeError('x')),
          wasmModule: EMPTY_WASM,
          traineddata: DATA
        },
        ['eng']
      )
    ).rejects.toMatchObject({ kind: 'init' })
  })

  it('counts printErr lines per call (a successful page normally has none)', async () => {
    const f = fake({ stderrDuringRecognize: ['Warning: x'] })
    const tess = await createTess(
      { factory: f.factory, wasmModule: EMPTY_WASM, traineddata: DATA },
      ['eng']
    )
    expect(tess.recognize(IMG, fullPageParams(300)).stderrLines).toBe(1)
    expect(tess.stderrCount).toBe(1)
  })

  it('a rejected parameter fails the call', async () => {
    const f = fake()
    const tess = await createTess(
      { factory: f.factory, wasmModule: EMPTY_WASM, traineddata: DATA },
      ['eng']
    )
    expect(() => tess.recognize(IMG, { ...fullPageParams(300), bogus_param: 1 } as never)).toThrow(
      expect.objectContaining({ kind: 'params' })
    )
  })
})

describe('helpers', () => {
  it('encodePgm writes a P5 header and packed rows (strided input too)', () => {
    const pgm = encodePgm(IMG)
    const header = 'P5\n3 2\n255\n'
    expect(new TextDecoder().decode(pgm.subarray(0, header.length))).toBe(header)
    expect([...pgm.subarray(header.length)]).toEqual([0, 1, 2, 3, 4, 5])
    const strided = encodePgm({
      width: 2,
      height: 2,
      stride: 3,
      data: new Uint8Array([1, 2, 9, 3, 4, 9])
    })
    expect([...strided.subarray('P5\n2 2\n255\n'.length)]).toEqual([1, 2, 3, 4])
    expect(() => encodePgm({ width: 0, height: 1, data: new Uint8Array(0) })).toThrow(RangeError)
    expect(() => encodePgm({ width: 4, height: 4, data: new Uint8Array(3) })).toThrow(RangeError)
  })

  it('LineRing keeps the last lines, bounded in count and length', () => {
    const r = new LineRing(3)
    const m = r.mark()
    for (const l of ['a', 'b', 'c', 'd', 'x'.repeat(500)]) r.push(l)
    expect(r.count).toBe(5)
    expect(r.since(m)).toEqual(['c', 'd', 'x'.repeat(200)])
    const m2 = r.mark()
    expect(r.since(m2)).toEqual([])
  })

  it('classifies the allocation-failure lines PR0b saw', () => {
    expect(ALLOC_FAILURE_RE.test('Error in pixCreateNoInit: pixdata_malloc fail for data')).toBe(
      true
    )
    expect(ALLOC_FAILURE_RE.test('Cannot enlarge memory, requested 1 bytes')).toBe(true)
    expect(
      ALLOC_FAILURE_RE.test('Out of memory: Cannot allocate Wasm memory for new instance')
    ).toBe(true)
    expect(ALLOC_FAILURE_RE.test('Estimating resolution as 368')).toBe(false)
    expect(ALLOC_FAILURE_RE.test('Aborted(native code called abort())')).toBe(false)
  })

  it('configHash input: sorted data, pipeline version, params without the per-page DPI', () => {
    const s = configHashInput({
      engineId: ENGINE_ID,
      coreSha256: 'c'.repeat(64),
      dataSha256: { eng: 'e', deu: 'd' },
      pipelineVersion: 1,
      params: { ...fullPageParams(300) }
    })
    expect(s).toBe(
      [
        ENGINE_ID,
        'c'.repeat(64),
        'deu:d,eng:e',
        'pipeline=1',
        'hocr_char_boxes=1,preserve_interword_spaces=1,tessedit_pageseg_mode=3,thresholding_method=0'
      ].join('\n')
    )
    expect(
      configHashInput({
        engineId: ENGINE_ID,
        coreSha256: 'c'.repeat(64),
        dataSha256: { eng: 'e', deu: 'd' },
        pipelineVersion: 1,
        params: { ...fullPageParams(150) }
      })
    ).toBe(s)
  })
})
