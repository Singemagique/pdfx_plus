// PR3c (DESIGN.md §3.5.2, §3.7.2, §3.7.6): the .pdfx OCR provenance record, lossless Replace /
// Remove of PDFx's own layer on a reopened export (and the PDFium fallback for a layer whose
// streams a later rewrite merged), idempotent re-export measured with the app's own Find over
// pdf.js, the undoable `ocrSelect` op, and a 1.1.3 reader (frozen copies) opening the new .pdfx.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  type PDFRef,
  type PDFStream
} from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  createPdfiumRasterizer,
  type Rasterizer
} from '../../../shared/ocr/test-utils/pdfium-raster'
import { pack, type PackedOcrPage } from '../../../shared/ocr/types'
import { emptyEditState, selectOcrInHistory, type EditState } from '../edit/edit-history'
import { initHistory, redo, undo, type History } from '../edit/history'
import { makePageKey } from '../edit/model'
import { applyOcrSelections, type PageResults } from '../ocr/ocr-select'
import { extractPageText } from '../search/extract'
import { compileQuery, findAll, normalizeQuery } from '../search/normalize'
import { loadTestPdfium, withDoc } from '../test-utils/pdfium'
import { buildPdf, buildPdfx, type EditLayer } from './build'
import { compareIntegrity, integrityOf } from './canonicalize'
import {
  readManifest,
  readOcrProvenance,
  partitionPages,
  type ExportPage,
  type PdfxManifest
} from './format'
import { OCR_PRODUCER_SUFFIX, withOcrLayer } from './ocr-export'
import {
  existingOcrLayer,
  hasMergedOcrText,
  isOcrLayerStream,
  pageContentStreams
} from './ocr-layer'
import { embeddedManifest, placeProvenance } from './ocr-provenance'
import { redactPdf, stripOcrText, type PdfiumModule } from './redact'
import {
  readManifest as readManifest113,
  partitionPages as partitionPages113
} from './test-utils/legacy/format-1.1.3'
import { deserializeMirror as deserializeMirror113 } from './test-utils/legacy/mirror-1.1.3'
import { allStreams, decodeStream, handPage, type ProbePdfium } from './test-utils/ocr-layer'
import type { DocEntry } from '../types'
import type { PDFDocumentProxy } from 'pdfjs-dist'

const DPI = 72
let pdfium: ProbePdfium
let raster: Rasterizer
/** A 400×400 page with native Helvetica text ("Native heading") near its top. */
let base: Uint8Array

beforeAll(async () => {
  pdfium = await loadTestPdfium<ProbePdfium>()
  raster = createPdfiumRasterizer(pdfium as never)
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([400, 400]).drawText('Native heading', { x: 20, y: 350, size: 18, font })
  doc.addPage([400, 400]).drawText('Second page', { x: 20, y: 350, size: 18, font })
  base = await doc.save()
})

const HASH_ENG = 'e'.repeat(64)
const HASH_DEU = 'd'.repeat(64)

/** What the first recognition read: 'Alpha Beta'. */
const oldOcr = (): PackedOcrPage =>
  pack(handPage([{ y: 200, size: 20, words: [{ t: 'Alpha', x: 20, w: 60 }, { t: 'Beta', x: 100, w: 50 }] }], // prettier-ignore
    { engineId: 'test/old', dataHashes: { eng: HASH_ENG }, langs: ['eng'], pipelineVersion: 3 })) // prettier-ignore
/** A Replace with other languages: the same words plus one the first run missed. */
const newOcr = (): PackedOcrPage =>
  pack(handPage([{ y: 200, size: 20, words: [{ t: 'Alpha', x: 20, w: 60 }, { t: 'Beta', x: 100, w: 50 }, { t: 'Delta', x: 170, w: 60 }] }], // prettier-ignore
    { engineId: 'test/new', dataHashes: { eng: HASH_ENG, deu: HASH_DEU }, langs: ['deu', 'eng'], pipelineVersion: 4 })) // prettier-ignore

const exportPage = (bytes: Uint8Array, sourceKey: string, pageIndex = 0): ExportPage => ({
  bytes,
  sourceKey,
  pageIndex
})

const editLayer = (over: Partial<EditLayer> = {}): EditLayer => ({
  overlays: new Map(),
  attachments: new Map(),
  ...over
})

/** A PDFium loader that must not be called (the lossless path needs no PDFium). */
const noPdfium = async (): Promise<PdfiumModule> => {
  throw new Error('PDFium was loaded')
}

/**
 * Export the way useExport does (no redactions here): the store's results, with the layer's
 * `ocrSelect` choices applied (`applyOcrSelections`, what `snapshotFor` does), through
 * `withOcrLayer`, then the build. Page `p` of every source is exported as page key (source, p).
 */
async function exportAs(
  kind: 'pdf' | 'pdfx',
  pages: ExportPage[],
  layer: EditLayer,
  store: ReadonlyMap<string, PageResults> = new Map(),
  opts: { include?: boolean; pdfium?: PdfiumModule | (() => Promise<PdfiumModule>) } = {}
): Promise<Uint8Array> {
  const include = opts.include ?? true
  const ocr = include ? applyOcrSelections(store, layer.ocrSelect) : undefined
  const built = withOcrLayer(layer, ocr, { include, removed: new Map() })
  const pdfiumOpt = { pdfium: opts.pdfium ?? (pdfium as unknown as PdfiumModule) }
  return kind === 'pdf'
    ? buildPdf(pages, built, pdfiumOpt)
    : buildPdfx([{ name: 'Doc', pages }], 'Doc', built, pdfiumOpt)
}

/** First generation: `base` page 0 recognised as 'Alpha Beta' (oldOcr), page 1 without OCR. */
async function firstGeneration(kind: 'pdf' | 'pdfx'): Promise<Uint8Array> {
  const store = new Map([[makePageKey('g1', 0), { results: new Map([['cfg-old', oldOcr()]]), auto: 'cfg-old' }]]) // prettier-ignore
  return exportAs(kind, [exportPage(base, 'g1', 0), exportPage(base, 'g1', 1)], editLayer(), store)
}

/** The app's Find over pdf.js: number of hits of `query` on page `i` (search/engine's pipeline). */
async function hits(bytes: Uint8Array, query: string, i = 0): Promise<number> {
  const pdf = (await getDocument({ data: bytes.slice(), verbosity: 0 }).promise) as unknown as PDFDocumentProxy // prettier-ignore
  try {
    const text = await extractPageText(pdf, i)
    return findAll(text.norm, compileQuery(normalizeQuery(query))!, 1000).length / 2
  } finally {
    await pdf.destroy()
  }
}

