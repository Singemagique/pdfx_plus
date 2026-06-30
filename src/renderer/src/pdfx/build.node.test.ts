import { describe, expect, it } from 'vitest'
import { unzlibSync } from 'fflate'
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFStream,
  PDFString,
  degrees
} from 'pdf-lib'

import { buildPdf, buildPdfx, type EditLayer } from './build'
import { MANIFEST_NAME, partitionPages, stripExtension } from './format'
import type { ExportDocument, ExportPage, PdfxManifest } from './format'
import { deserializeMirror } from './mirror'
import { integrityOf } from './canonicalize'
import { makePageKey, type Overlay } from '../edit/model'

// Build a tiny standalone single-page PDF we can use as an import source.
async function makeSourcePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([200, 200])
  return doc.save()
}

// A PDF whose page carries an (empty) signature-field widget plus a regular text-field widget.
async function makeSourceWithSigField(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([300, 300])
  const ctx = doc.context
  const sig = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      T: PDFString.of('Signature1'),
      Rect: [50, 50, 250, 110],
      P: page.ref
    })
  )
  const txt = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Tx',
      T: PDFString.of('Name'),
      Rect: [50, 150, 250, 180],
      P: page.ref
    })
  )
  page.node.set(PDFName.of('Annots'), ctx.obj([sig, txt]))
  doc.catalog.set(
    PDFName.of('AcroForm'),
    ctx.register(ctx.obj({ Fields: [sig, txt], SigFlags: 3 }))
  )
  return doc.save()
}

// The /FT values of all widget annotations across the output's pages.
async function annotFieldTypes(out: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(out)
  const types: string[] = []
  for (const page of doc.getPages()) {
    const annots = page.node.Annots()
    if (!annots) continue
    for (let i = 0; i < annots.size(); i++) {
      const d = doc.context.lookupMaybe(annots.get(i), PDFDict)
      const ft = d?.get(PDFName.of('FT'))
      if (ft) types.push(ft.toString())
    }
  }
  return types
}

// Decode a stream's bytes, inflating if pdf-lib FlateDecode'd it (it may, when saving
// with object streams) and returning raw bytes otherwise — robust to the choice.
function streamBytes(stream: PDFStream): Uint8Array {
  const raw = (stream as PDFRawStream).getContents()
  const filter = stream.dict.lookup(PDFName.of('Filter'))
  return filter && String(filter).includes('FlateDecode') ? unzlibSync(raw) : raw
}

// Decode a page's content stream(s) to a single operator string (whitespace-normalized),
// inflating Flate as needed — used to assert which graphics operators were emitted.
function pageContent(pdf: PDFDocument, i: number): string {
  const page = pdf.getPage(i)
  const resolved = pdf.context.lookup(page.node.get(PDFName.of('Contents')))
  const streams =
    resolved instanceof PDFArray
      ? resolved.asArray().map((ref) => pdf.context.lookup(ref))
      : [resolved]
  let out = ''
  for (const s of streams) {
    if (s instanceof PDFStream) out += new TextDecoder('latin1').decode(streamBytes(s)) + '\n'
  }
  return out.replace(/\s+/g, ' ')
}

const HIGHLIGHT = (pageKey: string): Overlay => ({
  id: 'h',
  pageKey,
  z: 0,
  createdAt: 0,
  geom: { x: 10, y: 20, w: 30, h: 40, rotation: 0, opacity: 0.4 },
  type: 'highlight',
  color: { r: 1, g: 0.9, b: 0.2 }
})

// Recover the embedded 'pdfx-manifest.json' bytes from saved PDFX bytes by walking the
// catalog's EmbeddedFiles name tree (Names -> EmbeddedFiles -> Names = [name, filespec, ...]).
// Typed lookups resolve indirect references; robust unlike a raw byte-substring search.
function extractEmbeddedFile(pdf: PDFDocument, wanted: string): Uint8Array | null {
  const names = pdf.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)
  if (!names) return null
  const embeddedFiles = names.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict)
  if (!embeddedFiles) return null
  const arr = embeddedFiles.lookupMaybe(PDFName.of('Names'), PDFArray)
  if (!arr) return null
  for (let i = 0; i < arr.size(); i += 2) {
    const key = arr.lookup(i)
    const name = key instanceof PDFString || key instanceof PDFHexString ? key.decodeText() : ''
    if (name !== wanted) continue
    const fileSpec = arr.lookup(i + 1, PDFDict)
    const ef = fileSpec.lookup(PDFName.of('EF'), PDFDict)
    const stream = ef.lookup(PDFName.of('F'), PDFStream)
    return streamBytes(stream)
  }
  return null
}

