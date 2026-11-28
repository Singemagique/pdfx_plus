// The OCR redaction leak suite (DESIGN.md §3.7.3, rule 6, tier 0; PR3b, security-reviewed).
//
// Every fixture exports a redacted page whose recognised text includes a secret through the REAL
// pipeline useExport runs (buildRedactedSources({ report: true }) → withOcrLayer(removed) →
// buildPdf / buildPdfx, the zip and Sign variants of buildPdf included), over sources opened with
// the shipped pdf.js, and then reads the SAVED bytes back:
// - both shipped extractors (pdf.js getTextContent, PDFium FPDFText_GetText) on every page;
// - the raw-bytes oracle (test-utils/leak-oracle.ts): every stream inflated, every string decoded,
//   every ToUnicode / /W / CIDToGIDMap decoded, the word searched in UTF-8, UTF-16BE/LE,
//   PDFDocEncoding, hex and as a CID sequence, and no code point unique to the secret anywhere;
// - which words SURVIVE, so the filter is shown to be precise (rule 1 drops what the box touches,
//   rule 2 what lies over a removed object), not merely fail-safe.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import fontkit from '@pdf-lib/fontkit'
import {
  concatTransformationMatrix,
  decodePDFRawStream,
  degrees,
  drawObject,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFPageLeaf,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  StandardFonts,
  type PDFPage
} from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { loadNodeSynthDeps } from '../../../shared/ocr/test-utils/node-deps'
import {
  createPdfiumRasterizer,
  type Rasterizer
} from '../../../shared/ocr/test-utils/pdfium-raster'
import { synthesize, type SynthResult } from '../../../shared/ocr/test-utils/synth'
import {
  pack,
  unpack,
  wordFootprint,
  type OcrPage,
  type PackedOcrPage
} from '../../../shared/ocr/types'
import { makePageKey, type Geom, type Overlay } from '../edit/model'
import { stubUnicodeFontFetch } from '../test-utils/fonts'
import { loadTestPdfium } from '../test-utils/pdfium'
import type { DocEntry, PageEntry } from '../types'
import { buildPdf, buildPdfx, unrotateCrop, type EditLayer } from './build'
import type { ExportPage } from './format'
import { GLYPHLESS_TTF_NO_CONTOUR } from './ocr-glyphless-ttf'
import { redactOcrPage, withOcrLayer, type FrameBox } from './ocr-export'
import { existingOcrLayer, isOcrLayerStream } from './ocr-layer'
import { redactPdf, redactPdfReport, type PdfiumModule } from './redact'
import {
  applyRedactedBytes,
  buildRedactedSources,
  pdfBoxToFrame,
  sanitizeRedacted,
  type RedactedSources
} from './redact-export'
import { redactPdf as redactPdf113 } from './test-utils/legacy/redact-1.1.3'
import {
  extractorLeaks,
  hasManifest,
  parseToUnicode,
  rawLeaks,
  uniqueCodePoints,
  type Secret
} from './test-utils/leak-oracle'
import {
  bakeLayer,
  flowWords,
  handPage,
  ocrPageFromGt,
  pdfiumProbe,
  pdfjsCopyText,
  pdfjsText,
  toOverlay,
  type ProbePdfium
} from './test-utils/ocr-layer'

const DPI = 72
let pdfium: ProbePdfium
let raster: Rasterizer
let scan: SynthResult

beforeAll(async () => {
  pdfium = await loadTestPdfium<ProbePdfium>()
  raster = createPdfiumRasterizer(pdfium as never)
  scan = await synthesize({ preset: 'clean300', seed: 7 }, await loadNodeSynthDeps())
})

// ---------------------------------------------------------------------------------------------
// The export pipeline, as useExport runs it

const opened: { destroy(): Promise<void> }[] = []
afterAll(async () => {
  for (const pdf of opened) await pdf.destroy()
})

/** A collection document over `bytes`, opened with the shipped pdf.js (real view and /Rotate). */
async function openDoc(id: string, bytes: Uint8Array): Promise<DocEntry> {
  const pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise
  opened.push(pdf)
  const pages: PageEntry[] = []
  for (let i = 0; i < pdf.numPages; i++) {
    const vp = (await pdf.getPage(i + 1)).getViewport({ scale: 1 })
    const source = { id, bytes, pdf: pdf as unknown as PDFDocumentProxy }
    pages.push({ id: `${id}-${i}`, source, pageIndex: i, width: vp.width, height: vp.height })
  }
  return { id: `doc-${id}`, name: id, pages }
}

type Kind = 'pdf' | 'pdfx' | 'zip' | 'sign'
const ALL_KINDS: Kind[] = ['pdf', 'pdfx', 'zip', 'sign']

const exportPagesOf = (doc: DocEntry, redacted: RedactedSources): ExportPage[] =>
  applyRedactedBytes(
    doc.pages.map((p) => ({ bytes: p.source.bytes, sourceKey: p.source.id, pageIndex: p.pageIndex })), // prettier-ignore
    redacted
  )

interface Exported {
  /** The saved file(s): one, or one per document for a zip. */
  files: Uint8Array[]
  redacted: RedactedSources
  layer: EditLayer
}

/** Export `docs` like useExport: the redaction pass with its report, the layer, the builder. */
async function exportAs(
  kind: Kind,
  docs: DocEntry[],
  editLayer: EditLayer,
  ocr: ReadonlyMap<string, PackedOcrPage> | undefined
): Promise<Exported> {
  const redacted = await buildRedactedSources(editLayer, docs, { pdfium, report: true })
  const layer = withOcrLayer(editLayer, ocr, { include: true, removed: redacted.removed })
  const flat = docs.flatMap((d) => exportPagesOf(d, redacted))
  let files: Uint8Array[]
  if (kind === 'pdf') files = [await buildPdf(flat, layer)]
  else if (kind === 'sign') files = [await buildPdf(flat, layer, { stripSignatureFields: true })]
  else if (kind === 'zip')
    files = await Promise.all(docs.map((d) => buildPdf(exportPagesOf(d, redacted), layer)))
  else {
    const documents = docs.map((d) => ({ name: d.name, pages: exportPagesOf(d, redacted) }))
    files = [await buildPdfx(documents, 'Leak suite', layer)]
  }
  return { files, redacted, layer }
}

const edits = (over: Partial<EditLayer> = {}): EditLayer => ({
  overlays: new Map(),
  attachments: new Map(),
  ...over
})

let nextId = 0
const redaction = (pageKey: string, g: FrameBox, z = 0): Overlay => ({
  id: `red-${nextId++}`,
  pageKey,
  z,
  createdAt: z,
  geom: { ...g, rotation: 0, opacity: 1 },
  type: 'redaction',
  fill: { r: 0, g: 0, b: 0 }
})

/** The words both extractors and the oracle must never see in any of `files`. */
async function expectNoLeak(files: Uint8Array[], secret: Secret): Promise<void> {
  for (const f of files) {
    expect(await rawLeaks(f, secret)).toEqual([])
    expect(await extractorLeaks(pdfium, f, secret)).toEqual([])
  }
}

/** pdf.js's words of page `i`, in order. */
const wordsOn = async (bytes: Uint8Array, i = 0): Promise<string[]> =>
  pdfjsCopyText((await pdfjsText(bytes, i)).items)
    .split(/\s+/)
    .filter(Boolean)

/** The PDFx OCR layer streams page `i` of `bytes` carries. */
async function layerCount(bytes: Uint8Array, i = 0): Promise<number> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  return existingOcrLayer(doc.getPage(i)).streams.length
}

/** A 1×1 DeviceGray image XObject drawn over `user` (unrotated user space) on `page`. */
function drawStrip(
  page: PDFPage,
  user: FrameBox,
  grey: number,
  data?: Uint8Array,
  w = 1,
  h = 1
): void {
  const ctx = page.doc.context
  const img = ctx.flateStream(data ?? new Uint8Array([grey]), {
    Type: 'XObject',
    Subtype: 'Image',
    Width: w,
    Height: h,
    ColorSpace: 'DeviceGray',
    BitsPerComponent: 8
  })
  const name = page.node.newXObject('Strip', ctx.register(img))
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(user.w, 0, 0, user.h, user.x, user.y),
    drawObject(name),
    popGraphicsState()
  )
}

const blankPdf = async (w = 400, h = 400, pages = 1): Promise<Uint8Array> => {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([w, h])
  return doc.save()
}

// ---------------------------------------------------------------------------------------------
// The frame fixtures: /Rotate 0/90/180/270, an offset MediaBox and CropBox, blank or in strips

/**
 * Letters that occur in no other word of the fixtures, and in no string the export itself writes
 * (Producer, Title, dates, the manifest's file name and description), so the per-code-point check
 * of the oracle can bite.
 */
const SECRET_WORD = 'QVWJKY'
const MEDIA = { x: 10, y: 20, w: 420, h: 620 }
const CROPBOX = { x: 30, y: 40, w: 400, h: 600 }
const LINES = [
  ['Mellon', 'harbor', 'sunlit'],
  ['Morning', SECRET_WORD, 'beside'],
  ['Bright', 'castle', 'noble'],
  ['Faded', 'tiles', 'sands']
]
const SIZE = 14
const KEPT_WORDS = LINES.flat().filter((w) => w !== SECRET_WORD)
const SECRET: Secret = {
  words: [SECRET_WORD],
  uniqueCps: uniqueCodePoints([SECRET_WORD], KEPT_WORDS)
}

/** The visual (overlay) frame of a framed page: the CropBox, quarter turns swapped. */
const visualSize = (rotate: number): { W: number; H: number } =>
  rotate % 180 ? { W: CROPBOX.h, H: CROPBOX.w } : { W: CROPBOX.w, H: CROPBOX.h }

