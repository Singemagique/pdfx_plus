// Stage 1 triage in the raster thread (DESIGN.md §3.4.1): gather each page's signals with PDFium,
// without rendering, and classify them with the pure rules in src/shared/ocr/triage.ts. Kept free
// of worker_threads like raster-core.ts, so it runs in vitest against the real WASM.
//
// Per document: encryption first (FPDF_GetSecurityHandlerRevision ≠ −1 → every page `protected`,
// §3.0 #17; nothing else is read). Per page:
// - FPDFText_*: every char, skipping generated ones BEFORE asking for a render mode (a generated
//   char has no text object, PR0); render mode 3/7 or a glyphless OCR font = invisible; the visible
//   chars' boxes (GetCharBox returns doubles l, r, b, t) give the text area (an exact union), the
//   band and the visible native words; FPDFText_HasUnicodeMapError (= 1) and the code points give
//   the broken-text signals.
// - Page objects, recursing into Form XObjects: image bounds for the coverage, marks (/PDFxOCR on
//   text, /PDFxImportedImage on images), and the dominant image. Composition rule (PR0): an object
//   inside a Form already has that Form's /Matrix in its GetMatrix, and a form object's GetMatrix
//   is only the CTM at its `Do`, so fullCTM = child × Π ancestor form objects' GetMatrix.
// - The dominant image (largest placed area): pixel size (GetImagePixelSize, no decode) against
//   the placed size → d_eff; PDFium's own dpi fields are wrong on rotated placements and never
//   used. FPDFImageObj_GetImageMetadata WITH the page decodes a JPX image (CPDF_DIB::
//   StartLoadDIBBase → LoadJpxBitmap), which is exactly the trap the pre-check exists to avoid, so
//   it is called only for non-JPX images (for bits_per_pixel).
// - Every JPX image on the page (rendering decodes them all, not only the dominant one) goes
//   through the SIZ pre-check, with its /ColorSpace read from the file bytes.

import {
  IDENTITY,
  IMPORTED_IMAGE_MARK,
  bandFraction,
  classifyPage,
  effectiveDpi,
  emptyQuality,
  isForeignGlyphlessFont,
  isSpaceChar,
  baseFontCore,
  jpxPrecheck,
  makeByteFind,
  mulMatrix,
  placedArea,
  selectRenderDpi,
  streamColourComponents,
  tallyChar,
  toOverlayFrame,
  unionArea,
  unitSquareBounds,
  wantsNativeWords,
  type JpxRefusal,
  type Matrix6,
  type NativeWord,
  type PageFrame,
  type PageSignals,
  type PixelCaps,
  type TriagePage
} from '../../../shared/ocr/triage'
import { OCR_LIMITS, TRIAGE_WORD_LIMITS } from '../../../shared/ocr/protocol'
import type { OcrRect } from '../../../shared/ocr/types'