const tagged = (doc: PDFDocument, i = 0): PDFStream[] => existingOcrLayer(doc.getPage(i)).streams
const fontBound = (doc: PDFDocument, i = 0): boolean => existingOcrLayer(doc.getPage(i)).font

/** The raw (still encoded) bytes of page `i`'s content streams that are not OCR layers. */
function otherStreams(doc: PDFDocument, i = 0): string[] {
  return pageContentStreams(doc.getPage(i))
    .filter((s) => !isOcrLayerStream(s))
    .map((s) =>
      createHash('sha256')
        .update((s as PDFRawStream).getContents())
        .digest('hex')
    )
}

/** The engine named by page `i`'s tagged layer(s). */
const layerEngines = (doc: PDFDocument, i = 0): string[] =>
  tagged(doc, i).map((s) => /\/Engine \(([^)]*)\)/.exec(new TextDecoder('latin1').decode(decodeStream(s)))?.[1] ?? '?') // prettier-ignore

/** Text objects on page 0 that PDFium reports inside a `/PDFxOCR` marked-content sequence. */
function markedOcrObjects(bytes: Uint8Array): number {
  return withDoc(pdfium, bytes, (doc) => {
    const rt = pdfium.pdfium
    const page = pdfium.FPDF_LoadPage(doc, 0)
    const buf = rt.wasmExports.malloc(256)
    let n = 0
    try {
      for (let i = 0; i < pdfium.FPDFPage_CountObjects(page); i++) {
        const obj = pdfium.FPDFPage_GetObject(page, i)
        if (pdfium.FPDFPageObj_GetType(obj) !== 1) continue
        for (let m = 0; m < pdfium.FPDFPageObj_CountMarks(obj); m++) {
          const mark = pdfium.FPDFPageObj_GetMark(obj, m)
          if (!pdfium.FPDFPageObjMark_GetName(mark, buf, 200, buf + 200)) continue
          if (rt.UTF16ToString(buf) === 'PDFxOCR') {
            n++
            break
          }
        }
      }
    } finally {
      rt.wasmExports.free(buf)
      pdfium.FPDF_ClosePage(page)
    }
    return n
  })
}

async function noOcrBytes(bytes: Uint8Array): Promise<void> {
  for (const { data } of await allStreams(bytes))
    expect(new TextDecoder('latin1').decode(data)).not.toMatch(/PDFxOCR(?!Layer)|PDFxOCR-GlyphLess/)
}

// ---------------------------------------------------------------------------------------------