/** Band k (top first) of the visual frame: a quarter of its height. */
function band(rotate: number, k: number): FrameBox {
  const { W, H } = visualSize(rotate)
  return { x: 0, y: H - ((k + 1) * H) / 4, w: W, h: H / 4 }
}

/** The four lines, one per band, in the visual frame. */
function framedOcr(rotate: number): OcrPage {
  return handPage(
    LINES.map((words, k) => {
      const b = band(rotate, k)
      return { y: b.y + b.h / 2 - 4, size: SIZE, x0: 30, words: flowWords(words, 9, 8) }
    })
  )
}

/** A box inside the secret word (its x-height band), in the visual frame. */
function secretBox(page: OcrPage): FrameBox {
  const line = page.lines[1]
  const w = line.words[1]
  expect(w.t).toBe(SECRET_WORD)
  return { x: w.x + 1, y: w.y + 1, w: w.w - 2, h: 0.5 * SIZE }
}

/** The framed page; `strips` draws the "scan" as four image strips, one per visual band. */
async function framedPdf(rotate: number, strips: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([MEDIA.w, MEDIA.h])
  page.setMediaBox(MEDIA.x, MEDIA.y, MEDIA.w, MEDIA.h)
  page.setCropBox(CROPBOX.x, CROPBOX.y, CROPBOX.w, CROPBOX.h)
  if (rotate) page.setRotation(degrees(rotate))
  if (strips)
    for (let k = 0; k < 4; k++) {
      const u = unrotateCrop(band(rotate, k), rotate, CROPBOX.w, CROPBOX.h)
      drawStrip(page, { x: CROPBOX.x + u.x, y: CROPBOX.y + u.y, w: u.w, h: u.h }, 200 - 20 * k)
    }
  return doc.save()
}

describe.each([0, 90, 180, 270])('/Rotate %i, offset MediaBox and CropBox', (rotate) => {
  const key = makePageKey(`f${rotate}`, 0)

  async function run(kind: Kind, strips: boolean): Promise<Exported & { doc: DocEntry }> {
    const doc = await openDoc(`f${rotate}`, await framedPdf(rotate, strips))
    const page = framedOcr(rotate)
    // The frame pdf.js gives the editor is the one the words and boxes were made in.
    expect([doc.pages[0].width, doc.pages[0].height]).toEqual(Object.values(visualSize(rotate)))
    const layer = edits({ overlays: new Map([[key, [redaction(key, secretBox(page))]]]) })
    return { doc, ...(await exportAs(kind, [doc], layer, new Map([[key, pack(page)]]))) }
  }

  const kinds = rotate === 0 || rotate === 90 ? ALL_KINDS : (['pdf', 'pdfx'] as Kind[])

  it.each(kinds)('blank page, %s: rule 1 drops exactly the boxed word', async (kind) => {
    const { files, redacted } = await run(kind, false)
    // Nothing but the box was there: the report says so (and is not missing).
    expect(redacted.removed?.get(key)).toEqual([])
    for (const f of files) {
      expect(await wordsOn(f)).toEqual(KEPT_WORDS)
      expect(await layerCount(f)).toBe(1)
    }
    await expectNoLeak(files, SECRET)
  })

  it.each(kinds)(
    'scan in strips, %s: rule 2 drops every word over the removed strip',
    async (kind) => {
      const { files, redacted } = await run(kind, true)
      // The pass removed exactly the strip under the box, reported in the VISUAL frame.
      const gone = redacted.removed?.get(key) ?? []
      expect(gone).toHaveLength(1)
      const b = band(rotate, 1)
      for (const k of ['x', 'y', 'w', 'h'] as const) expect(gone[0][k]).toBeCloseTo(b[k], 3)
      const kept = LINES.filter((_, k) => k !== 1).flat()
      for (const f of files) expect(await wordsOn(f)).toEqual(kept)
      await expectNoLeak(files, { words: [SECRET_WORD, 'Morning', 'beside'], uniqueCps: SECRET.uniqueCps }) // prettier-ignore
    }
  )
})

describe('a user-cropped page (#80): crop and redaction together', () => {
  it.each(['pdf', 'pdfx'] as Kind[])('%s', async (kind) => {
    const doc = await openDoc('crop', await framedPdf(0, false))
    const key = makePageKey('crop', 0)
    const page = framedOcr(0)
    // The edit crop keeps the top three bands; the last line lies entirely outside it.
    const crop = { x: 0, y: band(0, 2).y, w: CROPBOX.w, h: CROPBOX.h - band(0, 2).y }
    const layer = edits({
      overlays: new Map([[key, [redaction(key, secretBox(page))]]]),
      crops: new Map([[key, crop]])
    })
    const { files } = await exportAs(kind, [doc], layer, new Map([[key, pack(page)]]))
    // PDF drops the cropped-away line too; .pdfx keeps it (crop is a live edit there).
    const expected = kind === 'pdf' ? LINES.slice(0, 3).flat() : LINES.flat()
    expect(await wordsOn(files[0])).toEqual(expected.filter((w) => w !== SECRET_WORD))
    await expectNoLeak(files, SECRET)
    if (kind === 'pdf') await expectNoLeak(files, { words: LINES[3], uniqueCps: [] })
  })
})

// ---------------------------------------------------------------------------------------------
// Scans: wrapped in a Form XObject, and split into strips with their real pixels

/** GT words whose text is unique on the page (not even inside another word), ≥ 5 letters. */
function uniqueGtWords(s: SynthResult, skipLines = 3): number[] {
  const key = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const count = new Map<string, number>()
  for (const w of s.gt.words) count.set(key(w.t), (count.get(key(w.t)) ?? 0) + 1)
  const out: number[] = []
  for (const l of s.gt.lines.slice(skipLines))
    for (const wi of l.words.slice(1, -1)) {
      const t = s.gt.words[wi].t
      if (
        /^\p{L}{5,}$/u.test(t) &&
        count.get(key(t)) === 1 &&
        !s.gt.text.replace(t, '').includes(t)
      )
        // prettier-ignore
        out.push(wi)
    }
  if (!out.length) throw new Error('no unique word')
  return out
}

/** The first such word, mid-page. */
const uniqueGtWord = (s: SynthResult): number => uniqueGtWords(s)[0]

describe('a scan wrapped in a Form XObject', () => {
  it.each(['pdf', 'pdfx', 'sign'] as Kind[])(
    '%s: the redaction removes the form, so the whole layer goes',
    async (kind) => {
      const outer = await PDFDocument.create()
      const [form] = await outer.embedPdf(scan.pdfBytes, [0])
      outer.addPage([form.width, form.height]).drawPage(form)
      const bytes = await outer.save()
      const target = uniqueGtWord(scan)
      // PDFium sees ONE top-level object (the form), and the report names it.
      const direct = redactPdfReport(pdfium, bytes, [{ pageIndex: 0, rects: [{ ...scan.gt.words[target].box }] }]) // prettier-ignore
      expect(direct.removed.get(0)?.map((o) => o.type)).toEqual([5])
      const doc = await openDoc(`form-${kind}`, bytes)
      const key = makePageKey(`form-${kind}`, 0)
      const layer = edits({ overlays: new Map([[key, [redaction(key, scan.gt.words[target].box)]]]) }) // prettier-ignore
      const { files, redacted } = await exportAs(kind, [doc], layer, new Map([[key, pack(ocrPageFromGt(scan.gt))]])) // prettier-ignore
      const gone = redacted.removed!.get(key)!
      expect(gone).toHaveLength(1)
      expect(gone[0].w).toBeCloseTo(form.width, 1)
      expect(gone[0].h).toBeCloseTo(form.height, 1)
      expect(await layerCount(files[0])).toBe(0)
      expect(await wordsOn(files[0])).toEqual([])
      await expectNoLeak(files, { words: [scan.gt.words[target].t], uniqueCps: [] })
    }
  )
})

describe('a scan split into strips (its real pixels)', () => {
  const STRIPS = 6

  /** The synth scan as STRIPS horizontal image strips; returns the strips' frame rects too. */
  async function stripScan(): Promise<{ bytes: Uint8Array; rects: FrameBox[] }> {
    const { width: rw, height: rh, data } = scan.raster
    const { width: pw, height: ph } = scan.gt.page
    const doc = await PDFDocument.create()
    const page = doc.addPage([pw, ph])
    const rects: FrameBox[] = []
    for (let k = 0; k < STRIPS; k++) {
      const r0 = Math.floor((k * rh) / STRIPS)
      const r1 = Math.floor(((k + 1) * rh) / STRIPS)
      const rect = { x: 0, y: ph - (r1 / rh) * ph, w: pw, h: ((r1 - r0) / rh) * ph }
      rects.push(rect)
      drawStrip(page, rect, 0, data.subarray(r0 * rw, r1 * rw), rw, r1 - r0)
    }
    return { bytes: await doc.save(), rects }
  }

  it.each(['pdf', 'pdfx', 'zip'] as Kind[])(
    '%s: exactly the words over the removed strip go, the rest stay',
    async (kind) => {
      const { bytes, rects } = await stripScan()
      // The strips render the page like the one-image scan (resampling at the seams aside).
      const a = raster(bytes, DPI).data
      const b = raster(scan.pdfBytes, DPI).data
      expect(a.length).toBe(b.length)
      expect(a.filter((v, i) => Math.abs(v - b[i]) > 32).length / a.length).toBeLessThan(0.005)
      const target = uniqueGtWord(scan)
      const box = scan.gt.words[target].box
      const doc = await openDoc(`strips-${kind}`, bytes)
      const key = makePageKey(`strips-${kind}`, 0)
      const ocr = ocrPageFromGt(scan.gt)
      const layer = edits({ overlays: new Map([[key, [redaction(key, box)]]]) })
      const { files, redacted } = await exportAs(kind, [doc], layer, new Map([[key, pack(ocr)]]))
      // Independent expectation: the strips the box overlaps, then every word whose footprint
      // meets the box or one of them.
      const meets = (a: FrameBox, b: FrameBox): boolean =>
        a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
      const removedStrips = rects.filter((r) => meets(r, box))
      expect(removedStrips.length).toBeGreaterThanOrEqual(1)
      expect(redacted.removed!.get(key)).toHaveLength(removedStrips.length)
      const kept: string[] = []
      const dropped: string[] = []
      for (const line of ocr.lines)
        for (const w of line.words) {
          const f = wordFootprint(w, line)
          const fp = { x: f.x0, y: f.y0, w: f.x1 - f.x0, h: f.y1 - f.y0 }
          ;(meets(fp, box) || removedStrips.some((r) => meets(fp, r)) ? dropped : kept).push(w.t)
        }
      expect(dropped).toContain(scan.gt.words[target].t)
      expect(dropped.length).toBeGreaterThan(5)
      expect(kept.length).toBeGreaterThan(40)
      for (const f of files) expect(await wordsOn(f)).toEqual(kept)
      await expectNoLeak(files, { words: [scan.gt.words[target].t], uniqueCps: [] })
    }
  )
})