/** The PDFium calls triage needs (a structural subset of `@embedpdf/pdfium`'s wrapper). */
export interface PdfiumTriage {
  FPDF_GetSecurityHandlerRevision(doc: number): number
  FPDF_GetPageCount(doc: number): number
  FPDF_LoadPage(doc: number, index: number): number
  FPDF_ClosePage(page: number): void
  FPDF_GetPageWidthF(page: number): number
  FPDF_GetPageHeightF(page: number): number
  FPDF_GetPageBoundingBox(page: number, rect: number): number | boolean
  FPDFPage_GetRotation(page: number): number
  FPDFText_LoadPage(page: number): number
  FPDFText_ClosePage(textPage: number): void
  FPDFText_CountChars(textPage: number): number
  FPDFText_GetUnicode(textPage: number, index: number): number
  FPDFText_IsGenerated(textPage: number, index: number): number
  FPDFText_GetTextObject(textPage: number, index: number): number
  FPDFText_HasUnicodeMapError(textPage: number, index: number): number
  FPDFText_GetCharBox(
    textPage: number,
    index: number,
    left: number,
    right: number,
    bottom: number,
    top: number
  ): number | boolean
  FPDFTextObj_GetTextRenderMode(textObj: number): number
  FPDFTextObj_GetFont(textObj: number): number
  FPDFFont_GetBaseFontName(font: number, buffer: number, length: number): number
  FPDFPage_CountObjects(page: number): number
  FPDFPage_GetObject(page: number, index: number): number
  FPDFFormObj_CountObjects(form: number): number
  FPDFFormObj_GetObject(form: number, index: number): number
  FPDFPageObj_GetType(obj: number): number
  FPDFPageObj_GetMatrix(obj: number, matrix: number): number | boolean
  FPDFPageObj_CountMarks(obj: number): number
  FPDFPageObj_GetMark(obj: number, index: number): number
  FPDFPageObjMark_GetName(
    mark: number,
    buffer: number,
    length: number,
    outLength: number
  ): number | boolean
  FPDFImageObj_GetImagePixelSize(obj: number, width: number, height: number): number | boolean
  FPDFImageObj_GetImageMetadata(obj: number, page: number, metadata: number): number | boolean
  FPDFImageObj_GetImageFilterCount(obj: number): number
  FPDFImageObj_GetImageFilter(obj: number, index: number, buffer: number, length: number): number
  FPDFImageObj_GetImageDataRaw(obj: number, buffer: number, length: number): number
  pdfium: {
    HEAPU8: Uint8Array
    wasmExports: { malloc(n: number): number; free(p: number): void }
  }
}

const FPDF_PAGEOBJ_TEXT = 1
const FPDF_PAGEOBJ_IMAGE = 3
const FPDF_PAGEOBJ_FORM = 5
/** FPDF_TEXTRENDERMODE_INVISIBLE and _CLIP: neither paints. */
const INVISIBLE_MODES = new Set([3, 7])

/** Our marked-content tags and font (PR2: ocr-layer.ts OCR_MARK, ocr-font.ts OCR_FONT_NAME). */
export const PDFX_OCR_MARK = 'PDFxOCR'
export const PDFX_OCR_FONT = 'PDFxOCR-GlyphLess'

/** Bounds on the work one page may cost (a crafted page can hold millions of objects). */
export const TRIAGE_LIMITS = {
  maxObjects: 200_000,
  maxFormDepth: 12,
  maxChars: 2_000_000,
  maxJpxImages: 64,
  /** Raw JPX data read for the SIZ check (the whole stream is needed only to locate its dict). */
  maxJpxBytes: 512 * 2 ** 20,
  maxNativeWords: TRIAGE_WORD_LIMITS.words,
  maxWordLength: TRIAGE_WORD_LIMITS.length
} as const

export interface TriageContext {
  /** The source bytes (to read a JPX image's /ColorSpace without decoding it). */
  file: Uint8Array
  caps: PixelCaps
  /** Test hook: every page's signals, as classified. */
  onSignals?: (index: number, signals: PageSignals) => void
}

interface ImageHit {
  obj: number
  full: Matrix6
  marks: string[]
}

/** Typed reads of the WASM heap; the view is refreshed when the heap grows. */
class Heap {
  private view: DataView | null = null
  constructor(private readonly rt: PdfiumTriage['pdfium']) {}
  private dv(): DataView {
    const buf = this.rt.HEAPU8.buffer
    if (!this.view || this.view.buffer !== buf) this.view = new DataView(buf)
    return this.view
  }
  f32 = (p: number): number => this.dv().getFloat32(p, true)
  f64 = (p: number): number => this.dv().getFloat64(p, true)
  i32 = (p: number): number => this.dv().getInt32(p, true)
  u32 = (p: number): number => this.dv().getUint32(p, true)
  bytes = (p: number, n: number): Uint8Array => this.rt.HEAPU8.slice(p, p + n)
  ascii(p: number, n: number): string {
    const b = this.rt.HEAPU8
    let s = ''
    for (let i = 0; i < n && b[p + i] !== 0; i++) s += String.fromCharCode(b[p + i])
    return s
  }
  utf16(p: number, nBytes: number): string {
    const b = this.rt.HEAPU8
    let s = ''
    for (let i = 0; i + 1 < nBytes; i += 2) {
      const c = b[p + i] | (b[p + i + 1] << 8)
      if (c === 0) break
      s += String.fromCharCode(c)
    }
    return s
  }
}

