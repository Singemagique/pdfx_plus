// OCR triage (DESIGN.md §3.4.1, §3.4.3) on the pages the RENDERER makes, through the raster
// thread's own entry point (main/ocr/process RasterEngine.triage, real PDFium):
// - photo-fit-a4 / photo-fit-letter / photo-standalone: a synthetic 4032 × 3024 text photo through
//   each imageToPdf path; renderDpi and the render width per §3.4.3's worked examples (±1 px);
// - the image-origin marker imageToPdf writes (Producer + /PDFxImportedImage BMC … EMC), and that
//   the mark survives copyPages while the Producer (a load-time signal only) does not;
// - ocr-ours: a scan carrying PR2's own text layer, with and without visible text on top.

import { zlibSync } from 'fflate'
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'

import { loadNodeSynthDeps } from '../../../shared/ocr/test-utils/node-deps'
import type { GreyImage } from '../../../shared/ocr/test-utils/degrade'
import { synthesize, type SynthResult } from '../../../shared/ocr/test-utils/synth'
import '../../../shared/ocr/test-utils/triage-presets'
import {
  IMAGE_IMPORT_PRODUCER,
  IMPORTED_IMAGE_MARK,
  type PageSignals,
  type TriagePage
} from '../../../shared/ocr/triage'
import { RasterEngine } from '../../../main/ocr/process/raster-core'
import { PDFX_OCR_FONT, PDFX_OCR_MARK } from '../../../main/ocr/process/triage-pdfium'
import { loadTestPdfium, type TestPdfium } from '../../../main/ocr/test-utils/pdfium-node'
import { addText, fillPage } from '../../../main/ocr/test-utils/triage-fixtures'
import { imageToPdf } from './images'
import { OCR_FONT_NAME } from './ocr-font'
import { OCR_MARK } from './ocr-layer'
import { bakeLayer, ocrPageFromGt } from './test-utils/ocr-layer'

let mod: TestPdfium
let photo: SynthResult
let photoPng: Uint8Array

// ---------------------------------------------------------------------------------------------
// A grey 8-bit PNG writer (filter 0 rows, one zlib IDAT): what a phone photo becomes after a
// greyscale export, small enough to keep the fixture fast.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

function greyPng(img: GreyImage): Uint8Array {
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, img.width)
  dv.setUint32(4, img.height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // greyscale
  const rows = new Uint8Array((img.width + 1) * img.height)
  for (let y = 0; y < img.height; y++)
    rows.set(img.data.subarray(y * img.width, (y + 1) * img.width), y * (img.width + 1) + 1)
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(rows, { level: 1 })),
    chunk('IEND', new Uint8Array(0))
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** A smaller photo of the same kind: the 4032 × 3024 photo box-sampled to `width` px. */
function shrink(img: GreyImage, width: number): GreyImage {
  const f = img.width / width
  const height = Math.round(img.height / f)
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data[y * width + x] = img.data[Math.floor(y * f) * img.width + Math.floor(x * f)]
  return { width, height, data }
}

beforeAll(async () => {
  mod = await loadTestPdfium()
  photo = await synthesize({ preset: 'photo-text', seed: 3 }, await loadNodeSynthDeps())
  photoPng = greyPng(photo.raster)
}, 60_000)

function triage(bytes: Uint8Array): TriagePage & { signals: PageSignals } {
  const sab = new SharedArrayBuffer(bytes.length)
  const view = new Uint8Array(sab)
  view.set(bytes)
  const engine = new RasterEngine(mod)
  engine.attach('s', view)
  let signals: PageSignals | null = null
  const out = engine.triage('s', [0], (_i, s) => (signals = s))
  engine.closeAll()
  if (!Array.isArray(out)) throw new Error(`PDFium error ${out.pdfiumError}`)
  return { ...out[0], signals: signals! }
}

/** Every content stream of page 0, decoded and joined. */
async function pageContent(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes)
  const page = doc.getPage(0)
  const contents = page.node.Contents()
  const streams = contents && 'asArray' in contents ? contents.asArray() : [contents]
  return streams
    .map((ref) => {
      const s = doc.context.lookup(ref as never) ?? ref
      return s instanceof PDFRawStream
        ? new TextDecoder().decode(decodePDFRawStream(s).decode())
        : ''
    })
    .join('\n')
}