describe('.pdfx OCR provenance (format.ts `ocr`)', () => {
  let out: Uint8Array
  let manifest: PdfxManifest
  const words = ['Alpha', 'Beta', 'Delta']

  beforeAll(async () => {
    // Two documents: A = [base#0 (old OCR)], B = [base#1 (none), base#0 copy as another source (new OCR)].
    const store = new Map<string, PageResults>([
      [makePageKey('a', 0), { results: new Map([['cfg-old', oldOcr()]]), auto: 'cfg-old' }],
      [makePageKey('b', 0), { results: new Map([['cfg-new', newOcr()]]), auto: 'cfg-new' }]
    ])
    const ocr = applyOcrSelections(store, undefined)
    const layer = withOcrLayer(editLayer({ rotations: new Map([[makePageKey('c', 1), 90]]) }), ocr, { include: true, removed: new Map() }) // prettier-ignore
    out = await buildPdfx(
      [
        { name: 'A', pages: [exportPage(base, 'a', 0)] },
        { name: 'Empty', pages: [] },
        { name: 'B', pages: [exportPage(base, 'c', 1), exportPage(base, 'b', 0)] }
      ],
      'Set',
      layer,
      { pdfium: noPdfium }
    )
    manifest = embeddedManifest(await PDFDocument.load(out))!
  })

  it('records engine, data hashes, languages and pipeline per OCR page, by (doc, page)', () => {
    expect(manifest.ocr).toEqual({
      v: 1,
      pages: [
        { doc: 0, page: 0, engineId: 'test/old', dataHashes: { eng: HASH_ENG }, langs: ['eng'], pipelineVersion: 3 }, // prettier-ignore
        { doc: 1, page: 1, engineId: 'test/new', dataHashes: { eng: HASH_ENG, deu: HASH_DEU }, langs: ['deu', 'eng'], pipelineVersion: 4 } // prettier-ignore
      ]
    })
    // The version is not raised for it (a mirror edit raises it to 1.1 as before).
    expect(manifest.pdfx).toBe('1.1')
  })

  it('carries no word of the layer: provenance only', () => {
    const json = JSON.stringify(manifest)
    for (const w of words) expect(json).not.toContain(w)
    for (const key of ['text', 'wordOff', 'wordGeom', 'lines', 'conf', 'confCal'])
      expect(json).not.toContain(`"${key}"`)
  })

  it('the layers are baked inside the pdfx-canon/1 record, and the file reopens verified', async () => {
    const doc = await PDFDocument.load(out)
    expect(tagged(doc, 0)).toHaveLength(1)
    expect(tagged(doc, 1)).toHaveLength(0)
    expect(tagged(doc, 2)).toHaveLength(1)
    expect(compareIntegrity(await integrityOf(out), manifest.integrity).tampered).toBe(false)
    // The record covers the layers: the same export without OCR hashes the OCR pages differently
    // and the other page identically.
    const plain = await buildPdfx(
      [
        { name: 'A', pages: [exportPage(base, 'a', 0)] },
        { name: 'B', pages: [exportPage(base, 'c', 1), exportPage(base, 'b', 0)] }
      ],
      'Set',
      editLayer()
    )
    const a = manifest.integrity!.pageHashes
    const b = (await integrityOf(plain)).pageHashes
    expect([a[0] === b[0], a[1] === b[1], a[2] === b[2]]).toEqual([false, true, false])
    // Reopened with the app's reader (pdf.js), the provenance validates and maps to page indices.
    const pdf = (await getDocument({ data: out.slice(), verbosity: 0 }).promise) as unknown as PDFDocumentProxy // prettier-ignore
    try {
      const read = await readManifest(pdf)
      expect(partitionPages(read, 3, 'x').map((p) => p.indices)).toEqual([[0], [1, 2]])
      expect([...readOcrProvenance(read).keys()]).toEqual([0, 2])
      expect(readOcrProvenance(read).get(2)?.engineId).toBe('test/new')
    } finally {
      await pdf.destroy()
    }
    expect(await hits(out, 'Alpha', 0)).toBe(1)
    expect(await hits(out, 'Delta', 2)).toBe(1)
  })

  it('a 1.1.3 reader (frozen readManifest, partitionPages, deserializeMirror) ignores the new key', async () => {
    const pdf = (await getDocument({ data: out.slice(), verbosity: 0 }).promise) as unknown as PDFDocumentProxy // prettier-ignore
    try {
      const read = await readManifest113(pdf)
      expect(read).not.toBeNull()
      expect(read!.documents).toEqual([
        { name: 'A', pages: 1 },
        { name: 'B', pages: 2 }
      ])
      expect(partitionPages113(read, 3, 'x')).toEqual([
        { name: 'A', indices: [0] },
        { name: 'B', indices: [1, 2] }
      ])
      // Its mirror reader still restores the edits (the rotation of B's first page).
      const docs = [
        { id: 'A', name: 'A', pages: [{ id: 'p0', source: { id: 's0' }, pageIndex: 0 }] },
        { id: 'B', name: 'B', pages: [{ id: 'p1', source: { id: 's1' }, pageIndex: 1 }, { id: 'p2', source: { id: 's1' }, pageIndex: 2 }] } // prettier-ignore
      ] as unknown as DocEntry[]
      expect(deserializeMirror113(read!, docs)?.rotations).toEqual([[makePageKey('s1', 1), 90]])
    } finally {
      await pdf.destroy()
    }
  })

  it.each([
    ['format-1.1.3.ts', 'af923bafd546ff094aa6e2da5cebb11995e958f0', [["'../../../edit/model'", "'../edit/model'"], ["'../../canonicalize'", "'./canonicalize'"], ["'../../build'", "'./build'"]]], // prettier-ignore
    ['mirror-1.1.3.ts', '47a9f999b2ac29514a1f3a89d1496668e0c0528f', [["'../../../edit/model'", "'../edit/model'"], ["'../../../types'", "'../types'"], ["'../../flatten'", "'./flatten'"], ["'../../build'", "'./build'"], ["'./format-1.1.3'", "'./format'"]]] // prettier-ignore
  ] as const)(
    'the frozen %s is the file at 6d5ed16 (its git blob id), import paths aside',
    (name, blobId, paths) => {
      let text = readFileSync(fileURLToPath(new URL(`./test-utils/legacy/${name}`, import.meta.url)), 'utf8') // prettier-ignore
      for (const [now, then] of paths) {
        expect(text).toContain(`from ${now}`)
        text = text.replace(`from ${now}`, `from ${then}`)
      }
      const file = Buffer.from(text, 'utf8')
      const blob = createHash('sha1').update(`blob ${file.length}\0`).update(file).digest('hex')
      expect(blob).toBe(blobId)
    }
  )

  it('readOcrProvenance validates the untrusted record', () => {
    // Global page indices: A = 0..1, B = 2, C = 3..6.
    const m = (ocr: unknown): PdfxManifest =>
      ({ pdfx: '1.0', documents: [{ name: 'A', pages: 2 }, { name: 'B', pages: 1 }, { name: 'C', pages: 4 }], ocr }) as PdfxManifest // prettier-ignore
    expect(readOcrProvenance(null).size).toBe(0)
    expect(readOcrProvenance(m(undefined)).size).toBe(0)
    expect(readOcrProvenance(m({ v: 2, pages: [{ doc: 0, page: 0, engineId: 'x' }] })).size).toBe(0) // prettier-ignore
    expect(readOcrProvenance(m({ v: 1, pages: 'no' })).size).toBe(0)
    const long = 'x'.repeat(256)
    const read = readOcrProvenance(m({
      v: 1,
      pages: [
        { doc: 1, page: 0, engineId: 'e', dataHashes: { eng: 'h' }, langs: ['eng'], pipelineVersion: 2 },
        { doc: 0, page: 1, engineId: 'e2', dataHashes: [1], langs: 'eng', pipelineVersion: -1 },
        { doc: 0, page: 2, engineId: 'off the doc' },
        // Past doc 0's end onto a page nothing else claims (C's first page, global 3): rejected by
        // the bounds check itself, not by the duplicate rule.
        { doc: 0, page: 3, engineId: 'past the end' },
        { doc: 3, page: 0, engineId: 'no such doc' },
        { doc: 0, page: 0, engineId: '' },
        { doc: 1, page: 0, engineId: 'duplicate' },
        { doc: 0, page: 0.5, engineId: 'fraction' },
        // At the bounds: 256 characters and 32 languages pass.
        { doc: 0, page: 0, engineId: long, langs: Array(32).fill('eng'), dataHashes: { [long]: long } },
        // Elements of the right container type but the wrong kind, or one past the bounds: dropped.
        { doc: 2, page: 1, engineId: 'h', dataHashes: { eng: 7 }, langs: ['eng', 3] },
        { doc: 2, page: 2, engineId: 'x'.repeat(257) },
        { doc: 2, page: 3, engineId: 'l', dataHashes: { ['k'.repeat(257)]: 'h' }, langs: Array(33).fill('eng') },
        null,
        'x'
      ]
    })) // prettier-ignore
    expect([...read.entries()]).toEqual([
      [2, { doc: 1, page: 0, engineId: 'e', dataHashes: { eng: 'h' }, langs: ['eng'], pipelineVersion: 2 }], // prettier-ignore
      [1, { doc: 0, page: 1, engineId: 'e2' }],
      [0, { doc: 0, page: 0, engineId: long, langs: Array(32).fill('eng'), dataHashes: { [long]: long } }], // prettier-ignore
      [4, { doc: 2, page: 1, engineId: 'h' }],
      [6, { doc: 2, page: 3, engineId: 'l' }]
    ])
  })

  it('placeProvenance maps an output ordinal to its (doc, page), at document boundaries too', () => {
    const p = { engineId: 'e' }
    expect([0, 1, 2, 3].map((o) => placeProvenance(p, o, [1, 2]))).toEqual([
      { doc: 0, page: 0, engineId: 'e' },
      { doc: 1, page: 0, engineId: 'e' },
      { doc: 1, page: 1, engineId: 'e' },
      null
    ])
  })

  it("the first page of a later document is recorded as that document's page 0", async () => {
    const store = new Map([[makePageKey('y', 1), { results: new Map([['c', oldOcr()]]), auto: 'c' }]]) // prettier-ignore
    const layer = withOcrLayer(editLayer(), applyOcrSelections(store, undefined), { include: true, removed: new Map() }) // prettier-ignore
    const out = await buildPdfx(
      [
        { name: 'A', pages: [exportPage(base, 'x', 0)] },
        { name: 'B', pages: [exportPage(base, 'y', 1)] }
      ],
      'Set',
      layer,
      { pdfium: noPdfium }
    )
    const doc = await PDFDocument.load(out)
    expect([tagged(doc, 0).length, tagged(doc, 1).length]).toEqual([0, 1])
    expect(embeddedManifest(doc)?.ocr?.pages.map(({ doc, page }) => ({ doc, page }))).toEqual([{ doc: 1, page: 0 }]) // prettier-ignore
  })

  it('a result that bakes no layer (no word survives cleaning) records no provenance', async () => {
    const ghost = pack(handPage([{ y: 200, size: 20, words: [{ t: 'Ghost', x: 20, w: 0 }] }], { engineId: 'test/ghost', langs: ['eng'] })) // prettier-ignore
    const store = new Map([[makePageKey('z', 0), { results: new Map([['c', ghost]]), auto: 'c' }]])
    const layer = withOcrLayer(editLayer(), applyOcrSelections(store, undefined), { include: true, removed: new Map() }) // prettier-ignore
    // The page does reach the bake: the result has a word, it just cleans to nothing.
    expect(layer.ocr?.has(makePageKey('z', 0))).toBe(true)
    const out = await buildPdfx([{ name: 'Doc', pages: [exportPage(base, 'z', 0)] }], 'Doc', layer, { pdfium: noPdfium }) // prettier-ignore
    const doc = await PDFDocument.load(out)
    expect(tagged(doc)).toHaveLength(0)
    expect(embeddedManifest(doc)?.ocr).toBeUndefined()
  })

  it.each([
    ['pdfx', { engineId: 'test/old', dataHashes: { eng: HASH_ENG }, langs: ['eng'], pipelineVersion: 3 }], // prettier-ignore
    ['pdf', { engineId: 'test/old' }]
  ] as const)(
    'a layer kept on re-export of a reopened %s keeps its record (what the source knew of it)',
    async (firstKind, expected) => {
      const first = await firstGeneration(firstKind)
      const out = await exportAs('pdfx', [exportPage(first, 'r', 0), exportPage(first, 'r', 1)], editLayer(), new Map(), { pdfium: noPdfium }) // prettier-ignore
      expect(embeddedManifest(await PDFDocument.load(out))?.ocr).toEqual({ v: 1, pages: [{ doc: 0, page: 0, ...expected }] }) // prettier-ignore
      // Removed: no record.
      const removed = await exportAs('pdfx', [exportPage(first, 'r', 0)], editLayer({ ocrSelect: new Map([[makePageKey('r', 0), null]]) }), new Map(), { pdfium: noPdfium }) // prettier-ignore
      expect(embeddedManifest(await PDFDocument.load(removed))?.ocr).toBeUndefined()
    }
  )
})