/** Triage every page in `pages` of the open document `doc`. Never renders. */
export function triagePages(
  mod: PdfiumTriage,
  doc: number,
  pages: readonly number[],
  ctx: TriageContext
): TriagePage[] {
  const encrypted = mod.FPDF_GetSecurityHandlerRevision(doc) !== -1
  const count = mod.FPDF_GetPageCount(doc)
  const rt = mod.pdfium
  const heap = new Heap(rt)
  const scratch = rt.wasmExports.malloc(256)
  if (!scratch) throw new Error('triage: no scratch memory')
  const find = makeByteFind(ctx.file)
  try {
    return pages.map((index) => {
      const base: TriagePage = {
        index,
        pageClass: null,
        renderDpi: null,
        raster: null,
        effectiveDpi: null,
        bitsPerPixel: null,
        imageOrigin: false
      }
      if (index < 0 || index >= count) return { ...base, failure: 'page-missing' }
      // An encrypted source is skipped whole (§3.4.1): nothing of its pages is read.
      if (encrypted) return { ...base, pageClass: 'protected' }
      const page = mod.FPDF_LoadPage(doc, index)
      if (!page) return { ...base, failure: 'render' }
      try {
        return triageOne(mod, heap, scratch, page, index, ctx, find)
      } finally {
        mod.FPDF_ClosePage(page)
      }
    })
  } finally {
    rt.wasmExports.free(scratch)
  }
}

function readMatrix(mod: PdfiumTriage, heap: Heap, obj: number, p: number): Matrix6 | null {
  if (!mod.FPDFPageObj_GetMatrix(obj, p)) return null
  return [
    heap.f32(p),
    heap.f32(p + 4),
    heap.f32(p + 8),
    heap.f32(p + 12),
    heap.f32(p + 16),
    heap.f32(p + 20)
  ]
}

function markNames(mod: PdfiumTriage, heap: Heap, obj: number, p: number): string[] {
  const n = mod.FPDFPageObj_CountMarks(obj)
  const out: string[] = []
  for (let k = 0; k < n && k < 16; k++) {
    const mark = mod.FPDFPageObj_GetMark(obj, k)
    if (!mark) continue
    // UTF-16LE into the scratch buffer (128 bytes: names are short); out length at p + 128.
    if (!mod.FPDFPageObjMark_GetName(mark, p, 128, p + 128)) continue
    out.push(heap.utf16(p, Math.min(128, heap.u32(p + 128))))
  }
  return out
}

/** Every image on the page with its full CTM and marks, recursing into Forms; and our OCR mark. */
function collectObjects(
  mod: PdfiumTriage,
  heap: Heap,
  page: number,
  scratch: number
): { images: ImageHit[]; pdfxOcrMark: boolean } {
  const images: ImageHit[] = []
  let pdfxOcrMark = false
  let visited = 0
  const walk = (container: number, isForm: boolean, ctm: Matrix6, depth: number): void => {
    const n = isForm
      ? mod.FPDFFormObj_CountObjects(container)
      : mod.FPDFPage_CountObjects(container)
    for (let i = 0; i < n && visited < TRIAGE_LIMITS.maxObjects; i++) {
      visited++
      const o = isForm
        ? mod.FPDFFormObj_GetObject(container, i)
        : mod.FPDFPage_GetObject(container, i)
      if (!o) continue
      const type = mod.FPDFPageObj_GetType(o)
      if (type === FPDF_PAGEOBJ_TEXT) {
        if (!pdfxOcrMark && markNames(mod, heap, o, scratch).includes(PDFX_OCR_MARK))
          pdfxOcrMark = true
        continue
      }
      if (type !== FPDF_PAGEOBJ_IMAGE && type !== FPDF_PAGEOBJ_FORM) continue
      const m = readMatrix(mod, heap, o, scratch)
      if (!m) continue
      // PR0: a child's GetMatrix already holds its Form's /Matrix; a form object's is the CTM at
      // its `Do`. So the full CTM is the child's matrix times every ancestor form object's.
      const full = mulMatrix(m, ctm)
      if (type === FPDF_PAGEOBJ_IMAGE)
        images.push({ obj: o, full, marks: markNames(mod, heap, o, scratch) })
      else if (depth < TRIAGE_LIMITS.maxFormDepth) walk(o, true, full, depth + 1)
    }
  }
  walk(page, false, IDENTITY, 0)
  return { images, pdfxOcrMark }
}