// ---------------------------------------------------------------------------------------------
// Imprecise boxes: OCR geometry jittered by ±0.1 em, and a box that misses the baseline

/** A deterministic [-1, 1) stream (LCG). */
function jitter(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return (s / 2 ** 32) * 2 - 1
  }
}

describe('box perturbation: OCR boxes jittered ±0.1 em against the printed word', () => {
  /** The synth page's OCR words, each moved and resized by up to ±0.1 em. */
  function jittered(seed: number): OcrPage {
    const r = jitter(seed)
    const page = ocrPageFromGt(scan.gt)
    return {
      ...page,
      lines: page.lines.map((l) => ({
        ...l,
        words: l.words.map((w) => ({
          ...w,
          x: w.x + 0.1 * l.size * r(),
          y: w.y + 0.1 * l.size * r(),
          w: Math.max(1, w.w + 0.1 * l.size * r())
        }))
      }))
    }
  }

  it.each([1, 2, 3])('seed %i: a box over any word’s ink drops that word', (seed) => {
    const packed = pack(jittered(seed))
    const key = makePageKey('jit', 0)
    // As packed (Float32 geometry), so the identity check below compares like with like.
    const all = unpack(packed).lines.flatMap((l) => l.words)
    expect(all).toHaveLength(scan.gt.words.length)
    let neighbours = 0
    // GT order = OCR order: ocrPageFromGt maps the GT lines' words in order.
    const order = scan.gt.lines.flatMap((l) => l.words)
    order.forEach((wi, i) => {
      const gt = scan.gt.words[wi]
      const ink = gt.ink ?? gt.box
      const layer = edits({ overlays: new Map([[key, [redaction(key, ink)]]]) })
      const out = redactOcrPage(packed, layer, key, new Map([[key, []]]))
      const left = out ? unpack(out).lines.flatMap((l) => l.words) : []
      expect(
        left.some((w) => w.x === all[i].x && w.y === all[i].y),
        gt.t
      ).toBe(false)
      neighbours += all.length - 1 - left.length
    })
    // [measured, seed 1–3] Over-removal stays small: mostly the word itself (a box over a word's
    // ink can reach a neighbour's pad across a narrow gap).
    expect(neighbours / order.length).toBeLessThan(1)
  })

  it.each(['pdf', 'pdfx'] as Kind[])('%s: three boxed words, exported', async (kind) => {
    const bytes = await blankPdf(scan.gt.page.width, scan.gt.page.height)
    const doc = await openDoc(`jit-${kind}`, bytes)
    const key = makePageKey(`jit-${kind}`, 0)
    const all = uniqueGtWords(scan, 1)
    expect(all.length).toBeGreaterThanOrEqual(3)
    const targets = [all[0], all[Math.floor(all.length / 2)], all[all.length - 1]]
    expect(new Set(targets).size).toBe(3)
    const reds = targets.map((t) => redaction(key, scan.gt.words[t].ink ?? scan.gt.words[t].box))
    const layer = edits({ overlays: new Map([[key, reds]]) })
    const { files } = await exportAs(kind, [doc], layer, new Map([[key, pack(jittered(4))]]))
    const words = await wordsOn(files[0])
    expect(words.length).toBeGreaterThan(scan.gt.words.length - 10)
    await expectNoLeak(files, { words: targets.map((t) => scan.gt.words[t].t), uniqueCps: [] })
  })
})

describe('a baseline-miss box (the x-height band, not the baseline)', () => {
  const page = handPage([{ y: 200, size: 20, x0: 20, words: flowWords(['Public', SECRET_WORD, 'words'], 10, 6) }]) // prettier-ignore
  const secretW = page.lines[0].words[1]
  /** Baseline + 0.1 em … + 0.45 em: clear of the baseline, inside the x-height. */
  const box = { x: secretW.x + 2, y: 202, w: secretW.w - 4, h: 7 }
  const secret: Secret = { words: [SECRET_WORD], uniqueCps: uniqueCodePoints([SECRET_WORD], ['Public', 'words']) } // prettier-ignore

  it.each(['pdf', 'pdfx'] as Kind[])('%s export: rule 1 drops the word', async (kind) => {
    const doc = await openDoc(`bl-${kind}`, await blankPdf())
    const key = makePageKey(`bl-${kind}`, 0)
    const layer = edits({ overlays: new Map([[key, [redaction(key, box)]]]) })
    const { files } = await exportAs(kind, [doc], layer, new Map([[key, pack(page)]]))
    expect(await wordsOn(files[0])).toEqual(['Public', 'words'])
    await expectNoLeak(files, secret)
  })

  it('re-redacting the layer with PDFium: the em-spanning glyph is caught by every version', async () => {
    const baked = await bakeLayer(await blankPdf(), [page])
    for (const redact of [redactPdf, redactPdf113] as const) {
      const out = redact(pdfium as unknown as PdfiumModule, baked.bytes, [{ pageIndex: 0, rects: [box] }]) // prettier-ignore
      expect(await extractorLeaks(pdfium, out, secret)).toEqual([])
      expect(await wordsOn(out)).toEqual(['Public', 'words'])
    }
  })

  it("re-redacting another producer's degenerate glyphless layer: only 1.1.4's pad catches it", async () => {
    // A contour-less glyph: PDFium reports zero-height text objects (ocr-glyph-bounds suite).
    const ttf = Uint8Array.from(atob(GLYPHLESS_TTF_NO_CONTOUR), (c) => c.charCodeAt(0))
    const baked = await bakeLayer(await blankPdf(), [page], { ttf })
    const objH = pdfiumProbe(pdfium, baked.bytes).textObjects.map((o) => o.bounds.t - o.bounds.b)
    expect(Math.max(...objH)).toBeLessThan(1)
    const now = redactPdf(pdfium, baked.bytes, [{ pageIndex: 0, rects: [box] }])
    expect(await extractorLeaks(pdfium, now, secret)).toEqual([])
    expect(await wordsOn(now)).toEqual(['Public', 'words'])
    // The frozen 1.1.3 engine misses it: the leak the pad closes (control).
    const old = redactPdf113(pdfium as unknown as PdfiumModule, baked.bytes, [{ pageIndex: 0, rects: [box] }]) // prettier-ignore
    expect(await extractorLeaks(pdfium, old, secret)).not.toEqual([])
  })

  it.each([
    ['GlyphLessFont', 0],
    ['ABCDEF+Occulta', 0],
    ['PDFxOCR-GlyphLess', 0],
    ['SomeTextFont', 3]
  ] as const)(
    'the pad applies to font %s in render mode %i, and not to visible text in another font',
    async (font, mode) => {
      const ttf = Uint8Array.from(atob(GLYPHLESS_TTF_NO_CONTOUR), (c) => c.charCodeAt(0))
      const rename = async (bytes: Uint8Array, name: string): Promise<Uint8Array> => {
        const doc = await PDFDocument.load(bytes, { updateMetadata: false })
        for (const [, obj] of doc.context.enumerateIndirectObjects())
          if (obj instanceof PDFDict && obj.get(PDFName.of('BaseFont')))
            obj.set(PDFName.of('BaseFont'), PDFName.of(name))
        return doc.save({ useObjectStreams: false })
      }
      const baked = await bakeLayer(await blankPdf(), [page], { ttf, renderMode: mode })
      const out = redactPdf(pdfium, await rename(baked.bytes, font), [{ pageIndex: 0, rects: [box] }]) // prettier-ignore
      expect(await extractorLeaks(pdfium, out, secret)).toEqual([])
      // Control: visible text (mode 0) in a font of no OCR producer keeps its own bounds.
      const plain = await bakeLayer(await blankPdf(), [page], { ttf, renderMode: 0 })
      const kept = redactPdf(pdfium, await rename(plain.bytes, 'SomeTextFont'), [{ pageIndex: 0, rects: [box] }]) // prettier-ignore
      expect(await wordsOn(kept)).toContain(SECRET_WORD)
    }
  )
})

