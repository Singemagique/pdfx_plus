// Export of the invisible OCR text layer through the real builders (DESIGN.md §3.7.1–§3.7.5, PR3a):
// buildPdf / buildPdfx with `EditLayer.ocr`, read back from the SAVED bytes with pdf.js 5.7.284 and
// PDFium (the two shipped extractors), rendered with PDFium, and inspected with pdf-lib.

import { createHash } from 'node:crypto'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  degrees,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString
} from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'

import { loadNodeSynthDeps } from '../../../shared/ocr/test-utils/node-deps'
import {
  createPdfiumRasterizer,
  type Rasterizer
} from '../../../shared/ocr/test-utils/pdfium-raster'
import { synthesize, type SynthResult } from '../../../shared/ocr/test-utils/synth'
import { pack, type OcrPage, type PackedOcrPage } from '../../../shared/ocr/types'
import { makePageKey, type CropBox, type Overlay } from '../edit/model'
import { loadTestPdfium } from '../test-utils/pdfium'
import type { DocEntry, PageEntry } from '../types'
import { buildPdf, buildPdfx, type EditLayer } from './build'
import { compareIntegrity, integrityOf } from './canonicalize'
import { MANIFEST_NAME, type ExportPage, type PdfxManifest } from './format'
import { catalogLang, OCR_PRODUCER_SUFFIX, withOcrLayer } from './ocr-export'
import { isOcrLayerStream } from './ocr-layer'
import { readXmp } from './ocr-marking'
import { applyRedactedBytes, buildRedactedSources } from './redact-export'
import {
  allStreams,
  decodeStream,
  handPage,
  ocrPageFromGt,
  pdfiumCopyText,
  pdfiumProbe,
  pdfjsCopyText,
  pdfjsText,
  toOverlay,
  type ProbePdfium
} from './test-utils/ocr-layer'

const DPI = 96
let pdfium: ProbePdfium
let raster: Rasterizer
let scan: SynthResult

beforeAll(async () => {
  pdfium = await loadTestPdfium<ProbePdfium>()
  raster = createPdfiumRasterizer(pdfium as never)
  scan = await synthesize({ preset: 'clean300', seed: 7 }, await loadNodeSynthDeps())
})

const KEY = makePageKey('scan', 0)

const exportPage = (bytes: Uint8Array, sourceKey: string, pageIndex = 0): ExportPage => ({
  bytes,
  sourceKey,
  pageIndex
})

const edits = (over: Partial<EditLayer> = {}): EditLayer => ({
  overlays: new Map(),
  attachments: new Map(),
  ...over
})

const scanOcr = (): PackedOcrPage => pack(ocrPageFromGt(scan.gt))

async function blankPdf(
  size: [number, number] = [400, 400],
  setup?: (doc: PDFDocument) => void
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage(size)
  setup?.(doc)
  return doc.save()
}

/** Expected copy text of a hand page: words joined by one space, one line per line. */
const handText = (p: OcrPage): string => p.lines.map((l) => l.words.map((w) => w.t).join(' ')).join('\n') // prettier-ignore

/** The resolved /Contents streams of page `i`, in order (none for a page without content). */
function contents(doc: PDFDocument, i: number): PDFStream[] {
  const ctx = doc.context
  const entry = doc.getPage(i).node.get(PDFName.of('Contents'))
  if (!entry) return []
  const resolved = entry instanceof PDFRef ? ctx.lookup(entry) : entry
  const refs = resolved instanceof PDFArray ? resolved.asArray() : [entry]
  return refs.map((r) => (r instanceof PDFRef ? ctx.lookup(r, PDFStream) : (r as PDFStream)))
}

const layerStreams = (doc: PDFDocument, i: number): PDFStream[] =>
  contents(doc, i).filter(isOcrLayerStream)

