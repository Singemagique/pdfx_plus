// Fixtures and probes for the OCR text-layer suite (ocr-layer*.node.test.ts). Test-only: it lives
// inside src/renderer/src so tsconfig.web.json type-checks it, and is excluded from coverage.
//
// - `ocrPageFromGt` turns a synth page's ground truth into the OcrPage an ideal engine would have
//   returned (exact baseline origin, advance, angle and size), so the suite tests the LAYER, not an
//   engine. `handPage` builds one from literal words (CJK, ligatures, many characters, …).
// - `bakeLayer` runs the real export path: load → appendOcrLayer → OcrFontCache.finalize → save.
// - The probes read the saved bytes back the way the two shipped extractors do: pdf.js
//   (`getTextContent`, the app's search extractor) and PDFium (FPDFText_*, FPDFPageObj_GetBounds),
//   each through a whitespace-PRESERVING path (test-utils/pdfium.ts `extractText` collapses \s+).

import { PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
// Run pdf.js's worker in-process (its "fake worker": it picks up globalThis.pdfjsWorker).
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'

import { pack, type OcrLine, type OcrPage, type PackedOcrPage } from '../../../../shared/ocr/types'
import { applyAffine, type Affine } from '../../../../shared/ocr/test-utils/degrade'
import type { SynthGt } from '../../../../shared/ocr/test-utils/synth'
import { intrinsicMatrix, viewBox } from '../build'
import { OcrFontCache, type OcrFontOptions } from '../ocr-font'
import { appendOcrLayer, type OcrPageSpace } from '../ocr-layer'
import type { TextPdfium } from '../../test-utils/pdfium'

// ---------------------------------------------------------------------------------------------
// OcrPages

const META: Omit<OcrPage, 'lines'> = {
  v: 1,
  engineId: 'test/replay',
  dataHashes: {},
  langs: ['eng'],
  pipelineVersion: 1,
  pageClass: 'scanned',
  renderDpi: 300,
  physDpi: 300,
  orientation: 0,
  skewDeg: 0,
  meanConfCal: 0.95,
  confSource: 'word',
  status: 'ok'
}

/** The OcrPage an ideal engine returns for a synth page: every GT word, exactly placed. */
export function ocrPageFromGt(gt: SynthGt, meta: Partial<Omit<OcrPage, 'lines'>> = {}): OcrPage {
  const m = gt.toOutput as Affine
  const scale = Math.hypot(m[0], m[1])
  const angle = Math.atan2(m[1], m[0])
  const lines: OcrLine[] = gt.lines.map((l) => ({
    angle: Math.abs(angle) < 1e-9 ? 0 : angle,
    size: l.size * scale,
    words: l.words.map((wi) => {
      const w = gt.words[wi]
      const [x, y] = applyAffine(m, w.srcBox.x, l.baseline)
      return { t: w.t, x, y, w: w.srcBox.w * scale, conf: 96, confCal: 0.97 }
    })
  }))
  return { ...META, ...meta, lines }
}

export interface HandWord {
  t: string
  x: number
  w: number
}

/** A page of hand-made lines: each line's words on one baseline `y` at size `size`. */
export function handPage(
  lines: { y: number; size: number; angle?: number; x0?: number; words: HandWord[] }[],
  meta: Partial<Omit<OcrPage, 'lines'>> = {}
): OcrPage {
  return {
    ...META,
    ...meta,
    lines: lines.map((l) => {
      const angle = l.angle ?? 0
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const x0 = l.x0 ?? 0
      return {
        angle,
        size: l.size,
        words: l.words.map((w) => ({
          t: w.t,
          // `x` is the distance along the baseline from (x0, y).
          x: x0 + w.x * cos,
          y: l.y + w.x * sin,
          w: w.w,
          conf: 90,
          confCal: 0.9
        }))
      }
    })
  }
}

/** Words laid out left to right with a fixed advance per character and a fixed gap. */
export function flowWords(texts: string[], charW: number, gap: number, x0 = 0): HandWord[] {
  const out: HandWord[] = []
  let x = x0
  for (const t of texts) {
    const w = [...t].length * charW
    out.push({ t, x, w })
    x += w + gap
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Baking

/** The overlay → user space pair of page `index` of `doc`, exactly as build.ts `bakePage` uses. */
export function pageSpaceOf(doc: PDFDocument, index = 0): OcrPageSpace {
  const page = doc.getPage(index)
  const intrinsic = ((page.getRotation().angle % 360) + 360) % 360
  const view0 = viewBox(page.getCropBox(), page.getMediaBox())
  return {
    view: { x: view0.x, y: view0.y },
    intrinsic: intrinsicMatrix(intrinsic, view0.width, view0.height)
  }
}

export interface BakeOptions extends OcrFontOptions {
  /** Test-only: rewrite every `3 Tr` to this mode (the invisibility check uses 0). */
  renderMode?: number
  /** Drop every original content stream (the layer alone). */
  layerOnly?: boolean
}

export interface Baked {
  bytes: Uint8Array
  /** The layer stream's uncompressed content. */
  content: string
}

/** Bake `pages[i]` onto page i of `pdf` through the real append + finalize path and save. */
export async function bakeLayer(
  pdf: Uint8Array,
  pages: (OcrPage | PackedOcrPage | null)[],
  opts: BakeOptions = {}
): Promise<Baked> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false })
  const fonts = new OcrFontCache(doc, opts)
  let content = ''
  pages.forEach((p, i) => {
    if (!p) return
    const packed = 'lines' in p ? pack(p) : p
    const page = doc.getPage(i)
    if (opts.layerOnly) page.node.set(PDFName.of('Contents'), doc.context.obj([]))
    const ref = appendOcrLayer(page, packed, fonts, { space: pageSpaceOf(doc, i) })
    if (!ref) return
    const stream = doc.context.lookup(ref, PDFStream)
    let text = new TextDecoder().decode(decodeStream(stream))
    if (opts.renderMode !== undefined) {
      text = text.replace(/ 3 Tr /g, ` ${opts.renderMode} Tr `)
      // Replace the stream body in place (same dict, so /PDFxOCRLayer stays).
      const raw = doc.context.flateStream(new TextEncoder().encode(text), { PDFxOCRLayer: true })
      doc.context.assign(ref, raw)
    }
    content += text
  })
  fonts.finalize(doc)
  return { bytes: await doc.save({ useObjectStreams: false }), content }
}