describe('the invisible-text pad: its em box, below the baseline, turned, and not the next line', () => {
  const noContour = (): Uint8Array =>
    Uint8Array.from(atob(GLYPHLESS_TTF_NO_CONTOUR), (c) => c.charCodeAt(0))
  const secret: Secret = { words: [SECRET_WORD], uniqueCps: uniqueCodePoints([SECRET_WORD], ['Public', 'words']) } // prettier-ignore
  const pdfiumOf = (): PdfiumModule => pdfium as unknown as PdfiumModule

  it('a box in the descender band, just under the baseline, still takes the word', async () => {
    const page = handPage([{ y: 200, size: 20, x0: 20, words: flowWords(['Public', SECRET_WORD, 'words'], 10, 6) }]) // prettier-ignore
    const w = page.lines[0].words[1]
    const box = { x: w.x + 2, y: 196, w: w.w - 4, h: 3 }
    const baked = await bakeLayer(await blankPdf(), [page], { ttf: noContour() })
    const out = redactPdf(pdfiumOf(), baked.bytes, [{ pageIndex: 0, rects: [box] }])
    expect(await extractorLeaks(pdfium, out, secret)).toEqual([])
    expect(await wordsOn(out)).toEqual(['Public', 'words'])
  })

  it('a quarter-turned contour-less line: the band beside the baseline takes the word', async () => {
    // Up the page from (200, 20): the em lies to the LEFT of the baseline (x < 200).
    const page = handPage([{ y: 20, size: 20, x0: 200, angle: Math.PI / 2, words: flowWords(['Public', SECRET_WORD, 'words'], 10, 6) }]) // prettier-ignore
    const w = page.lines[0].words[1]
    const baked = await bakeLayer(await blankPdf(), [page], { ttf: noContour() })
    // PDFium reports zero-width bounds on the baseline itself.
    for (const o of pdfiumProbe(pdfium, baked.bytes).textObjects)
      expect(o.bounds.r - o.bounds.l).toBeLessThan(1)
    const box = { x: 191, y: w.y + 2, w: 7, h: w.w - 4 }
    const out = redactPdf(pdfiumOf(), baked.bytes, [{ pageIndex: 0, rects: [box] }])
    expect(await extractorLeaks(pdfium, out, secret)).toEqual([])
    expect(await wordsOn(out)).toEqual(['Public', 'words'])
    // Control: the frozen 1.1.3 engine misses it.
    const old = redactPdf113(pdfiumOf(), baked.bytes, [{ pageIndex: 0, rects: [box] }])
    expect(await wordsOn(old)).toEqual(['Public', SECRET_WORD, 'words'])
  })

  it('a skewed (30°) contour-less line: a box above the end of the word takes it', async () => {
    const a = Math.PI / 6
    const page = handPage([{ y: 100, size: 20, x0: 100, angle: a, words: flowWords(['Public', SECRET_WORD, 'words'], 10, 6) }]) // prettier-ignore
    const w = page.lines[0].words[1]
    const baked = await bakeLayer(await blankPdf(), [page], { ttf: noContour() })
    // 0.5 em up from the baseline at the word's end: outside the bounds of its (slanted)
    // baseline segment, inside its em box; both pad axes are non-zero at 30°.
    const s = w.w - 3
    const px = w.x + s * Math.cos(a) - 10 * Math.sin(a)
    const py = w.y + s * Math.sin(a) + 10 * Math.cos(a)
    const box = { x: px - 1, y: py - 1, w: 2, h: 2 }
    // The box meets no object's own bounds: only the pad can catch the word.
    for (const { bounds: o } of pdfiumProbe(pdfium, baked.bytes).textObjects)
      expect(o.r <= box.x || o.l >= box.x + 2 || o.t <= box.y || o.b >= box.y + 2).toBe(true)
    const out = redactPdf(pdfiumOf(), baked.bytes, [{ pageIndex: 0, rects: [box] }])
    expect(await extractorLeaks(pdfium, out, secret)).toEqual([])
    expect(await wordsOn(out)).not.toContain(SECRET_WORD)
  })

  it.each([1.2, 1.5])(
    'at %f em line pitch only the boxed object goes, and rule 2 keeps the lines around it',
    async (pitch) => {
      const rows = [
        ['Alpha', 'Bravo', 'Charl'],
        ['Delta', 'QVWJK', 'Foxtr'],
        ['Golfy', 'Hotel', 'India']
      ]
      const page = handPage(rows.map((words, k) => ({ y: 200 + (1 - k) * pitch * 20, size: 20, x0: 20, words: flowWords(words, 10, 6) }))) // prettier-ignore
      const sw = page.lines[1].words[1]
      const box = { x: sw.x + 2, y: sw.y + 2, w: sw.w - 4, h: 10 }
      // Our own glyph: its bounds are already a full em tall, so the pad must not grow them.
      const baked = await bakeLayer(await blankPdf(), [page])
      const before = pdfiumProbe(pdfium, baked.bytes).textObjects.length
      const { bytes, removed } = redactPdfReport(pdfiumOf(), baked.bytes, [{ pageIndex: 0, rects: [box] }]) // prettier-ignore
      expect(before - pdfiumProbe(pdfium, bytes).textObjects.length).toBe(1)
      expect(removed.get(0)).toHaveLength(1)
      const kept = rows.flat().filter((t) => t !== 'QVWJK')
      expect(await wordsOn(bytes)).toEqual(kept)
      // The report holds the object's own bounds: the OCR words of the lines around it stay.
      const key = makePageKey('pitch', 0)
      const gone = new Map([[key, removed.get(0)!.map((o) => pdfBoxToFrame(o.box, [0, 0, 400, 400], 0))]]) // prettier-ignore
      const layer = edits({ overlays: new Map([[key, [redaction(key, box)]]]) })
      const left = redactOcrPage(pack(page), layer, key, gone)
      expect(left ? unpack(left).lines.flatMap((l) => l.words.map((x) => x.t)) : []).toEqual(kept)
    }
  )
})

// ---------------------------------------------------------------------------------------------
// .pdfx: manifest, attachments, and the round trip

const PNG_1x1 = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII='
  ),
  (c) => c.charCodeAt(0)
)

