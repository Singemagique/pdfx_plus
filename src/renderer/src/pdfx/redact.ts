// True redaction via PDFium (PRD §4.5). For each page and each redaction rectangle we:
//   1. REMOVE every page CONTENT object (text/path/image) whose bounds overlap the box, and
//   2. REMOVE every ANNOTATION / AcroForm widget whose rect overlaps the box — their text lives in
//      appearance streams and field values, NOT the content stream, so the object pass can't reach
//      it and (since annotations paint on top) a black box alone would neither cover nor remove it,
// then paint an opaque black box over the area and rewrite the document in full (FPDF_NO_INCREMENTAL)
// so no earlier revision retains the removed content. Removal is verified by re-extracting text and
// re-counting annotations.
//
// Rects are in the page's UNROTATED PDF user space (origin bottom-left) — the caller converts from
// the editor's visual space. Removal is whole-object, so redacting over a large object (e.g. a
// full-page scan image) removes that whole object: safe (no leak) but coarse on image-only pages.
//
// Caveat: removing an AcroForm widget annotation drops the widget and its appearance; a residual
// value may remain in the document-level /AcroForm /Fields tree. For fully untrusted forms, flatten
// the form before redacting. Sub-image (rasterize-region) redaction is a future refinement.
//
// OCR (DESIGN.md §3.7.3). Two additions serve the invisible OCR text layer:
// - The REMOVED-OBJECT REPORT (rule 2). `redactPdfReport` returns, per page, the bounds of every
//   object the pass removed because it overlapped a box, of any type (text, path, image, shading,
//   Form XObject) plus every removed annotation's rect. An OCR word lying over any of them
//   describes pixels the export no longer has, so the export drops it (ocr-export.ts). A scan
//   wrapped in a Form XObject is ONE top-level page object here, so its whole bounds are reported.
//   An extent PDFium cannot give is reported as `null`, and the export then drops the page's whole
//   layer (fail-safe).
// - The INVISIBLE-TEXT PAD (rule 4, defence in depth). A text object in render mode 3 (invisible)
//   or shown in a known glyphless OCR font (Tesseract's GlyphLessFont, Occulta, ours) has its
//   bounds grown by its em (font size × the text matrix's vertical axis), on both sides of the
//   baseline and along that axis, before the overlap test. Another producer's glyphless layer may
//   report degenerate (baseline-thin) bounds, and a box over the x-height band would then miss the
//   word. The pad can over-remove invisible text, never leak it.

/** FPDF_SaveAsCopy flag: complete rewrite rather than incremental append (no retained revision). */
const FPDF_NO_INCREMENTAL = 2
/** FPDFPath_SetDrawMode fill mode: nonzero winding. Without a draw mode PDFium won't paint the box. */
const FPDF_FILLMODE_WINDING = 1