// ---------------------------------------------------------------------------------------------

describe('a kept layer keeps only a source record that still describes it', () => {
  const by = (engineId: string, lang: string): PackedOcrPage =>
    pack(handPage([{ y: 200, size: 20, words: [{ t: 'Alpha', x: 20, w: 60 }] }], { engineId, dataHashes: { [lang]: HASH_ENG }, langs: [lang], pipelineVersion: 3 })) // prettier-ignore
  const recordOf = (engineId: string, lang: string): object => ({ engineId, dataHashes: { [lang]: HASH_ENG }, langs: [lang], pipelineVersion: 3 }) // prettier-ignore

  /** A .pdfx of `base`'s two pages, page 0 recognised as `a`, page 1 as `b`. */
  async function twoLayers(a: PackedOcrPage, b: PackedOcrPage): Promise<Uint8Array> {
    const store = new Map([
      [makePageKey('t', 0), { results: new Map([['c', a]]), auto: 'c' }],
      [makePageKey('t', 1), { results: new Map([['c', b]]), auto: 'c' }]
    ])
    return exportAs('pdfx', [exportPage(base, 't', 0), exportPage(base, 't', 1)], editLayer(), store, { pdfium: noPdfium }) // prettier-ignore
  }

  /** The `ocr` record of `bytes` re-exported as .pdfx with no OCR choice (both layers kept). */
  async function reexported(bytes: Uint8Array): Promise<unknown> {
    const out = await exportAs('pdfx', [exportPage(bytes, 'r', 0), exportPage(bytes, 'r', 1)], editLayer(), new Map(), { pdfium: noPdfium }) // prettier-ignore
    return embeddedManifest(await PDFDocument.load(out))?.ocr
  }

  /** `bytes` with its first two pages swapped in the page tree by "another tool", manifest kept. */
  async function swapped(bytes: Uint8Array): Promise<Uint8Array> {
    const doc = await PDFDocument.load(bytes)
    const kids = doc.catalog.Pages().Kids()
    const [a, b] = [kids.get(0), kids.get(1)]
    kids.set(0, b)
    kids.set(1, a)
    return doc.save()
  }

  /** `bytes` with its embedded manifest replaced by `edit(manifest)`, the pages untouched. */
  async function editedManifest(
    bytes: Uint8Array,
    edit: (m: PdfxManifest) => PdfxManifest
  ): Promise<Uint8Array> {
    const doc = await PDFDocument.load(bytes)
    const tree = doc.catalog.lookup(PDFName.of('Names'), PDFDict).lookup(PDFName.of('EmbeddedFiles'), PDFDict) // prettier-ignore
    const spec = tree.lookup(PDFName.of('Names'), PDFArray).lookup(1, PDFDict)
    const ref = spec.lookup(PDFName.of('EF'), PDFDict).get(PDFName.of('F')) as PDFRef
    const json = new TextEncoder().encode(JSON.stringify(edit(embeddedManifest(doc)!)))
    doc.context.assign(ref, doc.context.flateStream(json, { Type: 'EmbeddedFile' }))
    return doc.save()
  }

  const tampered = async (bytes: Uint8Array): Promise<boolean> =>
    compareIntegrity(await integrityOf(bytes), embeddedManifest(await PDFDocument.load(bytes))!.integrity).tampered // prettier-ignore

  it('control: an untouched source keeps both records', async () => {
    const first = await twoLayers(by('test/a', 'eng'), by('test/b', 'deu'))
    expect(await reexported(first)).toEqual({ v: 1, pages: [{ doc: 0, page: 0, ...recordOf('test/a', 'eng') }, { doc: 0, page: 1, ...recordOf('test/b', 'deu') }] }) // prettier-ignore
  })

  it("pages swapped by another tool, manifest kept: no page takes the other's record", async () => {
    const moved = await swapped(await twoLayers(by('test/a', 'eng'), by('test/b', 'deu')))
    expect(await tampered(moved)).toBe(true)
    const doc = await PDFDocument.load(moved)
    expect([layerEngines(doc, 0), layerEngines(doc, 1)]).toEqual([['test/b'], ['test/a']])
    expect(await reexported(moved)).toEqual({ v: 1, pages: [{ doc: 0, page: 0, engineId: 'test/b' }, { doc: 0, page: 1, engineId: 'test/a' }] }) // prettier-ignore
  })

  it('the same engine on both swapped pages: the pdfx-canon/1 page hash alone drops the records', async () => {
    const moved = await swapped(await twoLayers(by('test/a', 'eng'), by('test/a', 'deu')))
    expect(await tampered(moved)).toBe(true)
    expect(await reexported(moved)).toEqual({ v: 1, pages: [{ doc: 0, page: 0, engineId: 'test/a' }, { doc: 0, page: 1, engineId: 'test/a' }] }) // prettier-ignore
  })

  it('a record naming another engine than the layer (content untouched): only the layer engine is kept', async () => {
    const first = await twoLayers(by('test/a', 'eng'), by('test/b', 'deu'))
    const edited = await editedManifest(first, (m) => ({ ...m, ocr: { v: 1, pages: m.ocr!.pages.map((p) => (p.page === 0 ? { ...p, engineId: 'test/zzz' } : p)) } })) // prettier-ignore
    // The manifest is outside the hash: the integrity check cannot see this edit.
    expect(await tampered(edited)).toBe(false)
    expect(await reexported(edited)).toEqual({ v: 1, pages: [{ doc: 0, page: 0, engineId: 'test/a' }, { doc: 0, page: 1, ...recordOf('test/b', 'deu') }] }) // prettier-ignore
  })
})