/** Decode a stream's data (Flate or unfiltered). */
export function decodeStream(stream: PDFStream): Uint8Array {
  return stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents()
}

/** Every stream in a saved PDF, decoded, with its dictionary. */
export async function allStreams(
  bytes: Uint8Array
): Promise<{ ref: PDFRef; stream: PDFStream; data: Uint8Array }[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const out: { ref: PDFRef; stream: PDFStream; data: Uint8Array }[] = []
  for (const [ref, obj] of doc.context.enumerateIndirectObjects())
    if (obj instanceof PDFStream) out.push({ ref, stream: obj, data: decodeStream(obj) })
  return out
}

// ---------------------------------------------------------------------------------------------
// pdf.js probe

export interface PdfjsItem {
  str: string
  hasEOL: boolean
  /** Text space → user space (includes the font size and Tz). */
  transform: number[]
  width: number
  height: number
  fontName: string
  ascent: number
  descent: number
}

export interface PdfjsText {
  items: PdfjsItem[]
  /** getViewport({ scale: 1 }).transform: user space → display px (y down). */
  vt: number[]
  /** Visual page height (display px at scale 1). */
  height: number
}

/** pdf.js 5.7.284 `getTextContent` of one page (legacy build, in-process worker). */
export async function pdfjsText(bytes: Uint8Array, pageIndex = 0): Promise<PdfjsText> {
  const pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise
  try {
    const page = await pdf.getPage(pageIndex + 1)
    const vp = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const styles = content.styles as Record<string, { ascent?: number; descent?: number }>
    const items: PdfjsItem[] = []
    for (const it of content.items) {
      if (!('str' in it)) continue
      const st = styles[it.fontName] ?? {}
      items.push({
        str: it.str,
        hasEOL: it.hasEOL,
        transform: it.transform as number[],
        width: it.width,
        height: it.height,
        fontName: it.fontName,
        ascent: st.ascent ?? 0.8,
        descent: st.descent ?? -0.2
      })
    }
    return { items, vt: vp.transform as number[], height: vp.height }
  } finally {
    await pdf.destroy()
  }
}

/**
 * The text a viewer copies from pdf.js items: `str`s concatenated, "\n" at every hasEOL, and the
 * whitespace at each line's end trimmed (the layer's trailing space is a word separator for
 * extractors that join lines, not part of the line).
 */
export function pdfjsCopyText(items: readonly PdfjsItem[]): string {
  let s = ''
  for (const it of items) s += it.str + (it.hasEOL ? '\n' : '')
  return s
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '')
}