describe('.pdfx round trip', () => {
  const page = handPage([
    { y: 300, size: 20, x0: 20, words: flowWords(['Public', 'notes'], 10, 6) },
    { y: 100, size: 20, x0: 20, words: flowWords(['Morning', SECRET_WORD], 10, 6) }
  ])
  const secret: Secret = { words: [SECRET_WORD], uniqueCps: uniqueCodePoints([SECRET_WORD], ['Public', 'notes', 'Morning']) } // prettier-ignore
  const sw = page.lines[1].words[1]
  const box = { x: sw.x - 2, y: 90, w: sw.w + 4, h: 30 }

  /** A text overlay repeating the secret under the box, and an image overlay elsewhere. */
  function overlays(key: string, attachment = 'img'): Overlay[] {
    const base = { pageKey: key, createdAt: 0, z: 0 }
    return [
      { ...base, id: 't', type: 'text', text: SECRET_WORD, fontSize: 12, color: { r: 0, g: 0, b: 0 }, font: 'Helvetica', align: 'left', geom: { x: box.x + 5, y: box.y + 5, w: 60, h: 14, rotation: 0, opacity: 1 } }, // prettier-ignore
      { ...base, id: 'i', type: 'image', attachmentId: attachment, mime: 'image/png', geom: { x: 300, y: 300, w: 20, h: 20, rotation: 0, opacity: 1 } }, // prettier-ignore
      { ...redaction(key, box), z: 1, createdAt: 1 }
    ]
  }

  it('the .pdfx (manifest and attachments searched) and a PDF exported from it reopened', async () => {
    const doc = await openDoc('px', await blankPdf())
    const key = makePageKey('px', 0)
    const layer = edits({
      overlays: new Map([[key, overlays(key)]]),
      attachments: new Map([['img', { bytes: PNG_1x1, mime: 'image/png' }]])
    })
    const { files } = await exportAs('pdfx', [doc], layer, new Map([[key, pack(page)]]))
    const pdfx = files[0]
    expect(await hasManifest(pdfx)).toBe(true)
    expect(await wordsOn(pdfx)).toEqual(['Public', 'notes', 'Morning'])
    await expectNoLeak([pdfx], secret)

    // Reopen the .pdfx as a source and export it again (its baked layer passes through).
    const again = await openDoc('px2', pdfx)
    for (const kind of ['pdf', 'pdfx'] as Kind[]) {
      const out = await exportAs(kind, [again], edits(), undefined)
      expect(await wordsOn(out.files[0])).toEqual(['Public', 'notes', 'Morning'])
      expect(await layerCount(out.files[0])).toBe(1)
      await expectNoLeak(out.files, secret)
    }
  })

  it('control: the oracle finds the secret in a manifest attachment and a document title', async () => {
    const doc = await openDoc('pxc', await blankPdf())
    const key = makePageKey('pxc', 0)
    const layer = edits({
      overlays: new Map([[key, overlays(key, 'leak').filter((o) => o.type === 'image')]]),
      attachments: new Map([['leak', { bytes: new TextEncoder().encode(`x${SECRET_WORD}x`), mime: 'image/png' }]]) // prettier-ignore
    })
    const { files } = await exportAs('pdfx', [doc], layer, undefined)
    const found = await rawLeaks(files[0], secret)
    expect(found.some((f) => f.startsWith('manifest attachment'))).toBe(true)
    const titled = await PDFDocument.load(files[0], { updateMetadata: false })
    titled.setTitle(`Re ${SECRET_WORD}`)
    const t = await rawLeaks(await titled.save(), secret)
    expect(t.some((f) => f.includes('utf-16be') || f.startsWith('string'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
// Re-redacting a reopened OCR'd PDF

describe("re-redacting a reopened OCR'd PDF", () => {
  const page = handPage([
    { y: 300, size: 20, x0: 20, words: flowWords(['Public', 'notes', 'kept'], 10, 6) },
    { y: 200, size: 20, x0: 20, words: flowWords(['Morning', SECRET_WORD, 'beside'], 10, 6) }
  ])
  const sw = page.lines[1].words[1]
  const box = { x: sw.x + 2, y: 202, w: sw.w - 4, h: 10 }
  const others = ['Public', 'notes', 'kept', 'Morning', 'beside']
  const secret: Secret = { words: [SECRET_WORD], uniqueCps: uniqueCodePoints([SECRET_WORD], others) } // prettier-ignore
  let first: Uint8Array
  let plain: Uint8Array

  beforeAll(async () => {
    const src = await blankPdf()
    const key = makePageKey('g1', 0)
    first = await buildPdf([{ bytes: src, sourceKey: 'g1', pageIndex: 0 }], edits({ ocr: new Map([[key, pack(page)]]) })) // prettier-ignore
    plain = await buildPdf([{ bytes: src, sourceKey: 'g1', pageIndex: 0 }], edits())
  })

  it('PDFium per word: keeps 3 Tr, renders as without the layer, removes only the boxed word', async () => {
    const before = pdfiumProbe(pdfium, first).textObjects
    const { bytes, removed } = redactPdfReport(pdfium, first, [{ pageIndex: 0, rects: [box] }])
    const after = pdfiumProbe(pdfium, bytes).textObjects
    // Exactly one object (the word's Tj) went, and the report names it with its bounds.
    expect(removed.get(0)).toHaveLength(1)
    expect(removed.get(0)![0].type).toBe(1)
    expect(before.length - after.length).toBe(1)
    const b = removed.get(0)![0].box!
    expect(b.l).toBeCloseTo(sw.x, 0)
    expect(b.r).toBeCloseTo(sw.x + sw.w, 0)
    // FPDFPage_GenerateContent keeps every survivor invisible...
    for (const o of after) expect(o.mode).toBe(3)
    // ...so the page renders exactly as the same redaction of the page without a layer.
    const noLayer = redactPdf(pdfium, plain, [{ pageIndex: 0, rects: [box] }])
    expect(raster(bytes, DPI).data).toEqual(raster(noLayer, DPI).data)
    expect(await wordsOn(bytes)).toEqual(others)
    expect(await extractorLeaks(pdfium, bytes, secret)).toEqual([])
  })

  it('the frozen 1.1.3 redactPage: both extractors lose the word too (font tables keep it)', async () => {
    const out = redactPdf113(pdfium as unknown as PdfiumModule, first, [{ pageIndex: 0, rects: [box] }]) // prettier-ignore
    expect(await extractorLeaks(pdfium, out, secret)).toEqual([])
    expect(await wordsOn(out)).toEqual(others)
    // What a per-word pass (any version, any tool) cannot do: trim the font tables. The oracle
    // finds the secret's characters only there, which is why the app's pass drops the layer.
    const found = await rawLeaks(out, secret)
    expect(found.length).toBeGreaterThan(0)
    for (const f of found) expect(f).toMatch(/ToUnicode|describes unshown CIDs/)
    // Positive control of the oracle's ToUnicode text check (not only of rule 5's CID check).
    expect(found.some((f) => /^ToUnicode of /.test(f))).toBe(true)
  })

  it('the sweep reports exactly the overlapping OCR object, with bounds over the boxed word', async () => {
    const before = pdfiumProbe(pdfium, first).textObjects.length
    const { bytes, removed } = redactPdfReport(pdfium, first, [{ pageIndex: 0, rects: [box] }], { dropOcrText: true }) // prettier-ignore
    // Every OCR object went; only the one under the box is reported.
    expect(pdfiumProbe(pdfium, bytes).textObjects).toHaveLength(0)
    expect(before).toBeGreaterThan(1)
    const got = removed.get(0)!
    expect(got).toHaveLength(1)
    expect(got[0].type).toBe(1)
    const b = got[0].box!
    expect(b.l).toBeLessThanOrEqual(sw.x + 0.5)
    expect(b.r).toBeGreaterThanOrEqual(sw.x + sw.w - 0.5)
    expect(b.b).toBeLessThanOrEqual(box.y)
    expect(b.t).toBeGreaterThanOrEqual(box.y + box.h)
    // The same through the export's report, in the overlay frame.
    const doc = await openDoc('re-report', first)
    const key = makePageKey('re-report', 0)
    const redacted = await buildRedactedSources(edits({ overlays: new Map([[key, [redaction(key, box)]]]) }), [doc], { pdfium, report: true }) // prettier-ignore
    const rects = redacted.removed!.get(key)!
    expect(rects).toHaveLength(1)
    expect(rects[0].x).toBeCloseTo(b.l, 3)
    expect(rects[0].w).toBeCloseTo(b.r - b.l, 3)
  })

  it.each(['pdf', 'pdfx', 'zip', 'sign'] as Kind[])(
    'in the app (%s): the redacted page loses its whole layer and the oracle finds nothing',
    async (kind) => {
      const doc = await openDoc(`re-${kind}`, first)
      const key = makePageKey(`re-${kind}`, 0)
      const layer = edits({ overlays: new Map([[key, [redaction(key, box)]]]) })
      const { files } = await exportAs(kind, [doc], layer, undefined)
      expect(await layerCount(files[0])).toBe(0)
      expect(await wordsOn(files[0])).toEqual([])
      await expectNoLeak(files, secret)
    }
  )
})

// ---------------------------------------------------------------------------------------------
// CJK: a three-character name, two of whose characters occur nowhere else

describe('a CJK name (chi_sim)', () => {
  const NAME = '张伟明'
  const page = handPage(
    [
      { y: 300, size: 20, x0: 20, words: flowWords(['联系人', NAME, '先生'], 20, 0) },
      { y: 200, size: 20, x0: 20, words: flowWords(['明天', '见'], 20, 0) }
    ],
    { langs: ['chi_sim'] }
  )
  const kept = ['联系人', '先生', '明天', '见']
  const secret: Secret = { words: [NAME], uniqueCps: uniqueCodePoints([NAME], kept) }
  const nw = page.lines[0].words[1]
  // Inset by more than the 3 pt footprint pad, so the touching neighbours stay.
  const box = { x: nw.x + 4, y: 302, w: nw.w - 8, h: 10 }

  it('two characters are unique to the name, one is not', () => {
    expect(secret.uniqueCps.map((c) => String.fromCodePoint(c))).toEqual(['张', '伟'])
  })

  it.each(['pdf', 'pdfx', 'zip'] as Kind[])(
    '%s: neither unique character anywhere',
    async (kind) => {
      const doc = await openDoc(`cjk-${kind}`, await blankPdf())
      const key = makePageKey(`cjk-${kind}`, 0)
      const layer = edits({ overlays: new Map([[key, [redaction(key, box)]]]) })
      const { files } = await exportAs(kind, [doc], layer, new Map([[key, pack(page)]]))
      const text = pdfjsCopyText((await pdfjsText(files[0])).items)
      expect(text.replace(/\s+/g, '')).toBe('联系人先生明天见')
      expect(text).toContain('明') // the shared character stays (control)
      await expectNoLeak(files, secret)
    }
  )

  it('control: without the redaction the oracle finds both characters', async () => {
    const doc = await openDoc('cjk-c', await blankPdf())
    const key = makePageKey('cjk-c', 0)
    const { files } = await exportAs('pdf', [doc], edits(), new Map([[key, pack(page)]]))
    const found = await rawLeaks(files[0], secret)
    for (const ch of ['张', '伟']) expect(found.some((f) => f.includes(`U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`))).toBe(true) // prettier-ignore
    expect(found.some((f) => f.includes('as CIDs'))).toBe(true)
    expect(await extractorLeaks(pdfium, files[0], secret)).not.toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// Other removed objects: an annotation and a vector stamp

describe('removed annotations and vector paths drop the words over them (rule 2)', () => {
  const page = handPage([
    { y: 300, size: 20, x0: 20, words: flowWords(['Public', 'notes'], 10, 6) },
    { y: 200, size: 20, x0: 20, words: flowWords(['Morning', 'tiles', SECRET_WORD], 10, 6) },
    { y: 100, size: 20, x0: 20, words: flowWords(['Bright', 'castle'], 10, 6) }
  ])
  const sw = page.lines[1].words[2]
  const box = { x: sw.x + 2, y: 202, w: sw.w - 4, h: 10 }

  it.each(['annotation', 'stamp'] as const)('%s', async (what) => {
    const src = await PDFDocument.create()
    const p = src.addPage([400, 400])
    // Spanning the whole middle line, so it overlaps the box and lies under every word there.
    const span = { x: 10, y: 190, w: 380, h: 30 }
    if (what === 'stamp')
      p.drawRectangle({ x: span.x, y: span.y, width: span.w, height: span.h, color: rgb(0.9, 0.9, 0.9) }) // prettier-ignore
    else
      p.node.set(
        PDFName.of('Annots'),
        src.context.obj([src.context.register(src.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [span.x, span.y, span.x + span.w, span.y + span.h] }))]) // prettier-ignore
      )
    const doc = await openDoc(`rm-${what}`, await src.save())
    const key = makePageKey(`rm-${what}`, 0)
    const layer = edits({ overlays: new Map([[key, [redaction(key, box)]]]) })
    const { files, redacted } = await exportAs('pdf', [doc], layer, new Map([[key, pack(page)]]))
    expect(redacted.removed!.get(key)).toHaveLength(1)
    expect(await wordsOn(files[0])).toEqual(['Public', 'notes', 'Bright', 'castle'])
    await expectNoLeak(files, { words: [SECRET_WORD, 'Morning', 'tiles'], uniqueCps: [] })
  })
})

// ---------------------------------------------------------------------------------------------
// The filter itself (ocr-export.ts redactOcrPage)

describe('redactOcrPage', () => {
  const key = makePageKey('u', 0)
  const page = pack(
    handPage([
      { y: 300, size: 20, x0: 20, words: flowWords(['alpha', 'beta'], 10, 6) },
      { y: 100, size: 20, x0: 20, words: flowWords(['gamma'], 10, 6) }
    ])
  )
  const words = (p: PackedOcrPage | null): string[] =>
    p ? unpack(p).lines.flatMap((l) => l.words.map((w) => w.t)) : []
  const over = (x: number, y: number): FrameBox => ({ x, y, w: 4, h: 4 })

  it('rule 1, whatever the z-order: a redaction under every overlay still drops the word', () => {
    const highlight: Overlay = { id: 'h', pageKey: key, z: 5, createdAt: 5, type: 'highlight', color: { r: 1, g: 1, b: 0 }, geom: { x: 0, y: 0, w: 400, h: 400, rotation: 0, opacity: 1 } } // prettier-ignore
    const layer = edits({ overlays: new Map([[key, [redaction(key, over(25, 305), 0), highlight]]]) }) // prettier-ignore
    expect(words(redactOcrPage(page, layer, key, new Map([[key, []]])))).toEqual(['beta', 'gamma'])
  })

  it.each([
    ['above', 'alpha', { x: 30, y: 316.5, w: 5, h: 1 }, { x: 30, y: 319.5, w: 5, h: 1 }],
    ['below', 'alpha', { x: 30, y: 294, w: 5, h: 1 }, { x: 30, y: 291.5, w: 5, h: 1 }],
    ['left of', 'alpha', { x: 17.5, y: 305, w: 1, h: 1 }, { x: 15.5, y: 305, w: 1, h: 1 }],
    ['right of', 'beta', { x: 116.5, y: 305, w: 1, h: 1 }, { x: 119.5, y: 305, w: 1, h: 1 }]
  ])(
    'rule 1 uses the padded footprint (§3.5.1): a box %s the quad, only in the 3 pt pad, drops %s',
    (_, word, inPad, outside) => {
      // Size 20: "alpha" quad x 20…70, "beta" x 76…116, both y 296…316 (descent 0.2, ascent
      // 0.8 em); pad max(1, 0.15 × 20) = 3 pt. Just outside the pad, nothing goes.
      const report = new Map([[key, []]])
      const at = (g: FrameBox): string[] =>
        words(redactOcrPage(page, edits({ overlays: new Map([[key, [redaction(key, g)]]]) }), key, report)) // prettier-ignore
      expect(at(inPad)).toEqual(['alpha', 'beta', 'gamma'].filter((w) => w !== word))
      expect(at(outside)).toEqual(['alpha', 'beta', 'gamma'])
    }
  )

  it('a rotated redaction covers its rotated footprint (mirror.ts footprint)', () => {
    // A thin box at the left, rotated −90° about its origin: it then reaches down to "gamma".
    const r = redaction(key, { x: 5, y: 150, w: 100, h: 2 })
    const rotated = { ...r, geom: { ...r.geom, rotation: -90 } as Geom }
    const layer = edits({ overlays: new Map([[key, [rotated]]]) })
    expect(words(redactOcrPage(page, layer, key, new Map([[key, []]])))).toEqual(['alpha', 'beta'])
  })

  it('rule 2: a removed object drops the words over it, with or without an overlay', () => {
    const layer = edits({ overlays: new Map([[key, [redaction(key, over(390, 390))]]]) })
    const gone = new Map([[key, [{ x: 0, y: 290, w: 400, h: 30 }]]])
    expect(words(redactOcrPage(page, layer, key, gone))).toEqual(['gamma'])
    expect(words(redactOcrPage(page, edits(), key, gone))).toEqual(['gamma'])
  })

  it('fail-safe: no report, no entry for the page, or an unknown extent drops the whole layer', () => {
    const layer = edits({ overlays: new Map([[key, [redaction(key, over(390, 390))]]]) })
    expect(redactOcrPage(page, layer, key, undefined)).toBeNull()
    expect(redactOcrPage(page, layer, key, new Map([['other#0', []]]))).toBeNull()
    expect(redactOcrPage(page, layer, key, new Map([[key, [{ x: NaN, y: 0, w: 1, h: 1 }]]]))).toBeNull() // prettier-ignore
    expect(redactOcrPage(page, edits(), key, new Map([[key, [{ x: 0, y: Infinity, w: 1, h: 1 }]]]))).toBeNull() // prettier-ignore
    // With an (empty) report the far-away box drops nothing.
    expect(redactOcrPage(page, layer, key, new Map([[key, []]]))).toBe(page)
    // No redaction and no report entry: the page as it is.
    expect(redactOcrPage(page, edits(), key, undefined)).toBe(page)
  })

  it('a word whose geometry is not finite cannot be proved clear, so it goes', () => {
    const bad = pack(handPage([{ y: NaN, size: 20, words: [{ t: 'nan', x: 10, w: 20 }] }, { y: 100, size: 20, words: [{ t: 'ok', x: 10, w: 20 }] }])) // prettier-ignore
    const layer = edits({ overlays: new Map([[key, [redaction(key, over(390, 390))]]]) })
    expect(words(redactOcrPage(bad, layer, key, new Map([[key, []]])))).toEqual(['ok'])
  })

  it('build.ts re-applies the filter: a layer handed over without withOcrLayer', async () => {
    const doc = await blankPdf()
    const layer = edits({ overlays: new Map([[key, [redaction(key, over(25, 305))]]]), ocr: new Map([[key, page]]) }) // prettier-ignore
    const exportPages = [{ bytes: doc, sourceKey: 'u', pageIndex: 0 }]
    // No report: the whole page's layer goes (fail-safe)...
    expect(await wordsOn(await buildPdf(exportPages, layer))).toEqual([])
    // ...with one, only the boxed word; the same for .pdfx.
    const reported = { ...layer, ocrRemoved: new Map([[key, []]]) }
    expect(await wordsOn(await buildPdf(exportPages, reported))).toEqual(['beta', 'gamma'])
    const pdfx = await buildPdfx([{ name: 'U', pages: exportPages }], 'U', reported)
    expect(await wordsOn(pdfx)).toEqual(['beta', 'gamma'])
    // withOcrLayer records the report it filtered against.
    expect(withOcrLayer(edits(), new Map([[key, page]]), { include: true, removed: reported.ocrRemoved }).ocrRemoved).toBe(reported.ocrRemoved) // prettier-ignore
  })

  it('keeps the OCR store intact: undoing the redaction brings the words back', () => {
    const layer = edits({ overlays: new Map([[key, [redaction(key, over(25, 305))]]]) })
    const ocr = new Map([[key, page]])
    const before = words(page)
    expect(words(withOcrLayer(layer, ocr, { include: true, removed: new Map([[key, []]]) }).ocr!.get(key)!)).toEqual(['beta', 'gamma']) // prettier-ignore
    expect(words(page)).toEqual(before)
    expect(words(withOcrLayer(edits(), ocr, { include: true, removed: new Map() }).ocr!.get(key)!)).toEqual(before) // prettier-ignore
  })
})

describe('the frozen 1.1.3 engine', () => {
  it('is byte-for-byte redact.ts at 6d5ed16 (its git blob id)', () => {
    const file = readFileSync(fileURLToPath(new URL('./test-utils/legacy/redact-1.1.3.ts', import.meta.url))) // prettier-ignore
    const blob = createHash('sha1').update(`blob ${file.length}\0`).update(file).digest('hex')
    expect(blob).toBe('53d8e1f1f44307af154cbeaa0b3b370ecb7f630e')
  })
})

describe('the layer stream on a page keeps its tag after filtering', () => {
  it('one tagged stream with only the kept words', async () => {
    const doc = await openDoc('tag', await framedPdf(0, false))
    const key = makePageKey('tag', 0)
    const page = framedOcr(0)
    const layer = edits({ overlays: new Map([[key, [redaction(key, secretBox(page))]]]) })
    const { files } = await exportAs('pdf', [doc], layer, new Map([[key, pack(page)]]))
    const out = await PDFDocument.load(files[0])
    const streams = existingOcrLayer(out.getPage(0)).streams
    expect(streams).toHaveLength(1)
    expect(isOcrLayerStream(streams[0])).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
// Native residue of the redaction pass (pre-existing since 1.1.3, closed in PR3b's review): what
// PDFium leaves of a redacted page that copyPages still carries into every export kind

/** A visible secret in Helvetica (a WinAnsi literal string in the content stream). */
const NATIVE = 'TOPSECRETZQ'
const NATIVE_BOX: FrameBox = { x: 45, y: 293, w: 200, h: 30 }

/** Every page object of `bytes` is in its page tree (no orphan copy of a page). */
async function expectNoOrphanPages(bytes: Uint8Array): Promise<void> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const leaves = doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFPageLeaf)
  expect(leaves).toHaveLength(doc.getPageCount())
}

/** The pages of `doc` (opened over `bytes` as source `id`) at `indices` only. */
async function someOf(id: string, bytes: Uint8Array, indices: number[]): Promise<DocEntry> {
  const doc = await openDoc(id, bytes)
  return { ...doc, pages: doc.pages.filter((p) => indices.includes(p.pageIndex)) }
}

describe('a page reached only by a reference is not copied (orphan pages)', () => {
  /**
   * Page 0 holds the secret; page 1 reaches page 0 through a Link /Dest, a GoTo /A, and a widget
   * whose field's /Kids lists page 0's widget (/P page 0).
   */
  async function linkedPdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const p0 = doc.addPage([400, 400])
    p0.drawText(NATIVE, { x: 50, y: 300, size: 20, font })
    p0.drawText('alpha notes', { x: 50, y: 100, size: 20, font })
    const p1 = doc.addPage([400, 400])
    p1.drawText('public words', { x: 50, y: 300, size: 20, font })
    const ctx = doc.context
    const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [50, 290, 200, 320], Border: [0, 0, 0], Dest: [p0.ref, 'XYZ', null, null, null] })) // prettier-ignore
    const goTo = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [50, 250, 200, 280], A: { S: 'GoTo', D: [p0.ref, 'Fit'] } })) // prettier-ignore
    const field = ctx.nextRef()
    const w0 = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Widget', Rect: [300, 50, 380, 70], P: p0.ref, Parent: field })) // prettier-ignore
    const w1 = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Widget', Rect: [300, 50, 380, 70], P: p1.ref, Parent: field })) // prettier-ignore
    ctx.assign(field, ctx.obj({ FT: 'Tx', T: PDFString.of('field'), Kids: [w0, w1] }))
    p0.node.set(PDFName.of('Annots'), ctx.obj([w0]))
    p1.node.set(PDFName.of('Annots'), ctx.obj([link, goTo, w1]))
    return doc.save({ useObjectStreams: false })
  }
  const secret: Secret = { words: [NATIVE], uniqueCps: [] }

  it('control: the raw copy carries the unredacted page 0 along with page 1', async () => {
    const bytes = await linkedPdf()
    const out = await PDFDocument.create()
    const src = await PDFDocument.load(bytes)
    out.addPage((await out.copyPages(src, [1]))[0])
    expect((await rawLeaks(await out.save(), secret)).length).toBeGreaterThan(0)
  })

  it.each(ALL_KINDS)(
    '%s: a redacted page and another copy of the same file (a duplicate) linking to it',
    async (kind) => {
      const bytes = await linkedPdf()
      const a = await someOf(`dup-a-${kind}`, bytes, [0])
      const b = await someOf(`dup-b-${kind}`, bytes, [1])
      const key = makePageKey(`dup-a-${kind}`, 0)
      const layer = edits({ overlays: new Map([[key, [redaction(key, NATIVE_BOX)]]]) })
      const { files } = await exportAs(kind, [a, b], layer, undefined)
      for (const f of files) await expectNoOrphanPages(f)
      await expectNoLeak(files, secret)
      const last = files[files.length - 1]
      const out = await PDFDocument.load(last)
      expect(await wordsOn(last, out.getPageCount() - 1)).toEqual(['public', 'words'])
      // The links lost their destination; the widget left its field's /Kids (and the field).
      const annots = out
        .getPage(out.getPageCount() - 1)
        .node.Annots()!
        .asArray()
      const dicts = annots.map((r) => out.context.lookup(r, PDFDict))
      expect(dicts[0].get(PDFName.of('Dest'))).toBeUndefined()
      expect(dicts[1].get(PDFName.of('A'))).toBeUndefined()
      const kids = dicts[2].lookup(PDFName.of('Parent'), PDFDict).lookup(PDFName.of('Kids'), PDFArray) // prettier-ignore
      expect(kids.size()).toBe(1)
    }
  )

  it.each(['pdf', 'pdfx'] as Kind[])(
    '%s: the redacted page itself was deleted from the collection',
    async (kind) => {
      const bytes = await linkedPdf()
      const doc = await someOf(`del-${kind}`, bytes, [1])
      const key = makePageKey(`del-${kind}`, 0)
      const layer = edits({ overlays: new Map([[key, [redaction(key, NATIVE_BOX)]]]) })
      const { files } = await exportAs(kind, [doc], layer, undefined)
      await expectNoOrphanPages(files[0])
      await expectNoLeak(files, secret)
      expect(await wordsOn(files[0])).toEqual(['public', 'words'])
    }
  )

  it('a link between two exported pages of one source keeps its destination', async () => {
    const bytes = await linkedPdf()
    const doc = await openDoc('keep-links', bytes)
    const { files } = await exportAs('pdf', [doc], edits(), undefined)
    const out = await PDFDocument.load(files[0])
    const link = out.context.lookup(out.getPage(1).node.Annots()!.get(0), PDFDict)
    const dest = link.lookup(PDFName.of('Dest'), PDFArray)
    expect(dest.get(0)).toBe(out.getPage(0).ref)
    await expectNoOrphanPages(files[0])
  })
})

describe('annotations tied to a removed one go with it (popup, reply)', () => {
  /** A note under the box, its popup in the margin, and a reply to it elsewhere. */
  async function notedPdf(listNote = true): Promise<Uint8Array> {
    const doc = await PDFDocument.create()
    const p = doc.addPage([400, 400])
    const ctx = doc.context
    const note = ctx.nextRef()
    const popup = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [300, 300, 395, 395], Parent: note })) // prettier-ignore
    ctx.assign(note, ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [50, 300, 70, 320], Contents: PDFString.of('MEMOXQJ'), Popup: popup })) // prettier-ignore
    const reply = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [300, 50, 320, 70], Contents: PDFString.of('REPLYKQ'), IRT: note })) // prettier-ignore
    p.node.set(PDFName.of('Annots'), ctx.obj(listNote ? [note, popup, reply] : [popup, reply]))
    return doc.save({ useObjectStreams: false })
  }
  const secret: Secret = { words: ['MEMOXQJ', 'REPLYKQ'], uniqueCps: [] }

  it.each(['pdf', 'pdfx'] as Kind[])('%s', async (kind) => {
    const doc = await openDoc(`note-${kind}`, await notedPdf())
    const key = makePageKey(`note-${kind}`, 0)
    const layer = edits({ overlays: new Map([[key, [redaction(key, { x: 40, y: 290, w: 210, h: 40 })]]]) }) // prettier-ignore
    const { files, redacted } = await exportAs(kind, [doc], layer, undefined)
    // All three are reported removed (the tied two are not under the box).
    expect(redacted.removed!.get(key)).toHaveLength(3)
    await expectNoLeak(files, secret)
    const pdf = await getDocument({ data: files[0].slice(), verbosity: 0 }).promise
    try {
      expect(await (await pdf.getPage(1)).getAnnotations()).toEqual([])
    } finally {
      await pdf.destroy()
    }
  })

  it('the pdf-lib pass drops a popup or reply whose annotation the page no longer lists', async () => {
    const out = await sanitizeRedacted(await notedPdf(false), [0])
    expect((await PDFDocument.load(out)).getPage(0).node.Annots()?.size() ?? 0).toBe(0)
    expect(await rawLeaks(out, secret)).toEqual([])
  })
})