// ---------------------------------------------------------------------------------------------

describe('Replace / Remove of the layer of a reopened PDFx export (tagged streams, lossless)', () => {
  const KINDS = [
    ['pdf', 'pdf'],
    ['pdf', 'pdfx'],
    ['pdfx', 'pdf'],
    ['pdfx', 'pdfx']
  ] as const
  const key = makePageKey('r', 0)
  /** What the store holds for the reopened page after "Replace Recognized Text…" (default: skip). */
  const replaced = (): Map<string, PageResults> =>
    new Map([[key, { results: new Map([['cfg-new', newOcr()]]) }]])
  const reopenedPages = (first: Uint8Array): ExportPage[] => [exportPage(first, 'r', 0), exportPage(first, 'r', 1)] // prettier-ignore

  it.each(KINDS)(
    '%s → %s, no choice: the layer is kept once; re-export is idempotent',
    async (a, b) => {
      const first = await firstGeneration(a)
      expect(await hits(first, 'Alpha')).toBe(1)
      const second = await exportAs(b, reopenedPages(first), editLayer(), replaced(), { pdfium: noPdfium }) // prettier-ignore
      const third = await exportAs(b, reopenedPages(second), editLayer(), new Map(), { pdfium: noPdfium }) // prettier-ignore
      for (const bytes of [second, third]) {
        expect(await hits(bytes, 'Alpha')).toBe(1)
        expect(await hits(bytes, 'Delta')).toBe(0)
        expect(await hits(bytes, 'Native')).toBe(1)
        const doc = await PDFDocument.load(bytes)
        expect(tagged(doc)).toHaveLength(1)
        expect(layerEngines(doc)).toEqual(['test/old'])
      }
    }
  )

  it.each(KINDS)(
    '%s → %s, Replace: one new layer, the hit count unchanged, the rest byte-exact',
    async (a, b) => {
      const first = await firstGeneration(a)
      const select = editLayer({ ocrSelect: new Map([[key, 'cfg-new']]) })
      const out = await exportAs(b, reopenedPages(first), select, replaced(), { pdfium: noPdfium })
      expect(await hits(out, 'Alpha')).toBe(1)
      expect(await hits(out, 'Beta')).toBe(1)
      expect(await hits(out, 'Delta')).toBe(1)
      expect(await hits(out, 'Native')).toBe(1)
      const doc = await PDFDocument.load(out)
      expect(tagged(doc)).toHaveLength(1)
      expect(layerEngines(doc)).toEqual(['test/new'])
      expect(isOcrLayerStream(pageContentStreams(doc.getPage(0))[0])).toBe(true)
      // Every other content stream of the page is the source's, byte for byte (still encoded).
      expect(otherStreams(doc)).toEqual(otherStreams(await PDFDocument.load(first)))
      // The page without OCR is untouched.
      expect(otherStreams(doc, 1)).toEqual(otherStreams(await PDFDocument.load(first), 1))
      // Exported once more without a choice: still one layer, still one hit.
      const again = await exportAs(b, reopenedPages(out), editLayer(), new Map(), { pdfium: noPdfium }) // prettier-ignore
      expect(await hits(again, 'Alpha')).toBe(1)
      expect(await hits(again, 'Delta')).toBe(1)
    }
  )

  it.each(KINDS)(
    '%s → %s, Remove: no layer, no font, no hit; the rest byte-exact',
    async (a, b) => {
      const first = await firstGeneration(a)
      const select = editLayer({ ocrSelect: new Map([[key, null]]) })
      const out = await exportAs(b, reopenedPages(first), select, replaced(), { pdfium: noPdfium })
      expect(await hits(out, 'Alpha')).toBe(0)
      expect(await hits(out, 'Beta')).toBe(0)
      expect(await hits(out, 'Native')).toBe(1)
      const doc = await PDFDocument.load(out, { updateMetadata: false })
      expect(tagged(doc)).toHaveLength(0)
      expect(fontBound(doc)).toBe(false)
      expect(otherStreams(doc)).toEqual(otherStreams(await PDFDocument.load(first)))
      expect(doc.getProducer()).not.toContain(OCR_PRODUCER_SUFFIX)
      await noOcrBytes(out)
      expect(raster(out, DPI, 0).data).toEqual(raster(first, DPI, 0).data)
    }
  )
})

// ---------------------------------------------------------------------------------------------