async function imageHashes(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const out: string[] = []
  for (const [, obj] of doc.context.enumerateIndirectObjects())
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'))
      out.push(createHash('sha256').update(obj.getContents()).digest('hex'))
  return out.sort()
}

const catalogLangOf = async (bytes: Uint8Array): Promise<string | undefined> => {
  const v = (await PDFDocument.load(bytes)).catalog.lookup(PDFName.of('Lang'))
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined
}

function embeddedManifest(doc: PDFDocument): PdfxManifest {
  const names = doc.catalog.lookup(PDFName.of('Names'), PDFDict)
  const arr = names.lookup(PDFName.of('EmbeddedFiles'), PDFDict).lookup(PDFName.of('Names'), PDFArray) // prettier-ignore
  for (let i = 0; i < arr.size(); i += 2) {
    const key = arr.lookup(i)
    if (!(key instanceof PDFString || key instanceof PDFHexString)) continue
    if (key.decodeText() !== MANIFEST_NAME) continue
    const ef = arr.lookup(i + 1, PDFDict).lookup(PDFName.of('EF'), PDFDict)
    return JSON.parse(new TextDecoder().decode(decodeStream(ef.lookup(PDFName.of('F'), PDFStream))))
  }
  throw new Error('no manifest')
}

describe('buildPdf with an OCR layer', () => {
  let blank: Uint8Array
  let withLayer: Uint8Array
  let without: Uint8Array

  beforeAll(async () => {
    blank = await blankPdf()
    const pages = [exportPage(scan.pdfBytes, 'scan'), exportPage(blank, 'blank')]
    withLayer = await buildPdf(pages, edits({ ocr: new Map([[KEY, scanOcr()]]) }))
    without = await buildPdf(pages, edits())
  })

  it("prepends one tagged stream on the OCR'd page only, as direct page content", async () => {
    const doc = await PDFDocument.load(withLayer)
    const first = contents(doc, 0)[0]
    expect(isOcrLayerStream(first)).toBe(true)
    expect(layerStreams(doc, 0)).toHaveLength(1)
    expect(layerStreams(doc, 1)).toHaveLength(0)
    const text = new TextDecoder().decode(decodeStream(first))
    expect(text).toMatch(/^q\n/)
    expect(text).toContain('BT 3 Tr /FOcr')
    // Never a Form XObject: no XObject stream anywhere carries the layer.
    for (const { stream, data } of await allStreams(withLayer))
      if (stream.dict.get(PDFName.of('Subtype')) === PDFName.of('Form'))
        expect(new TextDecoder('latin1').decode(data)).not.toContain('PDFxOCR')
    // The page without OCR keeps exactly its original content.
    const plain = await PDFDocument.load(without)
    expect(contents(doc, 1).map(decodeStream)).toEqual(contents(plain, 1).map(decodeStream))
  })

  it('marks the layer as machine-generated in its BDC property list', async () => {
    const doc = await PDFDocument.load(withLayer)
    const text = new TextDecoder().decode(decodeStream(contents(doc, 0)[0]))
    expect(text).toContain(
      '/PDFxOCR <</Lang (en) /MachineGenerated true /Engine (test/replay)>> BDC'
    )
    expect(text.trimEnd()).toMatch(/EMC\nQ$/)
  })

  it('pdf.js and PDFium read exactly the OcrPage text', async () => {
    expect(pdfjsCopyText((await pdfjsText(withLayer, 0)).items)).toBe(scan.gt.text)
    expect(pdfiumCopyText(pdfiumProbe(pdfium, withLayer, 0))).toBe(scan.gt.text)
    // The other page stays text-free.
    expect((await pdfjsText(withLayer, 1)).items.filter((i) => i.str.trim())).toEqual([])
  })

  it('renders pixel-identical with and without the layer', () => {
    expect(raster(withLayer, DPI, 0).data).toEqual(raster(without, DPI, 0).data)
  })

  it('keeps every image stream byte-identical', async () => {
    const hashes = await imageHashes(withLayer)
    expect(hashes.length).toBeGreaterThan(0)
    expect(hashes).toEqual(await imageHashes(without))
    expect(hashes).toEqual(await imageHashes(scan.pdfBytes))
  })

  it('appends the machine-generated suffix to the Producer and writes pdfx:OCREngine to XMP', async () => {
    const doc = await PDFDocument.load(withLayer, { updateMetadata: false })
    expect(doc.getProducer()).toBe(`PDFX 1.0${OCR_PRODUCER_SUFFIX}`)
    expect(doc.getProducer()).toBe('PDFX 1.0; text layer by PDFx OCR (machine-generated)')
    const xmp = readXmp(doc)!
    expect(xmp).toContain('<pdfx:OCREngine>test/replay</pdfx:OCREngine>')
    expect(xmp).toContain('<pdf:Producer>PDFX 1.0; text layer by PDFx OCR (machine-generated)</pdf:Producer>') // prettier-ignore
    expect(xmp).toContain('xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/"')
    // XMP stays readable without a PDF parser.
    const meta = doc.catalog.lookup(PDFName.of('Metadata'), PDFStream)
    expect(meta.dict.get(PDFName.of('Filter'))).toBeUndefined()
    expect(meta.dict.get(PDFName.of('Subtype'))).toBe(PDFName.of('XML'))
  })

  it('writes no marking when no layer is written', async () => {
    const doc = await PDFDocument.load(without, { updateMetadata: false })
    expect(doc.getProducer()).toBe('PDFX 1.0')
    expect(readXmp(doc)).toBeUndefined()
    // Recognised pages that end up empty write nothing either.
    const empty = pack({ ...ocrPageFromGt(scan.gt), lines: [] })
    const out = await buildPdf(
      [exportPage(scan.pdfBytes, 'scan')],
      edits({ ocr: new Map([[KEY, empty]]) })
    )
    const reloaded = await PDFDocument.load(out, { updateMetadata: false })
    expect(reloaded.getProducer()).toBe('PDFX 1.0')
    expect(layerStreams(reloaded, 0)).toHaveLength(0)
    expect(readXmp(reloaded)).toBeUndefined()
  })

  it('keeps an existing XMP packet and only adds the property', async () => {
    const { addOcrEngineToXmp, minimalXmp } = await import('./ocr-marking')
    const base = minimalXmp('Other', 'x').replace(/<pdfx:OCREngine>x<\/pdfx:OCREngine>\n/, '')
    const added = addOcrEngineToXmp(base, 'eng/1 <&>')!
    expect(added.startsWith(base.slice(0, base.lastIndexOf('</rdf:RDF>')))).toBe(true)
    expect(added).toContain('<pdfx:OCREngine>eng/1 &lt;&amp;&gt;</pdfx:OCREngine>')
    expect(added).toContain('<pdf:Producer>Other</pdf:Producer>')
    expect(addOcrEngineToXmp('<x/>', 'e')).toBeNull()
  })

  it('bakes the layer first and the overlays last on a page that has both', async () => {
    const highlight: Overlay = {
      id: 'h',
      pageKey: KEY,
      z: 0,
      createdAt: 0,
      geom: { x: 50, y: 50, w: 100, h: 20, rotation: 0, opacity: 1 },
      type: 'highlight',
      color: { r: 1, g: 1, b: 0 }
    }
    const overlays = new Map([[KEY, [highlight]]])
    const both = await buildPdf(
      [exportPage(scan.pdfBytes, 'scan')],
      edits({ overlays, ocr: new Map([[KEY, scanOcr()]]) })
    )
    const onlyOverlay = await buildPdf([exportPage(scan.pdfBytes, 'scan')], edits({ overlays }))
    const doc = await PDFDocument.load(both)
    expect(isOcrLayerStream(contents(doc, 0)[0])).toBe(true)
    expect(layerStreams(doc, 0)).toHaveLength(1)
    expect(raster(both, DPI).data).toEqual(raster(onlyOverlay, DPI).data)
    expect(pdfjsCopyText((await pdfjsText(both)).items)).toBe(scan.gt.text)
  })

  it('creates one OCR font per output document', async () => {
    const twice = await buildPdf(
      [exportPage(scan.pdfBytes, 'scan'), exportPage(scan.pdfBytes, 'scan')],
      edits({ ocr: new Map([[KEY, scanOcr()]]) })
    )
    const doc = await PDFDocument.load(twice)
    let type0 = 0
    for (const [, obj] of doc.context.enumerateIndirectObjects())
      if (obj instanceof PDFDict && obj.get(PDFName.of('Subtype')) === PDFName.of('Type0')) type0++
    expect(type0).toBe(1)
    expect(layerStreams(doc, 0)).toHaveLength(1)
    expect(layerStreams(doc, 1)).toHaveLength(1)
  })
})