describe('buildPdfx', () => {
  it('concatenates pages and embeds a manifest describing document boundaries', async () => {
    const bytes = await makeSourcePdf()
    const documents: ExportDocument[] = [
      {
        name: 'NDA',
        pages: [
          { bytes, sourceKey: 'a', pageIndex: 0 },
          { bytes, sourceKey: 'a', pageIndex: 0 }
        ]
      },
      {
        name: 'Invoice',
        pages: [{ bytes, sourceKey: 'a', pageIndex: 0 }]
      }
    ]
    const expectedPages = documents.reduce((n, d) => n + d.pages.length, 0)

    const out = await buildPdfx(documents, 'Contract')
    const reloaded = await PDFDocument.load(out)

    // Page count equals the sum of every document's page count.
    expect(reloaded.getPageCount()).toBe(expectedPages)

    // The manifest is embedded under the exact required name.
    const manifestBytes = extractEmbeddedFile(reloaded, MANIFEST_NAME)
    expect(manifestBytes).not.toBeNull()

    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes!)) as PdfxManifest
    expect(manifest.pdfx).toBe('1.0')
    expect(manifest.title).toBe('Contract')
    expect(manifest.documents).toEqual([
      { name: 'NDA', pages: 2 },
      { name: 'Invoice', pages: 1 }
    ])
  })

  it('embeds a pdfx-canon/1 integrity record that matches the assembled content', async () => {
    const bytes = await makeSourcePdf()
    const documents: ExportDocument[] = [
      { name: 'A', pages: [{ bytes, sourceKey: 'a', pageIndex: 0 }] }
    ]
    const out = await buildPdfx(documents, 'X')
    const manifest = JSON.parse(
      new TextDecoder().decode(extractEmbeddedFile(await PDFDocument.load(out), MANIFEST_NAME)!)
    ) as PdfxManifest
    expect(manifest.integrity?.canonAlg).toBe('pdfx-canon/1')
    // Recomputing over the EXPORTED bytes matches the stored hash (the manifest is excluded).
    const actual = await integrityOf(out)
    expect(actual.flattenedSha256).toBe(manifest.integrity?.flattenedSha256)
  })

  it('skips documents with no pages', async () => {
    const bytes = await makeSourcePdf()
    const documents: ExportDocument[] = [
      { name: 'Empty', pages: [] },
      { name: 'Real', pages: [{ bytes, sourceKey: 'a', pageIndex: 0 }] }
    ]
    const out = await buildPdfx(documents, 'X')
    const reloaded = await PDFDocument.load(out)
    expect(reloaded.getPageCount()).toBe(1)

    const manifest = JSON.parse(
      new TextDecoder().decode(extractEmbeddedFile(reloaded, MANIFEST_NAME)!)
    ) as PdfxManifest
    expect(manifest.documents).toEqual([{ name: 'Real', pages: 1 }])
  })
})