describe('the merged-stream fallback (no tagged stream; the PDFxOCR mark is still there)', () => {
  const key = makePageKey('m', 0)
  let merged: Uint8Array
  const store = (): Map<string, PageResults> =>
    new Map([[key, { results: new Map([['cfg-new', newOcr()]]) }]])
  const pages = (): ExportPage[] => [exportPage(merged, 'm', 0), exportPage(merged, 'm', 1)]

  beforeAll(async () => {
    // A rewrite that regenerates page 0's content (PDFium, nothing removed: the box is off the
    // page) merges the tagged layer stream into the page's other content.
    merged = redactPdf(pdfium, await firstGeneration('pdfx'), [{ pageIndex: 0, rects: [{ x: -50, y: -50, w: 1, h: 1 }] }]) // prettier-ignore
  })

  it('control: the layer is merged, still found once, and its text objects keep the mark', async () => {
    const doc = await PDFDocument.load(merged)
    expect(tagged(doc)).toHaveLength(0)
    expect(fontBound(doc)).toBe(true)
    expect(hasMergedOcrText(doc.getPage(0))).toBe(true)
    expect(hasMergedOcrText(doc.getPage(1))).toBe(false)
    expect(await hits(merged, 'Alpha')).toBe(1)
    // 'Alpha', 'Beta' and the stretched spaces: one Tj each.
    expect(markedOcrObjects(merged)).toBeGreaterThanOrEqual(2)
  })

  it.each(['pdf', 'pdfx'] as const)(
    '%s, Replace: PDFium removes the old layer, then one new layer',
    async (kind) => {
      const out = await exportAs(kind, pages(), editLayer({ ocrSelect: new Map([[key, 'cfg-new']]) }), store()) // prettier-ignore
      expect(await hits(out, 'Alpha')).toBe(1)
      expect(await hits(out, 'Delta')).toBe(1)
      expect(await hits(out, 'Native')).toBe(1)
      const doc = await PDFDocument.load(out)
      expect(tagged(doc)).toHaveLength(1)
      expect(layerEngines(doc)).toEqual(['test/new'])
      expect(hasMergedOcrText(doc.getPage(0))).toBe(false)
      // Nothing visible went with the old layer.
      expect(raster(out, DPI, 0).data).toEqual(raster(merged, DPI, 0).data)
    }
  )

  it.each(['pdf', 'pdfx'] as const)(
    '%s, Remove: no OCR text, mark or font left; the page looks the same',
    async (kind) => {
      const out = await exportAs(kind, pages(), editLayer({ ocrSelect: new Map([[key, null]]) }), store()) // prettier-ignore
      expect(await hits(out, 'Alpha')).toBe(0)
      expect(await hits(out, 'Native')).toBe(1)
      expect(await hits(out, 'Second', 1)).toBe(1)
      const doc = await PDFDocument.load(out, { updateMetadata: false })
      expect(tagged(doc)).toHaveLength(0)
      expect(fontBound(doc)).toBe(false)
      expect(markedOcrObjects(out)).toBe(0)
      expect(doc.getProducer()).not.toContain(OCR_PRODUCER_SUFFIX)
      await noOcrBytes(out)
      expect(raster(out, DPI, 0).data).toEqual(raster(merged, DPI, 0).data)
    }
  )

  it('with recognised text excluded (setting off), the merged layer goes too', async () => {
    const out = await exportAs('pdf', pages(), editLayer(), store(), { include: false })
    expect(await hits(out, 'Alpha')).toBe(0)
    expect(await hits(out, 'Native')).toBe(1)
    await noOcrBytes(out)
  })

  it('no choice: the merged layer is kept as it is, and PDFium is not even loaded', async () => {
    const out = await exportAs('pdf', pages(), editLayer(), store(), { pdfium: noPdfium })
    expect(await hits(out, 'Alpha')).toBe(1)
    expect(await hits(out, 'Delta')).toBe(0)
  })

  it('stripOcrText regenerates only the pages that carry OCR text, and unbinds the font', async () => {
    const { bytes, removed } = stripOcrText(pdfium, merged, [0, 1])
    expect(removed.get(0)).toBeGreaterThanOrEqual(2)
    expect(removed.get(1)).toBe(0)
    const doc = await PDFDocument.load(bytes)
    expect(hasMergedOcrText(doc.getPage(0))).toBe(false)
    // GenerateContent dropped the font no text object uses any more from the page's resources.
    expect(fontBound(doc)).toBe(false)
    expect(await hits(bytes, 'Native')).toBe(1)
  })

  it('the mark alone identifies the layer: marked text in another font goes, unmarked text stays', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const page = doc.addPage([400, 400])
    page.node.newFontDictionary('MF', font.ref)
    const content = [
      'BT /MF 18 Tf 20 300 Td (Kept) Tj ET',
      '/PDFxOCR <</MachineGenerated true>> BDC BT 3 Tr /MF 18 Tf 20 100 Td (Marked) Tj ET EMC'
    ].join('\n')
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)))
    const bytes = await doc.save()
    const before = await PDFDocument.load(bytes)
    expect(fontBound(before)).toBe(false)
    expect(hasMergedOcrText(before.getPage(0))).toBe(true)
    const { bytes: out, removed } = stripOcrText(pdfium, bytes, [0])
    expect(removed.get(0)).toBe(1)
    expect(await hits(out, 'Kept')).toBe(1)
    expect(await hits(out, 'Marked')).toBe(0)
  })

  it('a PDFium failure fails the export instead of keeping a removed layer', async () => {
    await expect(
      exportAs('pdf', pages(), editLayer({ ocrSelect: new Map([[key, null]]) }), store(), { pdfium: noPdfium }) // prettier-ignore
    ).rejects.toThrow(/Export failed on page 1.*PDFium was loaded/)
  })

  it('the font alone identifies the layer: merged OCR text that lost its marks is found and removed', async () => {
    // The merged page's content with every `/PDFxOCR … BDC` / `EMC` pair taken out: a rewrite that
    // dropped the marked-content tags but kept the text in the bound PDFxOCR-GlyphLess font.
    const doc = await PDFDocument.load(merged)
    const page = doc.getPage(0)
    const text = pageContentStreams(page).map((s) => new TextDecoder('latin1').decode(decodeStream(s))).join('\n') // prettier-ignore
    const unmarked = text.replace(/\/PDFxOCR\s*(?:<<[^]*?>>|\/\w+)\s*BDC/g, '').replace(/\bEMC\b/g, '') // prettier-ignore
    expect(unmarked).not.toBe(text)
    expect(unmarked).not.toMatch(/PDFxOCR/)
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(unmarked)))
    const bytes = await doc.save()
    expect(markedOcrObjects(bytes)).toBe(0)
    const before = await PDFDocument.load(bytes)
    expect(tagged(before)).toHaveLength(0)
    expect(fontBound(before)).toBe(true)
    expect(hasMergedOcrText(before.getPage(0))).toBe(true)
    expect(await hits(bytes, 'Alpha')).toBe(1)
    const { removed } = stripOcrText(pdfium, bytes, [0])
    expect(removed.get(0)).toBeGreaterThanOrEqual(2)
    const unmarkedPages = [exportPage(bytes, 'm', 0), exportPage(bytes, 'm', 1)]
    const out = await exportAs('pdf', unmarkedPages, editLayer({ ocrSelect: new Map([[key, null]]) }), store()) // prettier-ignore
    expect(await hits(out, 'Alpha')).toBe(0)
    expect(await hits(out, 'Native')).toBe(1)
    expect(fontBound(await PDFDocument.load(out))).toBe(false)
    await noOcrBytes(out)
  })

  it('a strip that leaves OCR text behind fails the export (the check after the drop)', async () => {
    // A PDFium that sees no mark and no font name: stripOcrText runs but removes nothing.
    const blind = new Proxy(pdfium, {
      get: (t, k, r) =>
        k === 'FPDFPageObj_CountMarks' || k === 'FPDFFont_GetBaseFontName'
          ? () => 0
          : Reflect.get(t, k, r)
    }) as unknown as PdfiumModule
    expect(stripOcrText(blind, merged, [0]).removed.get(0)).toBe(0)
    for (const kind of ['pdf', 'pdfx'] as const)
      await expect(
        exportAs(kind, pages(), editLayer({ ocrSelect: new Map([[key, null]]) }), store(), { pdfium: blind }) // prettier-ignore
      ).rejects.toThrow(/Export failed on page 1.*could not remove the recognized text/)
  })

  it('a merged source after a page of another file: only that source is rewritten', async () => {
    const otherDoc = await PDFDocument.create()
    const font = await otherDoc.embedFont(StandardFonts.Helvetica)
    otherDoc.addPage([400, 400]).drawText('Other page', { x: 20, y: 350, size: 18, font })
    const other = await otherDoc.save()
    const out = await exportAs('pdf', [exportPage(other, 'o', 0), exportPage(merged, 'm', 0)], editLayer({ ocrSelect: new Map([[key, null]]) }), store()) // prettier-ignore
    expect([await hits(out, 'Other', 0), await hits(out, 'Native', 0)]).toEqual([1, 0])
    expect([await hits(out, 'Native', 1), await hits(out, 'Other', 1), await hits(out, 'Alpha', 1)]).toEqual([1, 0, 0]) // prettier-ignore
    expect(raster(out, DPI, 1).data).toEqual(raster(merged, DPI, 0).data)
    await noOcrBytes(out)
  })

  it('a dropped page whose OCR font is still bound but drawn by nothing loses the binding', async () => {
    // A rewrite that removed the layer's stream but left its font in the page's resources: no
    // tagged stream and no text to strip, so neither pdf-lib's drop nor PDFium unbinds it.
    const doc = await PDFDocument.load(await firstGeneration('pdf'))
    const page = doc.getPage(0)
    const contents = doc.context.lookup(page.node.get(PDFName.of('Contents'))) as PDFArray
    page.node.set(PDFName.of('Contents'), doc.context.obj(contents.asArray().filter((r) => !isOcrLayerStream(doc.context.lookup(r))))) // prettier-ignore
    const bytes = await doc.save()
    const before = await PDFDocument.load(bytes)
    expect([tagged(before).length, fontBound(before), hasMergedOcrText(before.getPage(0))]).toEqual([0, true, false]) // prettier-ignore
    const out = await exportAs('pdf', [exportPage(bytes, 'f', 0)], editLayer({ ocrSelect: new Map([[makePageKey('f', 0), null]]) }), new Map(), { pdfium: noPdfium }) // prettier-ignore
    expect(fontBound(await PDFDocument.load(out))).toBe(false)
    expect(await hits(out, 'Native')).toBe(1)
    await noOcrBytes(out)
  })
})