describe('catalog /Lang (§3.7.5)', () => {
  it('follows the rule', () => {
    expect(catalogLang(['de-DE', undefined, 'de-de'], ['eng'])).toBe('de-DE')
    expect(catalogLang(['de-DE', 'fr'], ['eng', 'eng'])).toBeUndefined()
    expect(catalogLang([undefined], ['deu', 'deu', undefined])).toBe('de')
    expect(catalogLang([undefined], ['deu', undefined])).toBeUndefined() // half is no majority
    expect(catalogLang([undefined], ['deu', 'fra', 'deu'])).toBeUndefined()
    expect(catalogLang([], ['xyz', 'xyz'])).toBeUndefined() // 'und' is never written
    expect(catalogLang([undefined], [undefined])).toBeUndefined()
  })

  it('keeps a source /Lang that copyPages would lose, with or without OCR', async () => {
    const de = await blankPdf([400, 400], (d) => d.setLanguage('de-DE'))
    expect(await catalogLangOf(await buildPdf([exportPage(de, 'de')], edits()))).toBe('de-DE')
    const ocr = new Map([[makePageKey('de', 0), pack(handPage([{ y: 100, size: 12, words: [{ t: 'Hallo', x: 10, w: 30 }] }]))]]) // prettier-ignore
    expect(await catalogLangOf(await buildPdf([exportPage(de, 'de')], edits({ ocr })))).toBe(
      'de-DE'
    )
  })

  it("takes the OCR language when no source declares one and OCR'd pages are the majority", async () => {
    const plain = await blankPdf()
    const page = pack(handPage([{ y: 100, size: 12, words: [{ t: 'Hallo', x: 10, w: 30 }] }], { langs: ['deu', 'eng'] })) // prettier-ignore
    const ocr = new Map([[makePageKey('a', 0), page]])
    const one = await buildPdf([exportPage(plain, 'a')], edits({ ocr }))
    expect(await catalogLangOf(one)).toBe('de')
    // The per-layer /Lang is always written.
    const doc = await PDFDocument.load(one)
    expect(new TextDecoder().decode(decodeStream(layerStreams(doc, 0)[0]))).toContain('/Lang (de)')
    // One OCR'd page of two: no majority, no catalog /Lang.
    const half = await buildPdf([exportPage(plain, 'a'), exportPage(plain, 'b')], edits({ ocr }))
    expect(await catalogLangOf(half)).toBeUndefined()
    // .pdfx follows the same rule.
    const pdfx = await buildPdfx(
      [{ name: 'A', pages: [exportPage(plain, 'a')] }],
      'T',
      edits({ ocr })
    )
    expect(await catalogLangOf(pdfx)).toBe('de')
  })
})