/** A user-space point → the overlay frame (visual page, bottom-left origin) of a pdf.js page. */
export function toOverlay(t: PdfjsText, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = t.vt
  return [a * x + c * y + e, t.height - (b * x + d * y + f)]
}

// ---------------------------------------------------------------------------------------------
// PDFium probe

/** The text and box calls the probes use, beyond the redaction engine's PdfiumModule. */
export interface ProbePdfium extends TextPdfium {
  FPDFText_GetUnicode(tp: number, i: number): number
  FPDFText_IsGenerated(tp: number, i: number): number
  FPDFText_GetCharBox(tp: number, i: number, l: number, r: number, b: number, t: number): boolean
  FPDFText_GetLooseCharBox(tp: number, i: number, rect: number): boolean
  FPDFText_GetTextObject(tp: number, i: number): number
  FPDFPageObj_GetType(obj: number): number
  FPDFTextObj_GetTextRenderMode(obj: number): number
  FPDFTextObj_GetFontSize(obj: number, size: number): boolean
  FPDF_GetPageWidthF(page: number): number
  FPDF_GetPageHeightF(page: number): number
  pdfium: TextPdfium['pdfium'] & { getValue(ptr: number, type: string): number }
}

export interface Box4 {
  l: number
  b: number
  r: number
  t: number
}

export interface PdfiumChar {
  ch: string
  generated: boolean
  /** FPDFText_GetCharBox (glyph bbox based), user space. */
  box: Box4
  /** FPDFText_GetLooseCharBox (font ascent/descent based), user space. */
  loose: Box4
  /** The text object's render mode (−1 for generated chars, which have none). */
  mode: number
}

export interface PdfiumTextObject {
  bounds: Box4
  mode: number
  fontSize: number
}

export interface PdfiumPageProbe {
  /** FPDFText_GetText over every char: whitespace exactly as PDFium reports it. */
  text: string
  chars: PdfiumChar[]
  /** Top-level text page objects (FPDF_PAGEOBJ_TEXT = 1) and their FPDFPageObj_GetBounds. */
  textObjects: PdfiumTextObject[]
}

function withPage<T>(
  pdfium: ProbePdfium,
  bytes: Uint8Array,
  index: number,
  fn: (page: number) => T
): T {
  const rt = pdfium.pdfium
  const ptr = rt.wasmExports.malloc(bytes.length)
  rt.HEAPU8.set(bytes, ptr)
  const doc = pdfium.FPDF_LoadMemDocument(ptr, bytes.length, '')
  try {
    if (!doc) throw new Error('PDFium could not open the document')
    const page = pdfium.FPDF_LoadPage(doc, index)
    try {
      return fn(page)
    } finally {
      pdfium.FPDF_ClosePage(page)
    }
  } finally {
    if (doc) pdfium.FPDF_CloseDocument(doc)
    rt.wasmExports.free(ptr)
  }
}