describe("a redacted page's side copies of its content (PieceInfo, Thumb, Metadata)", () => {
  async function sidePdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const p = doc.addPage([400, 400])
    p.drawText(NATIVE, { x: 50, y: 300, size: 20, font })
    p.drawText('alpha notes', { x: 50, y: 100, size: 20, font })
    const ctx = doc.context
    const priv = ctx.register(ctx.flateStream(`%AI private (${NATIVE}) Tx`))
    p.node.set(PDFName.of('PieceInfo'), ctx.obj({ Illustrator: { LastModified: PDFString.of('D:20261128'), Private: { AIPrivateData1: priv } } })) // prettier-ignore
    p.node.set(PDFName.of('Thumb'), ctx.register(ctx.flateStream(new Uint8Array([10, 20, 30, 40]), { Type: 'XObject', Subtype: 'Image', Width: 2, Height: 2, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }))) // prettier-ignore
    p.node.set(PDFName.of('Metadata'), ctx.register(ctx.stream(`<x:xmpmeta>${NATIVE}</x:xmpmeta>`, { Type: 'Metadata', Subtype: 'XML' }))) // prettier-ignore
    p.node.set(PDFName.of('SeparationInfo'), ctx.obj({ Pages: [p.ref], DeviceColorant: 'Cyan' }))
    return doc.save({ useObjectStreams: false })
  }

  it.each(ALL_KINDS)('%s', async (kind) => {
    const bytes = await sidePdf()
    expect((await rawLeaks(bytes, { words: [NATIVE], uniqueCps: [] })).length).toBeGreaterThan(2) // control
    const doc = await openDoc(`side-${kind}`, bytes)
    const key = makePageKey(`side-${kind}`, 0)
    const layer = edits({ overlays: new Map([[key, [redaction(key, NATIVE_BOX)]]]) })
    const { files } = await exportAs(kind, [doc], layer, undefined)
    for (const f of files) {
      const node = (await PDFDocument.load(f)).getPage(0).node
      for (const k of ['PieceInfo', 'Thumb', 'Metadata', 'SeparationInfo'])
        expect(node.get(PDFName.of(k)), k).toBeUndefined()
      expect(await wordsOn(f)).toEqual(['alpha', 'notes'])
    }
    await expectNoLeak(files, { words: [NATIVE], uniqueCps: [] })
  })
})