describe('buildPdfx v1.1 mirror', () => {
  it('embeds an editable mirror that deserializes back to the overlays + rotation', async () => {
    const bytes = await makeSourcePdf()
    const pageKey = makePageKey('a', 0)
    const overlay: Overlay = {
      id: 'o1',
      pageKey,
      z: 0,
      createdAt: 0,
      geom: { x: 10, y: 20, w: 30, h: 40, rotation: 0, opacity: 0.4 },
      type: 'highlight',
      color: { r: 1, g: 0.9, b: 0.2 }
    }
    const editLayer: EditLayer = {
      overlays: new Map([[pageKey, [overlay]]]),
      attachments: new Map(),
      rotations: new Map([[pageKey, 90]])
    }
    const documents: ExportDocument[] = [
      { name: 'A', pages: [{ bytes, sourceKey: 'a', pageIndex: 0 }] }
    ]

    const out = await buildPdfx(documents, 'Project', editLayer)
    const reloaded = await PDFDocument.load(out)
    const manifest = JSON.parse(
      new TextDecoder().decode(extractEmbeddedFile(reloaded, MANIFEST_NAME)!)
    ) as PdfxManifest

    expect(manifest.pdfx).toBe('1.1')
    expect(manifest.edits).toHaveLength(1)
    // Pages stay clean (no baked overlay image): the mirror is the source of truth.
    expect(reloaded.getPageCount()).toBe(1)

    // Reimport into a fresh source identity → overlays rebind to the new page key.
    const page = {
      id: 'p',
      source: { id: 'newsrc', bytes: new Uint8Array(), pdf: null as never },
      pageIndex: 0,
      width: 200,
      height: 200
    }
    const imported = deserializeMirror(manifest, [{ id: 'd', name: 'A', pages: [page] }])
    expect(imported!.overlays).toHaveLength(1)
    expect(imported!.overlays[0].type).toBe('highlight')
    expect(imported!.overlays[0].pageKey).toBe(makePageKey('newsrc', 0))
    expect(imported!.rotations).toEqual([[makePageKey('newsrc', 0), 90]])
  })
})