/** Minimal structural view of the @embedpdf/pdfium module — just the calls redaction needs. */
export interface PdfiumModule {
  FPDF_LoadMemDocument(dataPtr: number, size: number, password: string): number
  FPDF_LoadPage(doc: number, index: number): number
  FPDF_ClosePage(page: number): void
  FPDF_CloseDocument(doc: number): void
  FPDF_SaveAsCopy(doc: number, fileWrite: number, flags: number): boolean
  FPDFPage_CountObjects(page: number): number
  FPDFPage_GetObject(page: number, index: number): number
  FPDFPage_RemoveObject(page: number, obj: number): boolean
  FPDFPage_InsertObject(page: number, obj: number): void
  FPDFPage_GenerateContent(page: number): boolean
  FPDFPage_GetAnnotCount(page: number): number
  FPDFPage_GetAnnot(page: number, index: number): number
  FPDFPage_CloseAnnot(annot: number): void
  FPDFPage_RemoveAnnot(page: number, index: number): boolean
  FPDFAnnot_GetRect(annot: number, rectPtr: number): boolean
  FPDFPageObj_GetBounds(obj: number, l: number, b: number, r: number, t: number): boolean
  FPDFPageObj_Destroy(obj: number): void
  FPDFPageObj_CreateNewRect(x: number, y: number, w: number, h: number): number
  FPDFPageObj_SetFillColor(obj: number, r: number, g: number, b: number, a: number): boolean
  FPDFPath_SetDrawMode(obj: number, fillMode: number, stroke: boolean): boolean
  FPDFPageObj_GetType(obj: number): number
  /** FS_MATRIX { a, b, c, d, e, f } floats. For text: Tz and the CTM included, the size not. */
  FPDFPageObj_GetMatrix(obj: number, matrixPtr: number): boolean
  FPDFTextObj_GetFont(obj: number): number
  /** The Tf operand (unscaled by any matrix) [measured, PDFium in @embedpdf/pdfium 2.14.4]. */
  FPDFTextObj_GetFontSize(obj: number, sizePtr: number): boolean
  FPDFTextObj_GetTextRenderMode(obj: number): number
  FPDFFont_GetBaseFontName(font: number, buffer: number, length: number): number
  pdfium: {
    HEAPU8: Uint8Array
    wasmExports: { malloc(size: number): number; free(ptr: number): void }
    getValue(ptr: number, type: string): number
    setValue(ptr: number, value: number, type: string): void
    addFunction(fn: (...args: number[]) => number, signature: string): number
    removeFunction(ptr: number): void
  }
}

/** A redaction rectangle in unrotated PDF user space (points, origin bottom-left). */
export interface RedactRect {
  x: number
  y: number
  w: number
  h: number
}

export interface PageRedaction {
  pageIndex: number
  rects: RedactRect[]
}

export interface RedactOptions {
  /**
   * Also remove EVERY text object in a PDFx OCR font (BaseFont /PDFxOCR-GlyphLess) on each redacted
   * page, wherever it lies: the whole-page OCR fail-safe of a reopened OCR'd file (DESIGN.md §3.7.3
   * rule 2 fail-safe, rule 5). Removing only the overlapping words would leave their characters in
   * the layer font's ToUnicode, which no PDFium pass can trim; with no text object left in it,
   * GenerateContent drops the font from the page's resources. Off by default, so the glyph-bounds
   * suite still measures what per-word removal does.
   */
  dropOcrText?: boolean
}

/** BaseFont of the PDFx OCR layer font (ocr-font.ts `OCR_FONT_NAME`, kept free of pdf-lib here). */
const OCR_FONT_BASE_NAME = 'PDFxOCR-GlyphLess'
/**
 * Glyphless fonts of OCR text layers: Tesseract's (`GlyphLessFont`, also OCRmyPDF's), `Occulta`
 * (OCRmyPDF's later glyphless font) and ours. Matched exactly or after a subset tag `ABCDEF+`.
 */
export const GLYPHLESS_FONT_NAMES: readonly string[] = [
  'GlyphLessFont',
  'Occulta',
  OCR_FONT_BASE_NAME
]
const FPDF_PAGEOBJ_TEXT = 1
/** FPDFTextObj_GetTextRenderMode: neither fill nor stroke nor clip (PDF `3 Tr`). */
const FPDF_TEXTRENDERMODE_INVISIBLE = 3

/** True if a box (l,b,r,t) positively overlaps the rectangle. */
function overlaps(l: number, b: number, r: number, t: number, rc: RedactRect): boolean {
  return !(r <= rc.x || l >= rc.x + rc.w || t <= rc.y || b >= rc.y + rc.h)
}

/** A box in unrotated PDF user space: left, bottom, right, top (points). */
export interface PdfBox {
  l: number
  b: number
  r: number
  t: number
}

/** What the redaction pass removed from a page (DESIGN.md §3.7.3 rule 2). */
export interface RemovedObject {
  /** FPDF_PAGEOBJ_* (1 text, 2 path, 3 image, 4 shading, 5 Form XObject), or 'annot'. */
  type: number | 'annot'
  /**
   * The bounds the overlap test used (padded for invisible text), in unrotated user space; null
   * when the extent is unknown (the caller must then treat the whole page as removed).
   */
  box: PdfBox | null
}

