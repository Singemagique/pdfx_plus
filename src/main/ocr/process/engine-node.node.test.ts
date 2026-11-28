// The manifest checks on every engine byte (DESIGN.md §3.2.1: "the engine never parses a model file
// not hashed here"), against copies of the real files in a temp dir: a same-size one-byte flip, a
// truncation and a missing file must each reject with OcrError('init') naming the file and the
// check, never the path, for the core (compileCore), the glue (loadGlue), each .traineddata.gz
// (loadTraineddataGz), the whole load (loadEngine) and the raw data after gunzip
// (gunzipTraineddata). And the hashes loadEngine stamps into every page are the manifest's .gz ones.

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { OcrError } from '../../../shared/ocr/protocol'
import { REPO_ROOT, nodeModulesEnginePaths } from '../test-utils/engine-harness'
import {
  ENGINE_CORE,
  ENGINE_DATA,
  catalogueEntry,
  manifestDataFor,
  type ManifestData
} from './engine-manifest'
import {
  compileCore,
  gunzipTraineddata,
  loadEngine,
  loadGlue,
  loadLanguage,
  loadTraineddataGz,
  sha256Hex,
  verifyBytes
} from './engine-node'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pdfx-engine-node-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

type Tamper = 'flip' | 'truncate' | 'missing'
const TAMPERS: Tamper[] = ['flip', 'truncate', 'missing']
const WHY: Record<Tamper, RegExp> = {
  flip: /SHA-256 mismatch/,
  truncate: /size \d+, expected \d+/,
  missing: /not readable/
}

/** A fresh directory holding a copy of `source` (repo-relative) as `name`, tampered with. */
function tampered(source: string, name: string, how: Tamper): string {
  const d = mkdtempSync(join(dir, `${how}-`))
  const file = join(d, name)
  if (how === 'missing') return d
  const bytes = new Uint8Array(readFileSync(join(REPO_ROOT, source)))
  if (how === 'flip') bytes[bytes.length >> 1] ^= 0x01
  writeFileSync(file, how === 'truncate' ? bytes.subarray(0, bytes.length - 1) : bytes)
  return d
}