describe('buildPdf', () => {
  it('flattens pages into a plain PDF with no manifest attachment', async () => {
    const bytes = await makeSourcePdf()
    const pages: ExportPage[] = [
      { bytes, sourceKey: 'a', pageIndex: 0 },
      { bytes, sourceKey: 'a', pageIndex: 0 }
    ]
    const out = await buildPdf(pages)
    const reloaded = await PDFDocument.load(out)
    expect(reloaded.getPageCount()).toBe(2)
    expect(extractEmbeddedFile(reloaded, MANIFEST_NAME)).toBeNull()
  })

  it('strips signature fields when signing, but keeps other form fields', async () => {
    const bytes = await makeSourceWithSigField()
    const signed = await buildPdf([{ bytes, sourceKey: 's', pageIndex: 0 }], undefined, {
      stripSignatureFields: true
    })
    const types = await annotFieldTypes(signed)
    expect(types).not.toContain('/Sig') // no leftover "sign here" field
    expect(types).toContain('/Tx') // the text field survives
  })

  it('keeps signature fields on a normal export (no strip)', async () => {
    const bytes = await makeSourceWithSigField()
    const types = await annotFieldTypes(await buildPdf([{ bytes, sourceKey: 's', pageIndex: 0 }]))
    expect(types).toContain('/Sig')
  })

  it('applies a page crop as the /CropBox on export', async () => {
    const bytes = await makeSourcePdf() // 200×200
    const pageKey = makePageKey('a', 0)
    const editLayer: EditLayer = {
      overlays: new Map(),
      attachments: new Map(),
      crops: new Map([[pageKey, { x: 20, y: 30, w: 120, h: 100 }]])
    }
    const out = await buildPdf([{ bytes, sourceKey: 'a', pageIndex: 0 }], editLayer)
    const reloaded = await PDFDocument.load(out)
    const cb = reloaded.getPage(0).getCropBox()
    // Source MediaBox starts at (0,0), so the crop maps straight through.
    expect(cb).toEqual({ x: 20, y: 30, width: 120, height: 100 })
    // MediaBox is untouched — only the visible window shrinks.
    expect(reloaded.getPage(0).getMediaBox()).toEqual({ x: 0, y: 0, width: 200, height: 200 })
  })

  it('compensates for a source page intrinsic /Rotate when applying the crop', async () => {
    // Portrait 200×400 page stored with /Rotate 90 → pdf.js (and thus the editor) sees it as a
    // 400×200 landscape page, so the user's crop is captured in that rotation-baked space.
    const doc = await PDFDocument.create()
    doc.addPage([200, 400]).setRotation(degrees(90))
    const bytes = await doc.save()
    const pageKey = makePageKey('r', 0)
    const editLayer: EditLayer = {
      overlays: new Map(),
      attachments: new Map(),
      crops: new Map([[pageKey, { x: 50, y: 30, w: 100, h: 40 }]]) // editor (visual 400×200) space
    }
    const out = await buildPdf([{ bytes, sourceKey: 'r', pageIndex: 0 }], editLayer)
    const reloaded = await PDFDocument.load(out)
    // Visual {50,30,100,40} on a /Rotate-90 page maps to unrotated user space {130,50,40,100}.
    expect(reloaded.getPage(0).getCropBox()).toEqual({ x: 130, y: 50, width: 40, height: 100 })
    // /Rotate is preserved so a viewer still rotates the cropped region back to what was shown.
    expect(reloaded.getPage(0).getRotation().angle).toBe(90)
  })

  it('uses CropBox ∩ MediaBox (not the raw CropBox) so an oversized CropBox crops correctly', async () => {
    // /CropBox [0,0,300,400] extends past /MediaBox [0,0,200,400]; pdf.js (and thus the editor)
    // sizes the page to the 200×400 intersection, so the crop must too — at intrinsic /Rotate 90.
    const doc = await PDFDocument.create()
    const p = doc.addPage([200, 400])
    p.setCropBox(0, 0, 300, 400)
    p.setRotation(degrees(90))
    const bytes = await doc.save()
    const pageKey = makePageKey('c', 0)
    const editLayer: EditLayer = {
      overlays: new Map(),
      attachments: new Map(),
      crops: new Map([[pageKey, { x: 50, y: 30, w: 100, h: 40 }]]) // editor visual 400×200 space
    }
    const out = await buildPdf([{ bytes, sourceKey: 'c', pageIndex: 0 }], editLayer)
    const cb = await PDFDocument.load(out).then((d) => d.getPage(0).getCropBox())
    // Intersected W=200 ⇒ {130,50,40,100}; the raw CropBox W=300 would wrongly give x=230 (off-page).
    expect(cb).toEqual({ x: 130, y: 50, width: 40, height: 100 })
  })

  it('draws overlays through a rotation transform on an intrinsic-/Rotate source page', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([200, 400]).setRotation(degrees(90)) // unrotated W=200, H=400
    const bytes = await doc.save()
    const pageKey = makePageKey('r', 0)
    const editLayer: EditLayer = {
      overlays: new Map([[pageKey, [HIGHLIGHT(pageKey)]]]),
      attachments: new Map()
    }
    const out = await buildPdf([{ bytes, sourceKey: 'r', pageIndex: 0 }], editLayer)
    const content = pageContent(await PDFDocument.load(out), 0)
    // The visual->unrotated matrix (W=200) wraps the overlay draw so it lands where the user saw it.
    expect(content).toContain('0 1 -1 0 200 0 cm')
  })

  it('adds no rotation transform when the source page is unrotated', async () => {
    const bytes = await makeSourcePdf() // 200×200, /Rotate 0
    const pageKey = makePageKey('a', 0)
    const editLayer: EditLayer = {
      overlays: new Map([[pageKey, [HIGHLIGHT(pageKey)]]]),
      attachments: new Map()
    }
    const out = await buildPdf([{ bytes, sourceKey: 'a', pageIndex: 0 }], editLayer)
    const content = pageContent(await PDFDocument.load(out), 0)
    expect(content).not.toContain('0 1 -1 0') // no intrinsic-rotation matrix emitted
  })
})