/**
 * The render-time guard (defence in depth behind triage's `refused`): the first JPX pre-check
 * refusal of any image on the loaded `page`, or null. The raster thread runs it before every
 * render, so a page PDFium would decode wrongly or trap on is never rendered, whatever the
 * renderer asked for.
 */
export function jpxRefusalOf(mod: PdfiumTriage, page: number, file: Uint8Array): JpxRefusal | null {
  const rt = mod.pdfium
  const heap = new Heap(rt)
  const scratch = rt.wasmExports.malloc(256)
  if (!scratch) return 'jpx-malformed'
  try {
    const { images } = collectObjects(mod, heap, page, scratch)
    let find: ReturnType<typeof makeByteFind> | null = null
    let seen = 0
    for (const im of images) {
      if (!isJpx(mod, heap, im.obj, scratch)) continue
      if (++seen > TRIAGE_LIMITS.maxJpxImages) return 'jpx-malformed'
      find ??= makeByteFind(file)
      const check = checkJpx(mod, heap, im.obj, file, find)
      if (!check.ok) return check.reason
    }
    return null
  } finally {
    rt.wasmExports.free(scratch)
  }
}

function triageOne(
  mod: PdfiumTriage,
  heap: Heap,
  scratch: number,
  page: number,
  index: number,
  ctx: TriageContext,
  find: ReturnType<typeof makeByteFind>
): TriagePage {
  // View box (CropBox ∩ MediaBox), user space; FS_RECTF is {left, top, right, bottom}.
  let box: OcrRect
  if (mod.FPDF_GetPageBoundingBox(page, scratch)) {
    const l = heap.f32(scratch)
    const t = heap.f32(scratch + 4)
    const r = heap.f32(scratch + 8)
    const b = heap.f32(scratch + 12)
    box = { x0: Math.min(l, r), y0: Math.min(b, t), x1: Math.max(l, r), y1: Math.max(b, t) }
  } else box = { x0: 0, y0: 0, x1: mod.FPDF_GetPageWidthF(page), y1: mod.FPDF_GetPageHeightF(page) }
  const frame: PageFrame = { box, quarterTurns: Math.max(0, mod.FPDFPage_GetRotation(page)) }
  const pageArea = (box.x1 - box.x0) * (box.y1 - box.y0)

  // --- Objects: images (recursing into forms) and marks.
  const { images, pdfxOcrMark } = collectObjects(mod, heap, page, scratch)

  const cov =
    pageArea > 0
      ? unionArea(
          images.map((im) => unitSquareBounds(im.full)),
          box
        ) / pageArea
      : 0
  const imageOrigin = images.some((im) => im.marks.includes(IMPORTED_IMAGE_MARK))

  // --- Text.
  const quality = emptyQuality()
  let visible = 0
  let invisible = 0
  let pdfxOcrFont = false
  const visibleBoxes: OcrRect[] = []
  const words: NativeWord[] = []
  let word: { t: string; r: OcrRect } | null = null
  const endWord = (): void => {
    if (word && words.length < TRIAGE_LIMITS.maxNativeWords) {
      const o = toOverlayFrame(word.r, frame)
      // A char box far off any page (a crafted file) never reaches the port's validator.
      const sane = [o.x0, o.y0, o.x1, o.y1].every(
        (v) => Number.isFinite(v) && Math.abs(v) <= OCR_LIMITS.maxPageSidePt
      )
      if (sane) words.push({ t: word.t, ...o })
    }
    word = null
  }
  const tp = mod.FPDFText_LoadPage(page)
  if (tp) {
    try {
      // Per text object (handles are stable within the page): its font verdict and render mode.
      const fontOf = new Map<number, { invisibleFont: boolean; ours: boolean; mode: number }>()
      const n = Math.min(mod.FPDFText_CountChars(tp), TRIAGE_LIMITS.maxChars)
      // Char box doubles at scratch + 160 .. + 192 (clear of the name/matrix area).
      const cb = scratch + 160
      for (let i = 0; i < n; i++) {
        // Generated chars (spaces/line breaks PDFium inserts) have no text object (PR0): skip
        // them before asking for a render mode. They do end a word.
        if (mod.FPDFText_IsGenerated(tp, i) === 1) {
          endWord()
          continue
        }
        const cp = mod.FPDFText_GetUnicode(tp, i) >>> 0
        if (isSpaceChar(cp)) {
          endWord()
          continue
        }
        const to = mod.FPDFText_GetTextObject(tp, i)
        let font = fontOf.get(to)
        if (!font) {
          font = {
            invisibleFont: false,
            ours: false,
            mode: to ? mod.FPDFTextObj_GetTextRenderMode(to) : 0
          }
          const f = to ? mod.FPDFTextObj_GetFont(to) : 0
          if (f) {
            const need = mod.FPDFFont_GetBaseFontName(f, scratch, 128)
            const name = need > 0 ? heap.ascii(scratch, Math.min(need, 128)) : ''
            font.ours = baseFontCore(name) === PDFX_OCR_FONT
            font.invisibleFont = font.ours || isForeignGlyphlessFont(name)
          }
          fontOf.set(to, font)
        }
        if (font.ours) pdfxOcrFont = true
        tallyChar(quality, cp, mod.FPDFText_HasUnicodeMapError(tp, i) === 1)
        if (font.invisibleFont || INVISIBLE_MODES.has(font.mode)) {
          invisible++
          endWord()
          continue
        }
        visible++
        if (!mod.FPDFText_GetCharBox(tp, i, cb, cb + 8, cb + 16, cb + 24)) {
          endWord()
          continue
        }
        const l = heap.f64(cb)
        const r = heap.f64(cb + 8)
        const b = heap.f64(cb + 16)
        const t = heap.f64(cb + 24)
        const rect: OcrRect = {
          x0: Math.min(l, r),
          y0: Math.min(b, t),
          x1: Math.max(l, r),
          y1: Math.max(b, t)
        }
        visibleBoxes.push(rect)
        const ch = cp <= 0x10ffff ? String.fromCodePoint(cp) : '\ufffd'
        if (!word) word = { t: ch, r: { ...rect } }
        else if (word.t.length + ch.length > TRIAGE_LIMITS.maxWordLength) {
          endWord()
          word = { t: ch, r: { ...rect } }
        } else {
          word.t += ch
          word.r = {
            x0: Math.min(word.r.x0, rect.x0),
            y0: Math.min(word.r.y0, rect.y0),
            x1: Math.max(word.r.x1, rect.x1),
            y1: Math.max(word.r.y1, rect.y1)
          }
        }
      }
      endWord()
    } finally {
      mod.FPDFText_ClosePage(tp)
    }
  }

  const signals: PageSignals = {
    encrypted: false,
    visible,
    invisible,
    cov,
    textArea: pageArea > 0 ? unionArea(visibleBoxes, box) / pageArea : 0,
    band: bandFraction(visibleBoxes, frame),
    pdfxOcrMark,
    pdfxOcrFont,
    quality
  }
  const pageClass = classifyPage(signals)
  ctx.onSignals?.(index, signals)

  // --- Dominant image, d_eff, the JPX pre-check.
  let dominant: ImageHit | null = null
  for (const im of images)
    if (!dominant || placedArea(im.full) > placedArea(dominant.full)) dominant = im
  let dEff: number | null = null
  let bitsPerPixel: number | null = null
  let refused: JpxRefusal | undefined
  let jpxSeen = 0
  for (const im of images) {
    const jpx = isJpx(mod, heap, im.obj, scratch)
    if (jpx) {
      if (++jpxSeen > TRIAGE_LIMITS.maxJpxImages) {
        refused ??= 'jpx-malformed'
        break
      }
      const check = checkJpx(mod, heap, im.obj, ctx.file, find)
      if (!check.ok) refused ??= check.reason
      else if (im === dominant) bitsPerPixel = check.info.bitsPerComponent * check.info.components
    }
    if (im !== dominant) continue
    if (mod.FPDFImageObj_GetImagePixelSize(im.obj, scratch, scratch + 4)) {
      dEff = effectiveDpi({ width: heap.u32(scratch), height: heap.u32(scratch + 4) }, im.full)
    }
    // Metadata with the page decodes JPX (see the header): only for other filters.
    if (!jpx && mod.FPDFImageObj_GetImageMetadata(im.obj, page, scratch)) {
      const bpp = heap.u32(scratch + 16)
      bitsPerPixel = bpp > 0 ? bpp : null
    }
  }

  const dpi = selectRenderDpi({
    page: { width: mod.FPDF_GetPageWidthF(page), height: mod.FPDF_GetPageHeightF(page) },
    dEff,
    imageOrigin,
    caps: ctx.caps
  })
  const out: TriagePage = {
    index,
    pageClass,
    renderDpi: dpi.renderDpi,
    raster: { width: dpi.width, height: dpi.height },
    // Clamped into what the port accepts: a crafted placement can make d_eff absurd.
    effectiveDpi: dEff === null ? null : Math.min(1e6, Math.round(dEff * 100) / 100),
    bitsPerPixel: bitsPerPixel !== null && bitsPerPixel <= 1024 ? bitsPerPixel : null,
    imageOrigin
  }
  if (refused) out.refused = refused
  if (wantsNativeWords(pageClass)) out.nativeWords = words
  return out
}