/** Three words on a 400×400 page: one above the crop, one across its lower edge, one below it. */
const cropPage = (): OcrPage =>
  handPage([
    { y: 300, size: 20, words: [{ t: 'Topword', x: 20, w: 90 }] },
    { y: 145, size: 20, words: [{ t: 'Edgeword', x: 20, w: 100 }] },
    { y: 50, size: 20, words: [{ t: 'Bottomqz', x: 20, w: 100 }] }
  ])
const CROP: CropBox = { x: 0, y: 150, w: 400, h: 250 }

describe('crop-outside drop', () => {
  it('drops words entirely outside the edit crop on PDF export and keeps partly visible ones', async () => {
    const src = await blankPdf()
    const key = makePageKey('c', 0)
    const out = await buildPdf(
      [exportPage(src, 'c')],
      edits({ ocr: new Map([[key, pack(cropPage())]]), crops: new Map([[key, CROP]]) })
    )
    // PDFium reports text outside the CropBox, so a baked word would come back here. (pdf.js
    // 5.7.284 skips items whose origin lies outside the view, so it never shows the edge word's
    // baseline, 5 pt under the crop [measured].)
    const doc = await PDFDocument.load(out)
    const layer = new TextDecoder().decode(decodeStream(layerStreams(doc, 0)[0]))
    expect(layer.match(/ Tm /g)).toHaveLength(2)
    expect(pdfiumCopyText(pdfiumProbe(pdfium, out))).toBe('Topword\nEdgeword')
    expect(pdfjsCopyText((await pdfjsText(out)).items)).toBe('Topword')
    // 'q' and 'z' occur only in the dropped word: no font table carries them (rule 5).
    for (const { data } of await allStreams(out)) {
      const s = new TextDecoder('latin1').decode(data)
      expect(s).not.toContain('Bottomqz')
      if (s.includes('begincmap')) {
        expect(s).not.toMatch(/<0071>/i)
        expect(s).not.toMatch(/<007A>/i)
      }
    }
  })

  it('keeps every word in .pdfx, where the crop stays a live mirror edit', async () => {
    const src = await blankPdf()
    const key = makePageKey('c', 0)
    const out = await buildPdfx(
      [{ name: 'C', pages: [exportPage(src, 'c')] }],
      'T',
      edits({ ocr: new Map([[key, pack(cropPage())]]), crops: new Map([[key, CROP]]) })
    )
    expect(pdfjsCopyText((await pdfjsText(out)).items)).toBe(handText(cropPage()))
    expect(embeddedManifest(await PDFDocument.load(out)).edits?.[0].crop).toEqual(CROP)
  })
})