/** The BaseFont name of a text object's font ('' when there is none or it cannot be read). */
function baseFontName(pdfium: PdfiumModule, obj: number): string {
  const font = pdfium.FPDFTextObj_GetFont(obj)
  if (!font) return ''
  const rt = pdfium.pdfium
  const n = pdfium.FPDFFont_GetBaseFontName(font, 0, 0)
  if (n <= 1 || n > 256) return ''
  const buf = rt.wasmExports.malloc(n)
  try {
    pdfium.FPDFFont_GetBaseFontName(font, buf, n)
    let name = ''
    for (let i = 0; i < n - 1; i++) name += String.fromCharCode(rt.HEAPU8[buf + i])
    return name
  } finally {
    rt.wasmExports.free(buf)
  }
}

/** `name`, or `name` after a subset tag, is one of `names`. */
const namedAs = (name: string, names: readonly string[]): boolean =>
  names.some((n) => name === n || name.endsWith(`+${n}`))

/** Is `obj` a text object shown in a PDFx OCR font (a subset tag `ABCDEF+` tolerated)? */
function isOcrText(pdfium: PdfiumModule, obj: number): boolean {
  if (pdfium.FPDFPageObj_GetType(obj) !== FPDF_PAGEOBJ_TEXT) return false
  return namedAs(baseFontName(pdfium, obj), [OCR_FONT_BASE_NAME])
}

/**
 * The bounds of a text object grown for the overlap test when the text is invisible (render
 * mode 3) or in a glyphless OCR font: by ± its em along the text's vertical axis. `fb` is scratch
 * memory of at least 32 bytes. Other objects (and text that is neither) keep `box`.
 */
function invisibleTextPad(pdfium: PdfiumModule, obj: number, box: PdfBox, fb: number): PdfBox {
  if (pdfium.FPDFPageObj_GetType(obj) !== FPDF_PAGEOBJ_TEXT) return box
  const invisible =
    pdfium.FPDFTextObj_GetTextRenderMode(obj) === FPDF_TEXTRENDERMODE_INVISIBLE ||
    namedAs(baseFontName(pdfium, obj), GLYPHLESS_FONT_NAMES)
  if (!invisible) return box
  const rt = pdfium.pdfium
  // Size × the text matrix's y axis (c, d): the em vector in user space [measured: the matrix
  // carries Tz and the CTM, the size is the bare Tf operand]. A matrix or size PDFium cannot give
  // makes the extent unknown, which the caller turns into a whole-page removal.
  if (!pdfium.FPDFTextObj_GetFontSize(obj, fb)) return { l: NaN, b: NaN, r: NaN, t: NaN }
  const size = Math.abs(rt.getValue(fb, 'float'))
  if (!pdfium.FPDFPageObj_GetMatrix(obj, fb + 8)) return { l: NaN, b: NaN, r: NaN, t: NaN }
  const c = rt.getValue(fb + 16, 'float')
  const d = rt.getValue(fb + 20, 'float')
  const px = Math.abs(size * c)
  const py = Math.abs(size * d)
  return { l: box.l - px, b: box.b - py, r: box.r + px, t: box.t + py }
}

const finiteBox = (b: PdfBox): boolean =>
  Number.isFinite(b.l) && Number.isFinite(b.b) && Number.isFinite(b.r) && Number.isFinite(b.t)

/**
 * Redact one loaded page; returns what it removed (see `RemovedObject`). Content objects in the
 * `dropOcrText` sweep that do not themselves overlap a box are removed but NOT reported: they are
 * invisible text, so no pixel goes with them and no OCR word over them needs to go either.
 */