function isJpx(mod: PdfiumTriage, heap: Heap, obj: number, p: number): boolean {
  const n = mod.FPDFImageObj_GetImageFilterCount(obj)
  for (let i = 0; i < n && i < 8; i++) {
    const len = mod.FPDFImageObj_GetImageFilter(obj, i, p, 64)
    if (len > 0 && heap.ascii(p, Math.min(len, 64)) === 'JPXDecode') return true
  }
  return false
}

function checkJpx(
  mod: PdfiumTriage,
  heap: Heap,
  obj: number,
  file: Uint8Array,
  find: ReturnType<typeof makeByteFind>
): ReturnType<typeof jpxPrecheck> {
  const rt = mod.pdfium
  const len = mod.FPDFImageObj_GetImageDataRaw(obj, 0, 0)
  if (!(len > 0) || len > TRIAGE_LIMITS.maxJpxBytes) return { ok: false, reason: 'jpx-malformed' }
  const buf = rt.wasmExports.malloc(len)
  if (!buf) return { ok: false, reason: 'jpx-malformed' }
  let raw: Uint8Array
  try {
    const got = mod.FPDFImageObj_GetImageDataRaw(obj, buf, len)
    raw = heap.bytes(buf, Math.min(got, len))
  } finally {
    rt.wasmExports.free(buf)
  }
  // A /ColorSpace we cannot find or read counts as absent: the JP2 header may still name one.
  const cs = streamColourComponents(file, raw, find)
  return jpxPrecheck(raw, cs === 'unknown' ? null : cs)
}
