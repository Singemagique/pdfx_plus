// Downloaded / installed languages in the coordinator (PR9, DESIGN.md §3.2.5): they come from main
// only (`init` or a later `languages` message), are checked one by one (a failure drops the
// language, never OCR), reach live recognize threads by `add-data`, and a page waits while a
// language it needs is still being checked.

import { afterEach, describe, expect, it } from 'vitest'

import { parseMainToOcr, type PageResult } from '../../../shared/ocr/protocol'
import { Coordinator } from './coordinator'
import { FakePort, INIT, harness, settle, type Harness } from '../test-utils/fake-threads'

const PAGE = { userUnit: 1, width: 612, height: 792 }
const pages = (...idx: number[]): Array<typeof PAGE & { index: number }> =>
  idx.map((index) => ({ index, ...PAGE }))
const win = process.platform === 'win32'
const RUS = win ? 'C:\\u\\tessdata\\rus.traineddata.gz' : '/u/tessdata/rus.traineddata.gz'
const JPN = win ? 'C:\\u\\tessdata\\jpn.traineddata' : '/u/tessdata/jpn.traineddata'

let live: Coordinator[] = []
afterEach(() => {
  for (const c of live) c.dispose()
  live = []
})

type Loader = NonNullable<Harness['deps']['loadLanguage']>

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const sab = (n: number): SharedArrayBuffer => new SharedArrayBuffer(n)

async function start(
  loadLanguage: Loader | undefined,
  extra: Record<string, string> = {}
): Promise<{ h: Harness; c: Coordinator; port: FakePort; calls: string[] }> {
  const h = harness()
  const calls: string[] = []
  if (loadLanguage)
    h.deps.loadLanguage = (lang, path) => {
      calls.push(`${lang}:${path}`)
      return loadLanguage(lang, path)
    }
  const c = new Coordinator(h.deps)
  live.push(c)
  h.parent.send({
    init: {
      ...INIT.init,
      paths: { ...INIT.init.paths, tessdata: { ...INIT.init.paths.tessdata, ...extra } }
    }
  })
  const port = new FakePort()
  h.parent.send({ port: {} }, [port])
  await settle()
  port.send({ open: { src: 's1', bytes: new Uint8Array(64).fill(0x25) } })
  await settle()
  return { h, c, port, calls }
}

const results = (port: FakePort): PageResult[] =>
  (port.of('result') as Array<{ page: PageResult }>).map((r) => r.page)

const recognizeIn = (port: FakePort, jobId: string, langs: string[], ...idx: number[]): void =>
  port.send({
    recognize: { jobId, src: 's1', pages: pages(...idx), opts: { langs, renderDpi: 72 } }
  })