function redactPage(
  pdfium: PdfiumModule,
  page: number,
  rects: RedactRect[],
  opts: RedactOptions
): RemovedObject[] {
  const rt = pdfium.pdfium
  const { malloc, free } = rt.wasmExports
  const removed: RemovedObject[] = []
  const fb = malloc(48) // object bounds / annotation rects at 0..15, the pad's scratch at 16..47
  try {
    // 1) Remove page CONTENT objects overlapping any rect (collect handles, then remove by handle).
    const doomed: number[] = []
    const count = pdfium.FPDFPage_CountObjects(page)
    for (let i = 0; i < count; i++) {
      const obj = pdfium.FPDFPage_GetObject(page, i)
      if (!obj) continue
      const sweep = !!opts.dropOcrText && isOcrText(pdfium, obj)
      if (!pdfium.FPDFPageObj_GetBounds(obj, fb, fb + 4, fb + 8, fb + 12)) {
        // No bounds: nothing to test, so it stays (as before) unless the OCR sweep takes it.
        if (sweep) doomed.push(obj)
        continue
      }
      const raw: PdfBox = {
        l: rt.getValue(fb, 'float'),
        b: rt.getValue(fb + 4, 'float'),
        r: rt.getValue(fb + 8, 'float'),
        t: rt.getValue(fb + 12, 'float')
      }
      const box = invisibleTextPad(pdfium, obj, raw, fb + 16)
      const known = finiteBox(box)
      // Unknown extent (non-finite bounds, or an invisible text object whose pad PDFium cannot
      // give): removed, and reported as unknown. `overlaps` already said yes to NaN bounds before
      // the report existed, and for invisible text the removal changes no pixel.
      const hit = !known || rects.some((rc) => overlaps(box.l, box.b, box.r, box.t, rc))
      if (hit) {
        doomed.push(obj)
        removed.push({ type: pdfium.FPDFPageObj_GetType(obj), box: known ? box : null })
      } else if (sweep) doomed.push(obj)
    }
    for (const obj of doomed) {
      if (!pdfium.FPDFPage_RemoveObject(page, obj)) {
        throw new Error('redact: FPDFPage_RemoveObject failed')
      }
      pdfium.FPDFPageObj_Destroy(obj)
    }

    // 2) Remove ANNOTATIONS / widgets overlapping any rect (descending so indices stay valid).
    //    FS_RECTF layout: { left@0, top@4, right@8, bottom@12 }.
    for (let i = pdfium.FPDFPage_GetAnnotCount(page) - 1; i >= 0; i--) {
      const annot = pdfium.FPDFPage_GetAnnot(page, i)
      if (!annot) continue
      const ok = pdfium.FPDFAnnot_GetRect(annot, fb)
      const l = rt.getValue(fb, 'float')
      const t = rt.getValue(fb + 4, 'float')
      const r = rt.getValue(fb + 8, 'float')
      const b = rt.getValue(fb + 12, 'float')
      pdfium.FPDFPage_CloseAnnot(annot)
      if (ok && rects.some((rc) => overlaps(l, b, r, t, rc))) {
        if (!pdfium.FPDFPage_RemoveAnnot(page, i)) {
          throw new Error('redact: FPDFPage_RemoveAnnot failed')
        }
        // A rect may be stored with its corners swapped: report it normalised.
        const box = { l: Math.min(l, r), b: Math.min(b, t), r: Math.max(l, r), t: Math.max(b, t) }
        removed.push({ type: 'annot', box: finiteBox(box) ? box : null })
      }
    }
  } finally {
    free(fb)
  }

  // 3) Paint an opaque black box over each redacted area (fill draw mode is required to render).
  for (const rc of rects) {
    const box = pdfium.FPDFPageObj_CreateNewRect(rc.x, rc.y, rc.w, rc.h)
    pdfium.FPDFPageObj_SetFillColor(box, 0, 0, 0, 255)
    pdfium.FPDFPath_SetDrawMode(box, FPDF_FILLMODE_WINDING, false)
    pdfium.FPDFPage_InsertObject(page, box)
  }

  // 4) Persist the content changes; abort loudly so a failed redaction never yields output.
  if (!pdfium.FPDFPage_GenerateContent(page)) {
    throw new Error('redact: FPDFPage_GenerateContent failed')
  }
  return removed
}