/** Rejects (or throws) OcrError('init') whose message says `why` and never echoes `d`. */
async function expectInit(run: () => unknown, why: RegExp, what: RegExp, d: string): Promise<void> {
  let err: unknown
  try {
    await run()
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(OcrError)
  const e = err as OcrError
  expect(e.code).toBe('init')
  expect(e.message).toMatch(why)
  expect(e.message).toMatch(what)
  expect(e.message).not.toContain(d)
  expect(e.message).not.toMatch(/[\\/]/)
}

describe('every engine file is checked against the manifest before use', () => {
  it('verifyBytes: same size but one bit off, and one byte short, are refused', () => {
    const want = { bytes: 4, sha256: sha256Hex(new Uint8Array([1, 2, 3, 4])) }
    expect(() => verifyBytes(new Uint8Array([1, 2, 3, 4]), want, 'x')).not.toThrow()
    expect(() => verifyBytes(new Uint8Array([1, 2, 3, 5]), want, 'x')).toThrow(/SHA-256 mismatch/)
    expect(() => verifyBytes(new Uint8Array([1, 2, 3]), want, 'x')).toThrow(/size 3, expected 4/)
  })

  for (const how of TAMPERS)
    it(`core (.wasm), ${how}: compileCore refuses it`, async () => {
      const d = tampered(ENGINE_CORE.wasm.source, ENGINE_CORE.wasm.file, how)
      await expectInit(() => compileCore(d), WHY[how], /^core/, d)
    })

  for (const how of TAMPERS)
    it(`glue (.js), ${how}: loadGlue refuses it before require()`, async () => {
      const d = tampered(ENGINE_CORE.js.source, ENGINE_CORE.js.file, how)
      await expectInit(() => loadGlue(d), WHY[how], /^glue/, d)
    })

  for (const how of TAMPERS)
    it(`traineddata (.gz), ${how}: loadTraineddataGz refuses it`, async () => {
      const f = ENGINE_DATA.fra
      const d = tampered(f.source, f.file, how)
      await expectInit(
        () => loadTraineddataGz('fra', join(d, f.file)),
        WHY[how],
        /^traineddata fra/,
        d
      )
    })

  it('loadEngine refuses a bad traineddata among good core files, naming it (one byte off)', async () => {
    const good = nodeModulesEnginePaths()
    const d = tampered(ENGINE_DATA.fra.source, ENGINE_DATA.fra.file, 'flip')
    await expectInit(
      () =>
        loadEngine({ ...good, tessdata: { ...good.tessdata, fra: join(d, ENGINE_DATA.fra.file) } }),
      /SHA-256 mismatch/,
      /^traineddata fra/,
      d
    )
  })

  it('loadEngine refuses a bad glue next to a good core (checked once in the coordinator too)', async () => {
    const d = mkdtempSync(join(dir, 'glue-'))
    copyFileSync(join(REPO_ROOT, ENGINE_CORE.wasm.source), join(d, ENGINE_CORE.wasm.file))
    const glue = new Uint8Array(readFileSync(join(REPO_ROOT, ENGINE_CORE.js.source)))
    glue[100] ^= 0x20
    writeFileSync(join(d, ENGINE_CORE.js.file), glue)
    await expectInit(
      () => loadEngine({ ...nodeModulesEnginePaths(), ocrCore: d }),
      /SHA-256 mismatch/,
      /^glue/,
      d
    )
  })

  it('gunzipTraineddata checks the .gz, then the RAW bytes after gunzip', () => {
    const raw = new TextEncoder().encode('not a model, but the bytes the entry pins')
    const gz = gzipSync(raw)
    const entry: ManifestData = {
      file: 'xx.traineddata.gz',
      source: 'none',
      bytes: gz.length,
      sha256: sha256Hex(gz),
      rawBytes: raw.length,
      rawSha256: sha256Hex(raw)
    }
    expect(gunzipTraineddata('xx', gz, entry)).toEqual(raw)
    // A .gz that matches its own hash but inflates to other bytes: only the raw check sees it.
    const other = { ...entry, rawSha256: sha256Hex(new TextEncoder().encode('other')) }
    expect(() => gunzipTraineddata('xx', gz, other)).toThrow(
      expect.objectContaining({ code: 'init', message: 'traineddata xx (raw): SHA-256 mismatch' })
    )
    expect(() => gunzipTraineddata('xx', gz, { ...entry, rawBytes: raw.length + 1 })).toThrow(
      /\(raw\): size/
    )
    // The .gz check comes first.
    const flipped = gz.slice()
    flipped[flipped.length >> 1] ^= 1
    expect(() => gunzipTraineddata('xx', flipped, entry)).toThrow(
      /^traineddata xx: SHA-256 mismatch$/
    )
    // A pinned file with a gzip header that is not a valid gzip.
    const junk = new Uint8Array([0x1f, 0x8b, 3, 4])
    expect(() =>
      gunzipTraineddata('xx', junk, { ...entry, bytes: 4, sha256: sha256Hex(junk) })
    ).toThrow(/not a valid gzip/)
    // No gzip header: it is taken as a raw .traineddata (PR9), so only the raw pins can pass it.
    const plain = new Uint8Array([1, 2, 3, 4])
    expect(() =>
      gunzipTraineddata('xx', plain, { ...entry, bytes: 4, sha256: sha256Hex(plain) })
    ).toThrow(/^traineddata xx \(raw\): size 4, expected \d+$/)
    expect(() => gunzipTraineddata('zz', gz)).toThrow(/no manifest entry for zz/)
  })

  it('the real data passes, and loadEngine stamps the manifest .gz hashes (not the raw ones)', async () => {
    const gz = new Uint8Array(readFileSync(join(REPO_ROOT, ENGINE_DATA.fra.source)))
    expect(gunzipTraineddata('fra', gz).length).toBe(ENGINE_DATA.fra.rawBytes)
    const sab = await loadTraineddataGz('fra', join(REPO_ROOT, ENGINE_DATA.fra.source))
    expect(sab.byteLength).toBe(ENGINE_DATA.fra.bytes)
    const engine = await loadEngine(nodeModulesEnginePaths())
    const want = Object.fromEntries(Object.entries(ENGINE_DATA).map(([l, d]) => [l, d.sha256]))
    expect(engine.dataHashes).toEqual(want)
    for (const [l, d] of Object.entries(ENGINE_DATA))
      expect(engine.dataHashes[l], l).not.toBe(d.rawSha256)
    expect(Object.keys(engine.assets.data).sort()).toEqual(Object.keys(ENGINE_DATA).sort())
  }, 60_000)
})

// PR9: Install from file… may keep a raw .traineddata, and downloaded languages are checked
// against the compiled catalogue. The same functions, the same hash rule.
describe('raw .traineddata files and catalogue languages', () => {
  const fraGz = (): Uint8Array =>
    new Uint8Array(readFileSync(join(REPO_ROOT, ENGINE_DATA.fra.source)))
  const fraRaw = (): Uint8Array => gunzipTraineddata('fra', fraGz())

  it('a raw file is checked against the raw size and SHA-256, and passes through gunzip as-is', async () => {
    const d = mkdtempSync(join(dir, 'raw-'))
    const raw = fraRaw()
    writeFileSync(join(d, 'fra.traineddata'), raw)
    const sab = await loadTraineddataGz('fra', join(d, 'fra.traineddata'))
    expect(sab.byteLength).toBe(ENGINE_DATA.fra.rawBytes)
    expect(sha256Hex(gunzipTraineddata('fra', new Uint8Array(sab)))).toBe(ENGINE_DATA.fra.rawSha256)
    // One identity per language whichever form is on disk: the raw file stamps the .gz hash.
    const loaded = await loadLanguage('fra', join(d, 'fra.traineddata'))
    expect(loaded.data.byteLength).toBe(ENGINE_DATA.fra.rawBytes)
    expect(loaded.sha256).toBe(ENGINE_DATA.fra.sha256)
    expect(loaded.sha256).not.toBe(ENGINE_DATA.fra.rawSha256)
    const bad = raw.slice()
    bad[bad.length >> 1] ^= 1
    writeFileSync(join(d, 'fra.traineddata'), bad)
    await expectInit(
      () => loadTraineddataGz('fra', join(d, 'fra.traineddata')),
      /SHA-256 mismatch/,
      /^traineddata fra/,
      d
    )
    expect(() => gunzipTraineddata('fra', bad)).toThrow(
      /^traineddata fra \(raw\): SHA-256 mismatch$/
    )
  })

  it('a catalogue language is held to the catalogue hashes; an unknown one is never read', async () => {
    const rus = catalogueEntry('rus')!
    expect(manifestDataFor('rus')).toMatchObject({
      bytes: rus.bytes,
      sha256: rus.sha256Gz,
      rawBytes: rus.rawBytes,
      rawSha256: rus.sha256Raw
    })
    // fra's bytes are not Russian, gzipped or raw.
    const d = mkdtempSync(join(dir, 'rus-'))
    writeFileSync(join(d, 'rus.traineddata.gz'), fraGz())
    await expectInit(
      () => loadLanguage('rus', join(d, 'rus.traineddata.gz')),
      /size \d+, expected \d+/,
      /^traineddata rus/,
      d
    )
    expect(() => gunzipTraineddata('rus', fraRaw())).toThrow(/traineddata rus \(raw\): size/)
    await expectInit(
      () => loadLanguage('ara', join(d, 'rus.traineddata.gz')),
      /no manifest entry for ara/,
      /ara/,
      d
    )
    // The bundled fra loads through the same entry point with its .gz hash.
    expect((await loadLanguage('fra', join(REPO_ROOT, ENGINE_DATA.fra.source))).sha256).toBe(
      ENGINE_DATA.fra.sha256
    )
  })
})