/** Probe one page with PDFium: whitespace-preserving text, per-char boxes, text-object bounds. */
export function pdfiumProbe(pdfium: ProbePdfium, bytes: Uint8Array, index = 0): PdfiumPageProbe {
  return withPage(pdfium, bytes, index, (page) => {
    const rt = pdfium.pdfium
    const f = rt.wasmExports.malloc(64)
    const tp = pdfium.FPDFText_LoadPage(page)
    try {
      const n = pdfium.FPDFText_CountChars(tp)
      const buf = rt.wasmExports.malloc((n + 1) * 2)
      let text = ''
      try {
        // Zeroed first: on a page with no chars PDFium writes nothing, not even the NUL, and the
        // malloc'd bytes would read back as text. The result counts the NUL it wrote.
        rt.HEAPU8.fill(0, buf, buf + (n + 1) * 2)
        const written = n > 0 ? pdfium.FPDFText_GetText(tp, 0, n, buf) : 0
        text = written > 1 ? rt.UTF16ToString(buf).slice(0, written - 1) : ''
      } finally {
        rt.wasmExports.free(buf)
      }
      const chars: PdfiumChar[] = []
      for (let i = 0; i < n; i++) {
        const u = pdfium.FPDFText_GetUnicode(tp, i)
        // GetCharBox: doubles l, r, b, t.
        pdfium.FPDFText_GetCharBox(tp, i, f, f + 8, f + 16, f + 24)
        const box = {
          l: rt.getValue(f, 'double'),
          r: rt.getValue(f + 8, 'double'),
          b: rt.getValue(f + 16, 'double'),
          t: rt.getValue(f + 24, 'double')
        }
        // GetLooseCharBox: FS_RECTF { left, top, right, bottom } floats.
        pdfium.FPDFText_GetLooseCharBox(tp, i, f + 32)
        const loose = {
          l: rt.getValue(f + 32, 'float'),
          t: rt.getValue(f + 36, 'float'),
          r: rt.getValue(f + 40, 'float'),
          b: rt.getValue(f + 44, 'float')
        }
        const generated = pdfium.FPDFText_IsGenerated(tp, i) === 1
        const obj = generated ? 0 : pdfium.FPDFText_GetTextObject(tp, i)
        chars.push({
          ch: String.fromCodePoint(u),
          generated,
          box,
          loose,
          mode: obj ? pdfium.FPDFTextObj_GetTextRenderMode(obj) : -1
        })
      }
      const textObjects: PdfiumTextObject[] = []
      const count = pdfium.FPDFPage_CountObjects(page)
      for (let i = 0; i < count; i++) {
        const obj = pdfium.FPDFPage_GetObject(page, i)
        if (pdfium.FPDFPageObj_GetType(obj) !== 1) continue
        pdfium.FPDFPageObj_GetBounds(obj, f, f + 4, f + 8, f + 12)
        const bounds = {
          l: rt.getValue(f, 'float'),
          b: rt.getValue(f + 4, 'float'),
          r: rt.getValue(f + 8, 'float'),
          t: rt.getValue(f + 12, 'float')
        }
        pdfium.FPDFTextObj_GetFontSize(obj, f + 16)
        textObjects.push({
          bounds,
          mode: pdfium.FPDFTextObj_GetTextRenderMode(obj),
          fontSize: rt.getValue(f + 16, 'float')
        })
      }
      return { text, chars, textObjects }
    } finally {
      pdfium.FPDFText_ClosePage(tp)
      rt.wasmExports.free(f)
    }
  })
}

/**
 * PDFium's text as a viewer copies it: FPDFText_GetText with "\r\n" → "\n" and each line's
 * trailing whitespace trimmed. Generated chars (PDFium's own inferred spaces and line breaks) are
 * part of it, exactly as in a real copy.
 *
 * A line ending in "-" triggers PDFium's dehyphenation: it reports U+FFFE in place of the hyphen
 * and drops the line break ("An inter￾national deal") [measured]. That is mapped back to "-"
 * plus a line break, so the comparison is with the text as laid out. Any PDFium-based oracle
 * (PR3b's raw/extractor checks) must apply the same normalisation.
 */
export function pdfiumCopyText(probe: PdfiumPageProbe): string {
  return probe.text
    .replace(/￾(\r\n?|\n)?/g, '-\n')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '')
}

// ---------------------------------------------------------------------------------------------
// Geometry

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export const area = (r: Rect): number => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0)

export function iou(a: Rect, b: Rect): number {
  const i = area({
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1)
  })
  const u = area(a) + area(b) - i
  return u > 0 ? i / u : 0
}

export const union = (rs: readonly Rect[]): Rect => ({
  x0: Math.min(...rs.map((r) => r.x0)),
  y0: Math.min(...rs.map((r) => r.y0)),
  x1: Math.max(...rs.map((r) => r.x1)),
  y1: Math.max(...rs.map((r) => r.y1))
})

export const boxRect = (b: Box4): Rect => ({ x0: b.l, y0: b.b, x1: b.r, y1: b.t })

/** A pdf.js item's box in user space (axis-aligned bounding box of its rotated em box). */
export function pdfjsItemRect(it: PdfjsItem): Rect {
  // (c, d) is the em-tall vertical axis, so ascent/descent fractions scale it directly.
  const [a, b, c, d, e, f] = it.transform
  const ux = a / Math.hypot(a, b)
  const uy = b / Math.hypot(a, b)
  const corners: [number, number][] = []
  for (const along of [0, it.width])
    for (const up of [it.descent, it.ascent]) {
      const vx = c * up
      const vy = d * up
      corners.push([e + ux * along + vx, f + uy * along + vy])
    }
  return {
    x0: Math.min(...corners.map((p) => p[0])),
    y0: Math.min(...corners.map((p) => p[1])),
    x1: Math.max(...corners.map((p) => p[0])),
    y1: Math.max(...corners.map((p) => p[1]))
  }
}