/** Serialize the modified document to bytes via FPDF_SaveAsCopy + an FPDF_FILEWRITE callback. */
function saveDocument(pdfium: PdfiumModule, doc: number): Uint8Array {
  const rt = pdfium.pdfium
  const { malloc, free } = rt.wasmExports
  const chunks: Uint8Array[] = []
  // new Uint8Array(view) COPIES, so the chunk is safe from later heap growth.
  const writeBlock = rt.addFunction((_pThis: number, pData: number, size: number): number => {
    chunks.push(new Uint8Array(rt.HEAPU8.subarray(pData, pData + size)))
    return 1
  }, 'iiii')
  const fileWrite = malloc(8) // { int version; WriteBlock* }
  try {
    rt.setValue(fileWrite, 1, 'i32')
    rt.setValue(fileWrite + 4, writeBlock, 'i32')
    if (!pdfium.FPDF_SaveAsCopy(doc, fileWrite, FPDF_NO_INCREMENTAL)) {
      throw new Error('redact: FPDF_SaveAsCopy failed')
    }
  } finally {
    free(fileWrite)
    rt.removeFunction(writeBlock)
  }
  const total = chunks.reduce((s, c) => s + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/**
 * Redact `pages` of `bytes` using an initialized PDFium module, returning the rewritten PDF bytes.
 * Pages with no rects are left untouched. The input bytes are not mutated. Throws (fails closed) if
 * any PDFium step fails, so a partially-redacted document is never returned.
 */
export function redactPdf(
  pdfium: PdfiumModule,
  bytes: Uint8Array,
  pages: PageRedaction[],
  opts: RedactOptions = {}
): Uint8Array {
  return redactPdfReport(pdfium, bytes, pages, opts).bytes
}

/** `redactPdf`'s output plus what it removed: pageIndex → `RemovedObject`s (§3.7.3 rule 2). */
export interface RedactResult {
  bytes: Uint8Array
  /** One entry for every page that had rects (empty when nothing overlapped). */
  removed: Map<number, RemovedObject[]>
}

/** `redactPdf`, also returning the removed-object report of every redacted page. */
export function redactPdfReport(
  pdfium: PdfiumModule,
  bytes: Uint8Array,
  pages: PageRedaction[],
  opts: RedactOptions = {}
): RedactResult {
  const removed = new Map<number, RemovedObject[]>()
  const rt = pdfium.pdfium
  const { malloc, free } = rt.wasmExports
  const filePtr = malloc(bytes.length)
  rt.HEAPU8.set(bytes, filePtr)
  // PDFium references the input buffer for the document's lifetime, so filePtr is freed only after
  // FPDF_CloseDocument below.
  const doc = pdfium.FPDF_LoadMemDocument(filePtr, bytes.length, '')
  if (!doc) {
    free(filePtr)
    throw new Error('redact: failed to load PDF')
  }
  try {
    for (const { pageIndex, rects } of pages) {
      if (rects.length === 0) continue
      // Fail closed: a page that needs redaction but won't load must abort the whole export rather
      // than silently yield an un-redacted document.
      const page = pdfium.FPDF_LoadPage(doc, pageIndex)
      if (!page) throw new Error(`redact: FPDF_LoadPage failed for page ${pageIndex}`)
      try {
        const objs = redactPage(pdfium, page, rects, opts)
        removed.set(pageIndex, [...(removed.get(pageIndex) ?? []), ...objs])
      } finally {
        pdfium.FPDF_ClosePage(page)
      }
    }
    return { bytes: saveDocument(pdfium, doc), removed }
  } finally {
    pdfium.FPDF_CloseDocument(doc)
    free(filePtr)
  }
}