// Native Type0 text: a pdf-lib subset font numbers its glyphs in first-use order.

const DEJAVU = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf', import.meta.url))) // prettier-ignore
)
const NATIVE_KEPT = 'public notes café'
const NATIVE_SECRET: Secret = { words: [SECRET_WORD], uniqueCps: uniqueCodePoints([SECRET_WORD], [NATIVE_KEPT]) } // prettier-ignore

/** The secret, then the kept line, both in a DejaVu Sans subset (Type0, Identity-H). */
async function dejavuPdf(gidStream = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const font = await doc.embedFont(DEJAVU, { subset: true })
  const p = doc.addPage([400, 400])
  p.drawText(SECRET_WORD, { x: 50, y: 300, size: 20, font })
  p.drawText(NATIVE_KEPT, { x: 50, y: 100, size: 20, font })
  const saved = await doc.save({ useObjectStreams: false })
  if (!gidStream) return saved
  // A CID font with an explicit CIDToGIDMap stream (identity, as a table) instead of /Identity.
  const again = await PDFDocument.load(saved)
  for (const [, o] of again.context.enumerateIndirectObjects())
    if (o instanceof PDFDict && o.get(PDFName.of('Subtype')) === PDFName.of('CIDFontType2')) {
      const map = new Uint8Array(512)
      for (let c = 0; c < 256; c++) map[2 * c + 1] = c
      o.set(PDFName.of('CIDToGIDMap'), again.context.register(again.context.flateStream(map)))
    }
  return again.save({ useObjectStreams: false })
}

const decoded = (s: PDFStream): Uint8Array =>
  s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents()