describe('the image-origin marker imageToPdf writes', () => {
  it('sets the Producer and draws the image inside /PDFxImportedImage BMC … EMC', async () => {
    const bytes = await imageToPdf(photoPng, { width: 612, height: 792 })
    // (pdf-lib rewrites the Producer on load unless told not to.)
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    expect(doc.getProducer()).toBe(IMAGE_IMPORT_PRODUCER)
    const content = await pageContent(bytes)
    expect(content).toMatch(new RegExp(`/${IMPORTED_IMAGE_MARK} BMC[\\s\\S]*Do[\\s\\S]*EMC`))
    expect(triage(bytes).imageOrigin).toBe(true)
  })

  it('the mark lives in the page, so it survives copyPages; the Producer does not', async () => {
    const bytes = await imageToPdf(photoPng)
    const out = await PDFDocument.create()
    const [copied] = await out.copyPages(await PDFDocument.load(bytes), [0])
    out.addPage(copied)
    const saved = await out.save()
    expect((await PDFDocument.load(saved, { updateMetadata: false })).getProducer()).not.toBe(
      IMAGE_IMPORT_PRODUCER
    )
    expect(triage(saved).imageOrigin).toBe(true)
  })

  it('a plain scan carries no mark', async () => {
    expect(triage(await fillPage(photo.raster, 300)).imageOrigin).toBe(false)
  })
})

describe('photo-fit DPI (§3.4.3 worked examples, ±1 px)', () => {
  it('photo-fit-a4: native density, ~4,032 px wide', async () => {
    const page = { width: 595.28, height: 841.89 }
    const t = triage(await imageToPdf(photoPng, page))
    expect(t).toMatchObject({ pageClass: 'scanned', imageOrigin: true, bitsPerPixel: 8 })
    expect(t.effectiveDpi).toBeCloseTo((4032 * 72) / page.width, 1)
    expect(t.renderDpi).toBeCloseTo(487.68, 1)
    expect(Math.abs(t.raster!.width - 4032)).toBeLessThanOrEqual(1)
  })

  it('photo-fit-letter: d_eff 474 → ~4,032 px wide', async () => {
    const t = triage(await imageToPdf(photoPng, { width: 612, height: 792 }))
    expect(t.renderDpi).toBeCloseTo(474.35, 1)
    expect(Math.abs(t.raster!.width - 4032)).toBeLessThanOrEqual(1)
  })

  it('photo-standalone: 1 px = 1 pt; 2× native, then the pixel caps', async () => {
    const t = triage(await imageToPdf(photoPng))
    expect(t.effectiveDpi).toBeCloseTo(72, 2)
    // The design's worked example says 7,200 px; with its own 36 MP cap a 4:3 page lands at
    // 6,928 × 5,196 (see triage.node.test.ts).
    expect(t.renderDpi).toBe(123.71)
    expect(Math.abs(t.raster!.width - 6928)).toBeLessThanOrEqual(1)
    expect(t.raster!.width * t.raster!.height).toBeLessThanOrEqual(36_000_000)
  })

  it('a small 1,000 px photo fitted to Letter is capped at 2× native (2,000 px, ~235 DPI)', async () => {
    const t = triage(
      await imageToPdf(greyPng(shrink(photo.raster, 1000)), { width: 612, height: 792 })
    )
    expect(t.renderDpi).toBeCloseTo(235.29, 1)
    expect(Math.abs(t.raster!.width - 2000)).toBeLessThanOrEqual(1)
  })
})

describe('ocr-ours: a page carrying PDFx’s own text layer (PR2 writer)', () => {
  it('names the mark and font the layer writer uses', () => {
    expect(PDFX_OCR_MARK).toBe(OCR_MARK)
    expect(PDFX_OCR_FONT).toBe(OCR_FONT_NAME)
  })

  it('is `ocr-ours`, and returns the visible native words on top of it', async () => {
    const s = await synthesize({ preset: 'near-scanned-bates', seed: 2 }, await loadNodeSynthDeps())
    const scanned = await fillPage(s.raster, 150)
    const { bytes } = await bakeLayer(scanned, [ocrPageFromGt(s.gt)])
    const t = triage(bytes)
    expect(t.pageClass).toBe('ocr-ours')
    expect(t.signals.pdfxOcrMark).toBe(true)
    expect(t.signals.pdfxOcrFont).toBe(true)
    expect(t.signals.visible).toBe(0)
    expect(t.signals.invisible).toBeGreaterThan(200)
    expect(t.nativeWords).toEqual([])
    const stamped = triage(await addText(bytes, [{ text: 'PDFX-000124', x: 500, y: 20, size: 9 }]))
    expect(stamped.pageClass).toBe('ocr-ours')
    expect(stamped.nativeWords?.map((w) => w.t)).toEqual(['PDFX-000124'])
  })
})