// ---------------------------------------------------------------------------------------------

describe('a layer another tool wrapped into a Form XObject with the page', () => {
  const key = makePageKey('w', 0)
  const store = (): Map<string, PageResults> =>
    new Map([[key, { results: new Map([['cfg-new', newOcr()]]) }]])
  const pagesOf = (bytes: Uint8Array): ExportPage[] => [exportPage(bytes, 'w', 0), exportPage(bytes, 'w', 1)] // prettier-ignore
  /** Every page drawn from a Form XObject (pdf-lib embedPdf + drawPage, as N-up and stamping do). */
  let wrapped: Uint8Array
  /** Wrapped twice: the layer sits in a form inside a form. */
  let nested: Uint8Array

  async function wrapInForms(bytes: Uint8Array): Promise<Uint8Array> {
    const src = await PDFDocument.load(bytes)
    const doc = await PDFDocument.create()
    for (const e of await doc.embedPdf(bytes, src.getPageIndices()))
      doc.addPage([e.width, e.height]).drawPage(e)
    return doc.save()
  }

  beforeAll(async () => {
    wrapped = await wrapInForms(await firstGeneration('pdfx'))
    nested = await wrapInForms(wrapped)
  })

  it('control: no tagged stream or font on the page; a form carries the layer (once or nested)', async () => {
    for (const bytes of [wrapped, nested]) {
      const doc = await PDFDocument.load(bytes)
      expect([tagged(doc).length, fontBound(doc)]).toEqual([0, false])
      expect(existingOcrLayer(doc.getPage(0)).forms).toHaveLength(1)
      expect(hasMergedOcrText(doc.getPage(0))).toBe(true)
      expect(hasMergedOcrText(doc.getPage(1))).toBe(false)
      expect(await hits(bytes, 'Alpha')).toBe(1)
    }
    expect(stripOcrText(pdfium, wrapped, [0]).removed.get(0)).toBeGreaterThanOrEqual(2)
  })

  it.each(['pdf', 'pdfx'] as const)(
    '%s, Replace: the old layer goes from the form, one new layer',
    async (kind) => {
      const out = await exportAs(kind, pagesOf(wrapped), editLayer({ ocrSelect: new Map([[key, 'cfg-new']]) }), store()) // prettier-ignore
      expect(await hits(out, 'Alpha')).toBe(1)
      expect(await hits(out, 'Beta')).toBe(1)
      expect(await hits(out, 'Delta')).toBe(1)
      expect(await hits(out, 'Native')).toBe(1)
      const doc = await PDFDocument.load(out)
      expect(tagged(doc)).toHaveLength(1)
      expect(layerEngines(doc)).toEqual(['test/new'])
      expect(hasMergedOcrText(doc.getPage(0))).toBe(false)
      expect(existingOcrLayer(doc.getPage(0)).forms).toHaveLength(0)
      expect(raster(out, DPI, 0).data).toEqual(raster(wrapped, DPI, 0).data)
    }
  )

  it.each(['pdf', 'pdfx'] as const)(
    '%s, Remove: no OCR text, mark or font left in the form; the page looks the same',
    async (kind) => {
      const out = await exportAs(kind, pagesOf(wrapped), editLayer({ ocrSelect: new Map([[key, null]]) }), store()) // prettier-ignore
      expect(await hits(out, 'Alpha')).toBe(0)
      expect(await hits(out, 'Beta')).toBe(0)
      expect(await hits(out, 'Native')).toBe(1)
      expect(await hits(out, 'Second', 1)).toBe(1)
      const doc = await PDFDocument.load(out, { updateMetadata: false })
      expect([tagged(doc).length, fontBound(doc)]).toEqual([0, false])
      expect(existingOcrLayer(doc.getPage(0)).forms).toHaveLength(0)
      expect(doc.getProducer()).not.toContain(OCR_PRODUCER_SUFFIX)
      await noOcrBytes(out)
      expect(raster(out, DPI, 0).data).toEqual(raster(wrapped, DPI, 0).data)
    }
  )

  it('a form nested in a form, which PDFium does not rewrite: Replace and Remove fail the export', async () => {
    // What PDFium can do there: nothing is removed (see stripOcrText).
    expect(stripOcrText(pdfium, nested, [0]).removed.get(0)).toBe(0)
    for (const kind of ['pdf', 'pdfx'] as const)
      for (const choice of ['cfg-new', null])
        await expect(
          exportAs(kind, pagesOf(nested), editLayer({ ocrSelect: new Map([[key, choice]]) }), store()) // prettier-ignore
        ).rejects.toThrow(/Export failed on page 1.*could not remove the recognized text/)
  })

  it('no choice: the wrapped layer is kept once, its engine read from the form, the output marked', async () => {
    const out = await exportAs('pdf', pagesOf(wrapped), editLayer(), new Map(), { pdfium: noPdfium }) // prettier-ignore
    expect(await hits(out, 'Alpha')).toBe(1)
    const doc = await PDFDocument.load(out, { updateMetadata: false })
    expect(doc.getProducer()).toContain(OCR_PRODUCER_SUFFIX)
    const pdfx = await exportAs('pdfx', pagesOf(wrapped), editLayer(), new Map(), { pdfium: noPdfium }) // prettier-ignore
    // The wrapper did not keep the source manifest: only the layer's own engine is known.
    expect(embeddedManifest(await PDFDocument.load(pdfx))?.ocr).toEqual({ v: 1, pages: [{ doc: 0, page: 0, engineId: 'test/old' }] }) // prettier-ignore
  })
})