/** The DejaVu font of `bytes`: CID → text, CID → GID, and the GIDs with any outline data. */
async function dejavuTables(
  bytes: Uint8Array
): Promise<{ text: Map<number, string>; gid: (c: number) => number; outlined: Set<number> }> {
  // prettier-ignore
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFDict) || !o.lookupMaybe(PDFName.of('BaseFont'), PDFName)?.decodeText().includes('DejaVu')) continue // prettier-ignore
    if (o.get(PDFName.of('Subtype')) !== PDFName.of('Type0')) continue
    const text = parseToUnicode(new TextDecoder('latin1').decode(decoded(o.lookup(PDFName.of('ToUnicode'), PDFStream)))) // prettier-ignore
    const cid = doc.context.lookup(
      o.lookup(PDFName.of('DescendantFonts'), PDFArray).get(0),
      PDFDict
    )
    const m = cid.get(PDFName.of('CIDToGIDMap'))
    const table = m instanceof PDFRef ? decoded(doc.context.lookup(m, PDFStream)) : null
    const gid = (c: number): number => (table ? (table[2 * c] << 8) | table[2 * c + 1] : c)
    const desc = cid.lookup(PDFName.of('FontDescriptor'), PDFDict)
    const ttf = decoded(desc.lookup(PDFName.of('FontFile2'), PDFStream))
    const dv = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength)
    const tables = new Map<string, number>()
    for (let t = 0; t < dv.getUint16(4); t++)
      tables.set(String.fromCharCode(...ttf.subarray(12 + 16 * t, 16 + 16 * t)), dv.getUint32(12 + 16 * t + 8)) // prettier-ignore
    const long = dv.getInt16(tables.get('head')! + 50) === 1
    const n = dv.getUint16(tables.get('maxp')! + 4)
    const loca = tables.get('loca')!
    const at = (g: number): number => (long ? dv.getUint32(loca + 4 * g) : 2 * dv.getUint16(loca + 2 * g)) // prettier-ignore
    const outlined = new Set<number>()
    for (let g = 0; g < n; g++)
      if (ttf.subarray(tables.get('glyf')! + at(g), tables.get('glyf')! + at(g + 1)).some((v) => v !== 0)) outlined.add(g) // prettier-ignore
    return { text, gid, outlined }
  }
  throw new Error('no DejaVu font')
}

describe('native Type0 text in a subset font: its tables and outlines keep only what is shown', () => {
  it.each([
    ['/Identity', false],
    ['a CIDToGIDMap stream', true]
  ] as const)('%s', async (_, gidStream) => {
    const bytes = await dejavuPdf(gidStream)
    const before = await dejavuTables(bytes)
    // Control: the subset's ToUnicode spells the secret out in order, and draws it.
    const order = [...before.text]
      .sort((x, y) => x[0] - y[0])
      .map(([, t]) => t)
      .join('')
    expect(order.startsWith(SECRET_WORD)).toBe(true)
    const secretCids = [...before.text].filter(([, t]) => SECRET_WORD.includes(t)).map(([c]) => c)
    expect(secretCids).toHaveLength(SECRET_WORD.length)
    for (const c of secretCids) expect(before.outlined.has(before.gid(c))).toBe(true)
    expect((await rawLeaks(bytes, NATIVE_SECRET)).length).toBeGreaterThan(0)

    for (const kind of ['pdf', 'pdfx', 'zip'] as Kind[]) {
      const id = `dv-${gidStream ? 'map' : 'id'}-${kind}`
      const doc = await openDoc(id, bytes)
      const key = makePageKey(id, 0)
      const layer = edits({ overlays: new Map([[key, [redaction(key, NATIVE_BOX)]]]) })
      const { files } = await exportAs(kind, [doc], layer, undefined)
      for (const f of files) {
        expect(await wordsOn(f)).toEqual(NATIVE_KEPT.split(' '))
        const after = await dejavuTables(f)
        for (const c of secretCids) {
          expect(after.text.has(c)).toBe(false)
          expect(after.outlined.has(before.gid(c))).toBe(false)
        }
        // What is shown keeps its outline.
        for (const [c, t] of after.text) if (t !== ' ') expect(after.outlined.has(after.gid(c)), t).toBe(true) // prettier-ignore
      }
      await expectNoLeak(files, NATIVE_SECRET)
    }
  })

  it('trimming changes no pixel of the redacted page', async () => {
    const bytes = await dejavuPdf()
    const user = { x: NATIVE_BOX.x, y: NATIVE_BOX.y, w: NATIVE_BOX.w, h: NATIVE_BOX.h }
    const redacted = redactPdf(pdfium as unknown as PdfiumModule, bytes, [{ pageIndex: 0, rects: [user] }]) // prettier-ignore
    const clean = await sanitizeRedacted(redacted, [0])
    expect(raster(clean, 144).data).toEqual(raster(redacted, 144).data)
    // ...nor of a page sharing the font that was not redacted at all.
    expect(raster(await sanitizeRedacted(bytes, []), 144).data).toEqual(raster(bytes, 144).data)
    // Four 144-dpi renders: ~1 s alone, but it passed the 5 s default under a loaded machine.
  }, 30_000)

  it('a Form XObject showing text in the font its caller set keeps every glyph', async () => {
    // The text font is graphics state: a form shows in whatever font was in effect at its Do.
    const doc = await PDFDocument.create()
    doc.registerFontkit(fontkit)
    const font = await doc.embedFont(DEJAVU, { subset: true })
    const p = doc.addPage([400, 400])
    p.drawText('public', { x: 50, y: 300, size: 20, font })
    const name = [...p.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).keys()][0]
    const shown = `BT 1 0 0 1 50 200 Tm ${font.encodeText('zqxw').toString()} Tj ET`
    const formRef = doc.context.register(
      doc.context.stream(shown, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 400] })
    )
    const x = p.node.newXObject('X', formRef)
    const call = `q BT ${name.toString()} 20 Tf ET ${x.toString()} Do Q`
    p.node.addContentStream(doc.context.register(doc.context.stream(call)))
    const bytes = await doc.save({ useObjectStreams: false })
    const clean = await sanitizeRedacted(bytes, [])
    expect(raster(clean, 144).data).toEqual(raster(bytes, 144).data)
    expect([...(await dejavuTables(clean)).text.values()].join('')).toContain('zqxw')
  })
})

describe('a Unicode text overlay next to an OCR layer (both pdf-lib Type0 subsets)', () => {
  it.each(['pdf', 'pdfx'] as Kind[])('%s', async (kind) => {
    stubUnicodeFontFetch()
    try {
      const page = handPage([{ y: 200, size: 20, x0: 20, words: flowWords(['Public', SECRET_WORD, 'words'], 10, 6) }]) // prettier-ignore
      const sw = page.lines[0].words[1]
      const doc = await openDoc(`uni-${kind}`, await blankPdf())
      const key = makePageKey(`uni-${kind}`, 0)
      const text: Overlay = { id: 'uni', pageKey: key, z: 0, createdAt: 0, type: 'text', text: 'Ωmega café', fontSize: 14, color: { r: 0, g: 0, b: 0 }, font: 'Helvetica', align: 'left', geom: { x: 20, y: 300, w: 200, h: 20, rotation: 0, opacity: 1 } } // prettier-ignore
      const box = { x: sw.x + 2, y: 202, w: sw.w - 4, h: 10 }
      const layer = edits({ overlays: new Map([[key, [text, { ...redaction(key, box), z: 1, createdAt: 1 }]]]) }) // prettier-ignore
      const { files } = await exportAs(kind, [doc], layer, new Map([[key, pack(page)]]))
      const secret: Secret = { words: [SECRET_WORD], uniqueCps: uniqueCodePoints([SECRET_WORD], ['Public', 'words', 'Ωmega café']) } // prettier-ignore
      await expectNoLeak(files, secret)
      const all = pdfjsCopyText((await pdfjsText(files[0])).items)
      expect(all).toContain('Public')
      if (kind === 'pdf') expect(all).toContain('Ωmega')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('a page with /UserUnit 2: the frame is twice the user space', () => {
  async function unitPdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const p = doc.addPage([400, 400])
    p.node.set(PDFName.of('UserUnit'), PDFNumber.of(2))
    p.drawText(NATIVE, { x: 50, y: 300, size: 20, font })
    p.drawText('alpha', { x: 50, y: 100, size: 20, font })
    return doc.save({ useObjectStreams: false })
  }

  it.each(['pdf', 'pdfx'] as Kind[])('%s', async (kind) => {
    const doc = await openDoc(`uu-${kind}`, await unitPdf())
    expect([doc.pages[0].width, doc.pages[0].height]).toEqual([800, 800])
    const key = makePageKey(`uu-${kind}`, 0)
    // In the frame the secret's baseline is at (100, 600).
    const box = { x: 95, y: 590, w: 310, h: 50 }
    const ocr = handPage([{ y: 400, size: 24, x0: 100, words: flowWords(['Harbor'], 20, 0) }])
    const layer = edits({ overlays: new Map([[key, [redaction(key, box)]]]) })
    const { files, redacted } = await exportAs(kind, [doc], layer, new Map([[key, pack(ocr)]]))
    expect(await extractorLeaks(pdfium, files[0], { words: [NATIVE], uniqueCps: [] })).toEqual([])
    // The report is in the frame too: the removed text object lies inside the box.
    const gone = redacted.removed!.get(key)!
    expect(gone).toHaveLength(1)
    expect(gone[0].x).toBeGreaterThanOrEqual(box.x)
    expect(gone[0].x + gone[0].w).toBeLessThanOrEqual(box.x + box.w)
    expect(gone[0].y).toBeGreaterThanOrEqual(box.y)
    // The OCR word lands where the frame put it.
    const t = await pdfjsText(files[0])
    const item = t.items.find((i) => i.str === 'Harbor')!
    const [x, y] = toOverlay(t, item.transform[4], item.transform[5])
    expect(x).toBeCloseTo(100, 0)
    expect(y).toBeCloseTo(400, 0)
    expect(await wordsOn(files[0])).toEqual(['Harbor', 'alpha'])
  })
})