describe('rotation and crop', () => {
  // A /Rotate 90 page whose MediaBox starts away from (0, 0): unrotated 400×600 at (10, 20), so the
  // overlay frame (what the editor and the OCR engine see) is 600 wide and 400 tall.
  let rotated: Uint8Array
  const page = handPage([
    { y: 300, size: 16, x0: 40, words: [{ t: 'Rotated', x: 0, w: 70 }, { t: 'page', x: 80, w: 40 }] }, // prettier-ignore
    { y: 60, size: 16, x0: 400, words: [{ t: 'Corner', x: 0, w: 60 }] }
  ])
  const key = makePageKey('r', 0)
  const ocr = (): Map<string, PackedOcrPage> => new Map([[key, pack(page)]])

  beforeAll(async () => {
    rotated = await blankPdf([400, 600], (d) => {
      const p = d.getPage(0)
      p.setMediaBox(10, 20, 400, 600)
      p.setRotation(degrees(90))
    })
  })

  /** Every pdf.js item's baseline origin, in user space and in the overlay frame. */
  async function origins(
    bytes: Uint8Array
  ): Promise<{ str: string; user: number[]; frame: number[] }[]> {
    const t = await pdfjsText(bytes)
    return t.items
      .filter((i) => i.str.trim())
      .map((i) => ({ str: i.str, user: [i.transform[4], i.transform[5]], frame: toOverlay(t, i.transform[4], i.transform[5]) })) // prettier-ignore
  }

  it('places words at their overlay-frame position on a /Rotate 90 page with an offset MediaBox', async () => {
    const out = await buildPdf([exportPage(rotated, 'r')], edits({ ocr: ocr() }))
    expect(pdfjsCopyText((await pdfjsText(out)).items)).toBe(handText(page))
    // PDFium breaks lines between the words of a quarter-turned page ("Rotated\n page\n\nCorner"
    // [measured]: its own line inference for vertical baselines, as in the layer suite's rot90page),
    // so only the words and their order are compared.
    const words = (s: string): string => s.replace(/\s+/g, ' ').trim()
    expect(words(pdfiumCopyText(pdfiumProbe(pdfium, out)))).toBe(words(handText(page)))
    const got = await origins(out)
    const want = page.lines.flatMap((l) => l.words)
    expect(got.map((g) => g.str)).toEqual(want.map((w) => w.t))
    got.forEach((g, i) => {
      expect(g.frame[0]).toBeCloseTo(want[i].x, 2)
      expect(g.frame[1]).toBeCloseTo(want[i].y, 2)
    })
  })

  it('an edit rotation changes only /Rotate: the words keep their user-space position', async () => {
    const base = await buildPdf([exportPage(rotated, 'r')], edits({ ocr: ocr() }))
    const turned = await buildPdf(
      [exportPage(rotated, 'r')],
      edits({ ocr: ocr(), rotations: new Map([[key, 90]]) })
    )
    expect((await PDFDocument.load(turned)).getPage(0).getRotation().angle).toBe(180)
    expect(pdfjsCopyText((await pdfjsText(turned)).items)).toBe(handText(page))
    const a = await origins(base)
    const b = await origins(turned)
    expect(b.map((o) => o.str)).toEqual(a.map((o) => o.str))
    b.forEach((o, i) => {
      expect(o.user[0]).toBeCloseTo(a[i].user[0], 3)
      expect(o.user[1]).toBeCloseTo(a[i].user[1], 3)
    })
  })

  it('an edit crop on the rotated page drops the words it hides, in the overlay frame', async () => {
    // Visual left half (x < 300): keeps "Rotated page" (x 40–160), hides "Corner" (x 400–460).
    const out = await buildPdf(
      [exportPage(rotated, 'r')],
      edits({ ocr: ocr(), crops: new Map([[key, { x: 0, y: 0, w: 300, h: 400 }]]) })
    )
    expect(pdfjsCopyText((await pdfjsText(out)).items)).toBe('Rotated page')
    const kept = await origins(out)
    const base = await origins(await buildPdf([exportPage(rotated, 'r')], edits({ ocr: ocr() })))
    kept.forEach((o, i) => expect(o.user).toEqual(base[i].user))
  })
})