// ---------------------------------------------------------------------------------------------

describe('undo / redo of Replace and Remove (the ocrSelect history op)', () => {
  const layerOf = (h: History<EditState>): EditLayer =>
    editLayer({ ocrSelect: new Map(Object.entries(h.present.ocrSelect)) })

  it("a reopened page: Replace, Remove, undo, undo, redo each export the state's choice", async () => {
    const first = await firstGeneration('pdfx')
    const key = makePageKey('u', 0)
    const store = new Map([[key, { results: new Map([['cfg-new', newOcr()]]) }]])
    const pages = [exportPage(first, 'u', 0)]
    /** [hits of Alpha, hits of Delta] of an export of `h`. */
    const state = async (h: History<EditState>): Promise<[number, number]> => {
      const out = await exportAs('pdfx', pages, layerOf(h), store, { pdfium: noPdfium })
      return [await hits(out, 'Alpha'), await hits(out, 'Delta')]
    }
    const h0 = initHistory(emptyEditState())
    const h1 = selectOcrInHistory(h0, key, 'cfg-new') // Replace
    const h2 = selectOcrInHistory(h1, key, null) // Remove
    expect(h2.past).toHaveLength(2)
    expect(await state(h0)).toEqual([1, 0]) // the reopened page's own layer
    expect(await state(h1)).toEqual([1, 1]) // the new layer, once
    expect(await state(h2)).toEqual([0, 0]) // none
    const u1 = undo(h2)
    expect(u1.present.ocrSelect).toEqual({ [key]: 'cfg-new' })
    expect(await state(u1)).toEqual([1, 1])
    const u2 = undo(u1)
    expect(u2.present.ocrSelect).toEqual({})
    expect(await state(u2)).toEqual([1, 0])
    const r1 = redo(u2)
    expect(await state(r1)).toEqual([1, 1])
    expect(await state(redo(r1))).toEqual([0, 0])
  })

  it('a scanned page: Remove then undo brings the automatic result back', async () => {
    const key = makePageKey('s', 1)
    const store = new Map([[key, { results: new Map([['cfg-old', oldOcr()], ['cfg-new', newOcr()]]), auto: 'cfg-old' }]]) // prettier-ignore
    const exportHits = async (h: History<EditState>): Promise<[number, number]> => {
      const out = await exportAs('pdf', [exportPage(base, 's', 1)], layerOf(h), store, { pdfium: noPdfium }) // prettier-ignore
      return [await hits(out, 'Alpha'), await hits(out, 'Delta')]
    }
    const h0 = initHistory(emptyEditState())
    const removed = selectOcrInHistory(h0, key, null)
    expect(await exportHits(h0)).toEqual([1, 0])
    expect(await exportHits(removed)).toEqual([0, 0])
    expect(await exportHits(undo(removed))).toEqual([1, 0])
    const replacedH = selectOcrInHistory(h0, key, 'cfg-new')
    expect(await exportHits(replacedH)).toEqual([1, 1])
    expect(await exportHits(undo(replacedH))).toEqual([1, 0])
  })

  it('choosing what a page already has records no step', () => {
    const key = makePageKey('n', 0)
    const h1 = selectOcrInHistory(initHistory(emptyEditState()), key, null)
    expect(selectOcrInHistory(h1, key, null)).toBe(h1)
  })
})

// ---------------------------------------------------------------------------------------------

describe('applyOcrSelections (what snapshotFor applies)', () => {
  const p = oldOcr()
  const q = newOcr()
  const pages = new Map<string, PageResults>([
    [
      'auto',
      {
        results: new Map([
          ['c1', p],
          ['c2', q]
        ]),
        auto: 'c1'
      }
    ],
    ['ours', { results: new Map([['c2', q]]) }],
    ['missing', { results: new Map([['c1', p]]), auto: 'c1' }]
  ])

  it('takes the automatic result, the chosen one, or none', () => {
    expect([...applyOcrSelections(pages, undefined)!.entries()]).toEqual([['auto', p], ['missing', p]]) // prettier-ignore
    const chosen = applyOcrSelections(pages, new Map([['auto', 'c2'], ['ours', 'c2'], ['missing', 'c9']])) // prettier-ignore
    expect([...chosen!.entries()]).toEqual([
      ['auto', q],
      ['ours', q]
    ])
    expect(
      applyOcrSelections(
        pages,
        new Map([
          ['auto', null],
          ['missing', null]
        ])
      )
    ).toBeUndefined()
    // A Remove on one page leaves the others' defaults alone.
    const snap = applyOcrSelections(pages, new Map([['auto', null]]))!
    expect([...snap.keys()]).toEqual(['missing'])
  })
})