describe('catalogue languages in the coordinator', () => {
  it('a language main named at init is checked, then recognised with', async () => {
    const { h, port, calls } = await start(async () => ({ data: sab(8), sha256: 'r'.repeat(64) }), {
      rus: RUS
    })
    expect(calls).toEqual([`rus:${RUS}`])
    recognizeIn(port, 'j', ['eng', 'rus'], 0)
    await settle()
    const [page] = results(port)
    expect(page.status).toBe('ok')
    expect(page.recognition!.dataHashes).toEqual({ eng: 'e'.repeat(64), rus: 'r'.repeat(64) })
    // The thread got the data (at init, or by add-data if it started first).
    const r = h.recognizers[0]
    const got = [...Object.keys(r.initModule?.data ?? {}), ...r.addedData.flat()]
    expect(got).toContain('rus')
    // The bundled languages still went through loadEngine (strict), the catalogue one did not.
    expect(h.parent.of('fatal')).toEqual([])
  })

  it('a `languages` message reaches a running thread with add-data', async () => {
    const { h, port, calls } = await start(async (lang) => ({
      data: sab(4),
      sha256: lang[0].repeat(64)
    }))
    recognizeIn(port, 'j1', ['eng'], 0)
    await settle()
    expect(h.recognizers).toHaveLength(1)
    h.parent.send({ languages: { tessdata: { rus: RUS, jpn: JPN } } })
    await settle()
    expect(calls.sort()).toEqual([`jpn:${JPN}`, `rus:${RUS}`])
    expect(h.recognizers[0].addedData.flat().sort()).toEqual(['jpn', 'rus'])
    recognizeIn(port, 'j2', ['jpn', 'rus'], 1)
    await settle()
    expect(results(port).map((p) => p.status)).toEqual(['ok', 'ok'])
    // Named again: nothing is loaded twice.
    h.parent.send({ languages: { tessdata: { rus: RUS } } })
    await settle()
    expect(calls).toHaveLength(2)
  })

  it('a page waits while its language is being checked', async () => {
    const d = deferred<{ data: SharedArrayBuffer; sha256: string }>()
    const { h, port } = await start(() => d.promise, { rus: RUS })
    recognizeIn(port, 'j', ['rus'], 0)
    await settle()
    // Rendered (render-ahead is fine), never recognised, and not needs-language.
    expect(h.recognizers.flatMap((r) => r.jobs)).toHaveLength(0)
    expect(results(port)).toEqual([])
    d.resolve({ data: sab(4), sha256: 'r'.repeat(64) })
    await settle()
    expect(results(port).map((p) => p.status)).toEqual(['ok'])
  })

  it('a language that fails its check ends its pages needs-language; OCR stays on', async () => {
    const d = deferred<{ data: SharedArrayBuffer; sha256: string }>()
    const { h, port } = await start(() => d.promise, { rus: RUS })
    recognizeIn(port, 'j', ['eng', 'rus'], 0, 1)
    recognizeIn(port, 'k', ['eng'], 2)
    await settle()
    d.reject(new Error('traineddata rus: SHA-256 mismatch'))
    await settle()
    const byIndex = new Map(
      (port.of('result') as Array<{ index: number; page: PageResult }>).map((r) => [
        r.index,
        r.page.status
      ])
    )
    expect(byIndex.get(0)).toBe('needs-language')
    expect(byIndex.get(1)).toBe('needs-language')
    expect(byIndex.get(2)).toBe('ok')
    expect(h.parent.of('fatal')).toEqual([])
    // Asked again later: needs-language at once.
    recognizeIn(port, 'l', ['rus'], 3)
    await settle()
    expect((port.of('result') as Array<{ index: number; page: PageResult }>).at(-1)).toMatchObject({
      index: 3,
      page: { status: 'needs-language' }
    })
  })

  it('without a language loader only the bundled languages exist', async () => {
    const { port } = await start(undefined, { rus: RUS })
    recognizeIn(port, 'j', ['rus'], 0)
    await settle()
    expect(results(port).map((p) => p.status)).toEqual(['needs-language'])
  })

  it('bundled codes in a languages message are ignored (they load with the engine only)', async () => {
    const { h, calls } = await start(async () => ({ data: sab(1), sha256: 'x'.repeat(64) }))
    const eng = win ? 'C:\\evil\\eng.traineddata.gz' : '/evil/eng.traineddata.gz'
    h.parent.send({ languages: { tessdata: { eng } } })
    await settle()
    expect(calls).toEqual([])
  })
})

describe('the languages message (main → coordinator)', () => {
  it('takes .traineddata.gz and .traineddata files named for their language', () => {
    expect(parseMainToOcr({ languages: { tessdata: { rus: RUS, jpn: JPN } } })).toEqual({
      languages: { tessdata: { rus: RUS, jpn: JPN } }
    })
  })

  it('refuses another file name, a relative path or a bad code', () => {
    const dir = win ? 'C:\\u\\' : '/u/'
    for (const tessdata of [
      { rus: `${dir}jpn.traineddata.gz` },
      { rus: `${dir}xrus.traineddata.gz` },
      { rus: 'rus.traineddata.gz' },
      { rus: `${dir}rus.traineddata.gz.part` },
      { rus: `${dir}rus.zip` },
      { 'RU!': `${dir}RU!.traineddata` }
    ])
      expect(() => parseMainToOcr({ languages: { tessdata } })).toThrow()
    expect(() => parseMainToOcr({ languages: {} })).toThrow()
  })
})