describe('formValue flatten', () => {
  const formValue = (pageKey: string, field: string, value: string | boolean): Overlay => ({
    id: `fv-${field}`,
    pageKey,
    z: 0,
    createdAt: 0,
    geom: { x: 20, y: 20, w: 120, h: 16, rotation: 0, opacity: 1 },
    type: 'formValue',
    field,
    value
  })
  const flattenWith = async (overlay: Overlay): Promise<string> => {
    const bytes = await makeSourcePdf()
    const editLayer: EditLayer = {
      overlays: new Map([[makePageKey('a', 0), [overlay]]]),
      attachments: new Map()
    }
    const out = await buildPdf([{ bytes, sourceKey: 'a', pageIndex: 0 }], editLayer)
    return pageContent(await PDFDocument.load(out), 0)
  }

  it('paints a text form value over its field', async () => {
    // pdf-lib writes show-text as a hex string, e.g. "Ada" -> <416461> Tj.
    const hex = [...'Ada'].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    const content = await flattenWith(formValue(makePageKey('a', 0), 'name', 'Ada'))
    expect(content).toContain(`<${hex}> Tj`)
  })

  it('draws nothing for an empty text value', async () => {
    expect(await flattenWith(formValue(makePageKey('a', 0), 'name', ''))).not.toContain('Tj')
  })

  it('paints a checkbox mark only when checked', async () => {
    const checked = await flattenWith(formValue(makePageKey('a', 0), 'agree', true))
    const unchecked = await flattenWith(formValue(makePageKey('a', 0), 'agree', false))
    expect(checked.length).toBeGreaterThan(unchecked.length) // the X adds stroke operators
  })

  it('removes the interactive widget of a filled field so its value does not double on export', async () => {
    // A source whose text field already has a value (rendered by its widget appearance).
    const srcDoc = await PDFDocument.create()
    const srcPage = srcDoc.addPage([200, 200])
    const tf = srcDoc.getForm().createTextField('fullName')
    tf.setText('OLD VALUE')
    tf.addToPage(srcPage, { x: 20, y: 100, width: 140, height: 18 })
    const src = await srcDoc.save()
    const pages = [{ bytes: src, sourceKey: 'a', pageIndex: 0 }]
    const widgets = async (out: Uint8Array): Promise<number> => {
      const pdf = await PDFDocument.load(out)
      const annots = pdf.getPage(0).node.Annots()
      let n = 0
      for (let i = 0; annots && i < annots.size(); i++) {
        const d = pdf.context.lookupMaybe(annots.get(i), PDFDict)
        if (d && d.get(PDFName.of('Subtype')) === PDFName.of('Widget')) n++
      }
      return n
    }
    // Untouched: the widget survives the copy (its original value still shows).
    expect(await widgets(await buildPdf(pages))).toBe(1)
    // Filled: the widget is dropped — only the painted value remains, no doubling.
    const editLayer: EditLayer = {
      overlays: new Map([
        [makePageKey('a', 0), [formValue(makePageKey('a', 0), 'fullName', 'NEW')]]
      ]),
      attachments: new Map()
    }
    expect(await widgets(await buildPdf(pages, editLayer))).toBe(0)
  })
})

describe('format helpers', () => {
  it('stripExtension removes only .pdf/.pdfx (case-insensitive)', () => {
    expect(stripExtension('Contract.pdf')).toBe('Contract')
    expect(stripExtension('Contract.PDFX')).toBe('Contract')
    expect(stripExtension('photo.png')).toBe('photo.png')
    expect(stripExtension('archive.pdf.bak')).toBe('archive.pdf.bak')
  })

  it('partitionPages reproduces document boundaries from a manifest', () => {
    const manifest: PdfxManifest = {
      pdfx: '1.0',
      documents: [
        { name: 'NDA', pages: 2 },
        { name: 'Invoice', pages: 1 }
      ]
    }
    expect(partitionPages(manifest, 3, 'fallback')).toEqual([
      { name: 'NDA', indices: [0, 1] },
      { name: 'Invoice', indices: [2] }
    ])
  })

  it('partitionPages falls back to a single document when there is no manifest', () => {
    expect(partitionPages(null, 3, 'Whole')).toEqual([{ name: 'Whole', indices: [0, 1, 2] }])
  })

  it('partitionPages appends an Untitled tail when pages exceed the manifest', () => {
    const manifest: PdfxManifest = { pdfx: '1.0', documents: [{ name: 'A', pages: 1 }] }
    expect(partitionPages(manifest, 3, 'fallback')).toEqual([
      { name: 'A', indices: [0] },
      { name: 'Untitled', indices: [1, 2] }
    ])
  })
})