describe('.pdfx round trip', () => {
  let out: Uint8Array

  beforeAll(async () => {
    out = await buildPdfx(
      [{ name: 'Scan', pages: [exportPage(scan.pdfBytes, 'scan')] }],
      'Scans',
      edits({ ocr: new Map([[KEY, scanOcr()]]), rotations: new Map([[KEY, 90]]) })
    )
  })

  it('bakes the tagged layer and keeps rotation in the mirror', async () => {
    const doc = await PDFDocument.load(out, { updateMetadata: false })
    expect(isOcrLayerStream(contents(doc, 0)[0])).toBe(true)
    expect(doc.getPage(0).getRotation().angle).toBe(0)
    expect(embeddedManifest(doc).edits?.[0].rotation).toBe(90)
    expect(doc.getProducer()).toBe(`PDFX 1.1${OCR_PRODUCER_SUFFIX}`)
    expect(readXmp(doc)).toContain('<pdfx:OCREngine>test/replay</pdfx:OCREngine>')
  })

  it('reopens searchable, with its integrity record intact', async () => {
    expect(pdfjsCopyText((await pdfjsText(out)).items)).toBe(scan.gt.text)
    const record = embeddedManifest(await PDFDocument.load(out)).integrity
    expect(compareIntegrity(await integrityOf(out), record).tampered).toBe(false)
    expect(raster(out, DPI).data).toEqual(raster(scan.pdfBytes, DPI).data)
  })

  it('covers the layer with the pdfx-canon/1 hash', async () => {
    const doc = await PDFDocument.load(out, { updateMetadata: false })
    const record = embeddedManifest(doc).integrity
    // Change one shown character of the layer: the recomputed record no longer matches.
    const layer = contents(doc, 0)[0]
    const text = new TextDecoder().decode(decodeStream(layer))
    const tampered = text.replace(/<([0-9A-F]{4})/, (_, cid: string) => `<${cid === '0001' ? '0002' : '0001'}`) // prettier-ignore
    expect(tampered).not.toBe(text)
    const ref = (doc.getPage(0).node.Contents() as PDFArray).get(0) as PDFRef
    doc.context.assign(ref, doc.context.flateStream(new TextEncoder().encode(tampered), { PDFxOCRLayer: true })) // prettier-ignore
    const edited = await doc.save()
    expect(compareIntegrity(await integrityOf(edited), record).tampered).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
// Redaction safety until PR3b: a page with any redaction gets no OCR layer at all.

/** A secret whose characters occur nowhere else in the export. */
const SECRET = '机密档案'
const SECRET_CPS = [...SECRET].map((c) => c.codePointAt(0)!)

/** Every encoding of the secret an extractor or a reader of the raw file could find. */
function leaks(hay: Uint8Array): string[] {
  const latin1 = new TextDecoder('latin1').decode(hay)
  const found: string[] = []
  if (Buffer.from(hay).includes(Buffer.from(SECRET, 'utf8'))) found.push('utf-8')
  if (Buffer.from(hay).includes(Buffer.from(SECRET, 'utf16le').swap16())) found.push('utf-16be')
  for (const cp of SECRET_CPS) {
    const hex = cp.toString(16).toUpperCase().padStart(4, '0')
    if (new RegExp(`<${hex}>`, 'i').test(latin1)) found.push(`cmap ${hex}`)
  }
  return found
}

describe('redacted pages get no OCR layer (fail-safe until PR3b)', () => {
  const redKey = makePageKey('secret', 0)
  const redaction: Overlay = {
    id: 'r',
    pageKey: redKey,
    z: 0,
    createdAt: 0,
    geom: { x: 300, y: 300, w: 50, h: 20, rotation: 0, opacity: 1 }, // far from the word
    type: 'redaction',
    fill: { r: 0, g: 0, b: 0 }
  }
  const secretPage = (): PackedOcrPage =>
    pack(handPage([{ y: 100, size: 20, words: [{ t: SECRET, x: 20, w: 80 }] }], { langs: ['chi_sim'] })) // prettier-ignore

  let secretPdf: Uint8Array
  let docs: DocEntry[]

  beforeAll(async () => {
    secretPdf = await blankPdf()
    const entry = (id: string, bytes: Uint8Array, w: number, h: number): PageEntry => ({
      id,
      source: {
        id,
        bytes,
        pdf: {
          getPage: async () => ({ rotate: 0, view: [0, 0, w, h] })
        } as unknown as PDFDocumentProxy
      },
      pageIndex: 0,
      width: w,
      height: h
    })
    const [sw, sh] = [scan.gt.page.width, scan.gt.page.height]
    docs = [{ id: 'd', name: 'D', pages: [entry('scan', scan.pdfBytes, sw, sh), entry('secret', secretPdf, 400, 400)] }] // prettier-ignore
  })

  /** Export like useExport: redaction pass, then the layer, then the builder. */
  async function exportAll(kind: 'pdf' | 'pdfx', bypassWithOcrLayer = false): Promise<Uint8Array> {
    const editLayer = edits({ overlays: new Map([[redKey, [redaction]]]) })
    const ocr = new Map([
      [KEY, scanOcr()],
      [redKey, secretPage()]
    ])
    const redacted = await buildRedactedSources(editLayer, docs, pdfium)
    const layer = bypassWithOcrLayer ? { ...editLayer, ocr } : withOcrLayer(editLayer, ocr)
    const pages = applyRedactedBytes(
      docs[0].pages.map((p) => exportPage(p.source.bytes, p.source.id)),
      redacted
    )
    return kind === 'pdf' ? buildPdf(pages, layer) : buildPdfx([{ name: 'D', pages }], 'T', layer)
  }

  it.each([
    ['pdf', false],
    ['pdfx', false],
    ['pdf (layer handed to buildPdf directly)', true],
    ['pdfx (layer handed to buildPdfx directly)', true]
  ] as const)(
    '%s: the secret is in no extractor and nowhere in the bytes',
    async (name, bypass) => {
      const out = await exportAll(name.startsWith('pdfx') ? 'pdfx' : 'pdf', bypass)
      const doc = await PDFDocument.load(out, { updateMetadata: false })
      // The unredacted page keeps its layer; the redacted one has none.
      expect(layerStreams(doc, 0)).toHaveLength(1)
      expect(layerStreams(doc, 1)).toHaveLength(0)
      expect(pdfjsCopyText((await pdfjsText(out, 0)).items)).toBe(scan.gt.text)
      for (const i of [0, 1]) {
        expect(pdfjsCopyText((await pdfjsText(out, i)).items)).not.toContain(SECRET[0])
        expect(pdfiumCopyText(pdfiumProbe(pdfium, out, i))).not.toContain(SECRET[0])
      }
      // Raw-bytes oracle: the file itself, then every stream inflated (content, CMaps, XMP, manifest).
      expect(leaks(out)).toEqual([])
      for (const { data } of await allStreams(out)) expect(leaks(data)).toEqual([])
      // Not even as a language tag of a layer that was never written.
      expect(new TextDecoder('latin1').decode(out)).not.toContain('zh-Hans')
    }
  )

  it('control: the oracle and both extractors do find the secret when the page is not redacted', async () => {
    const out = await buildPdf(
      [exportPage(secretPdf, 'secret')],
      edits({ ocr: new Map([[redKey, secretPage()]]) })
    )
    expect(pdfjsCopyText((await pdfjsText(out)).items)).toBe(SECRET)
    expect(pdfiumCopyText(pdfiumProbe(pdfium, out))).toBe(SECRET)
    const found = (await allStreams(out)).flatMap(({ data }) => leaks(data))
    expect(found).toEqual(expect.arrayContaining(SECRET_CPS.map((cp) => `cmap ${cp.toString(16).toUpperCase()}`))) // prettier-ignore
  })

  it('withOcrLayer drops the page for a redaction overlay or a removed-object report entry', () => {
    const ocr = new Map([
      [KEY, scanOcr()],
      [redKey, secretPage()]
    ])
    const plain = edits()
    expect([...withOcrLayer(plain, ocr).ocr!.keys()]).toEqual([KEY, redKey])
    expect([...withOcrLayer(edits({ overlays: new Map([[redKey, [redaction]]]) }), ocr).ocr!.keys()]).toEqual([KEY]) // prettier-ignore
    expect([...withOcrLayer(plain, ocr, new Map([[KEY, []]])).ocr!.keys()]).toEqual([redKey])
    expect(withOcrLayer(plain, new Map([[redKey, secretPage()]]), new Map([[redKey, [{}]]])).ocr).toBeUndefined() // prettier-ignore
    expect(withOcrLayer({ ...plain, ocr }, undefined).ocr).toBeUndefined()
    // A copy: the input layer is never changed.
    expect(plain.ocr).toBeUndefined()
  })
})
