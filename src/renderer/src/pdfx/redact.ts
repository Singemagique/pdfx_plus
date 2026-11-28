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
// full-page scan image) removes that whole object: safe (no leak) but coarse on image-only pages,
// unless the image can be redacted pixel by pixel (next paragraph). A scan inside a Form XObject is
// one form object here, so it is still removed whole.
//
// PIXEL REDACTION (DESIGN.md §2 D3, PR12; `RedactOptions.pixels`). With the pdf-lib pre-pass's
// image candidates (pixel-redact-doc.ts), an image the box overlaps that is in scope (pixel-redact.ts:
// unmasked DeviceGray, DeviceRGB or Indexed, no /Decode or ICC, an XObject, axis-aligned, no clip,
// no transparency, no marked content, PDFium reads it with the same colour space and depth and its
// own decode of it is exactly the plan's reading of the samples, and its 8-bit raster is at most
// MAX_RASTER_BYTES) is not removed: the samples the box touches are blanked on a
// NEW image object put in its place in the page's object list (`pixelRedact`), so the shared
// XObject, and every other page drawing it, keeps its pixels (FPDFImageObj_SetBitmap on the
// original would rewrite the shared stream). PDFium can only write that object at 8 bits per
// component, so it is an INTERIM, already blanked; the export's pdf-lib pass swaps the final
// stream in (the source's own depth, 1-bit for fax scans, at most twice the source's size). The
// modified image is NOT in the removed-object report: it still shows its pixels, so only the words
// under the box go (§3.7.3 rule 1). Everything else, and any step that fails, falls back to removing
// the whole image, so a mapping or decoding problem can never leave covered pixels behind.
//
// Caveat: removing an AcroForm widget annotation drops the widget and its appearance; a residual
// value may remain in the document-level /AcroForm /Fields tree. For fully untrusted forms, flatten
// the form before redacting.
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
//   bounds grown to its EM BOX before the overlap test: the baseline extent of its bounds, from
//   `PAD_DESCENT` em below the baseline to 1 em above it, along the text matrix's vertical axis
//   (font size × (c, d)) and anchored at the text origin. Another producer's glyphless layer may
//   report degenerate (baseline-thin) bounds, and a box over the x-height or the descender band
//   would then miss the word. Anchoring at the baseline keeps the pad off the lines above and
//   below (at 1.2 em line pitch the em boxes of adjacent lines only touch). The pad can over-remove
//   invisible text, never leak it.
//
// Removing an annotation also removes the annotations tied to it (`linkedAnnots`): its /Popup, and
// every annotation whose /Parent or /IRT names a removed one (a popup's /Parent, a reply). They
// would otherwise stay on the page holding a reference to the removed dict, and copyPages carries
// that dict, with its /Contents, into the export (pdf.js even shows it as the popup's text).

import {
  MAX_GROWTH,
  MAX_RASTER_BYTES,
  blankSamples,
  blankValue,
  channelsOf,
  componentsOf,
  encodeWithin,
  expandSamples,
  isAxisAligned,
  matchCandidate,
  pixelRect,
  rowBytesOf,
  type ImageCandidate,
  type ImagePlan,
  type Matrix,
  type PageCandidates,
  type PixelRect,
  type PixelReplacement
} from './pixel-redact'

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
  /** The page's index of `annot`'s dictionary, -1 when the page does not list it. */
  FPDFPage_GetAnnotIndex(page: number, annot: number): number
  FPDFAnnot_GetRect(annot: number, rectPtr: number): boolean
  /** The annotation `key` (Popup, Parent, IRT) of `annot` names, or 0 (close it after use). */
  FPDFAnnot_GetLinkedAnnot(annot: number, key: string): number
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
  /** Number of content marks (BDC/BMC tags, enclosing ones included) on a page object. */
  FPDFPageObj_CountMarks(obj: number): number
  FPDFPageObj_GetMark(obj: number, index: number): number
  /** The mark's tag as UTF-16LE into `buffer`; `outLen` receives the byte length incl. the NUL. */
  FPDFPageObjMark_GetName(mark: number, buffer: number, length: number, outLen: number): boolean
  /** The page objects of a Form XObject (`FPDFPageObj_GetType` 5). */
  FPDFFormObj_CountObjects(form: number): number
  FPDFFormObj_GetObject(form: number, index: number): number
  /** Ownership passes to the caller (FPDFPageObj_Destroy); GenerateContent rewrites the form. */
  FPDFFormObj_RemoveObject(form: number, obj: number): boolean
  // Pixel redaction (pixelRedact).
  FPDFPageObj_HasTransparency(obj: number): boolean
  FPDFPageObj_GetClipPath(obj: number): number
  /** -1 when the object has no clip path. */
  FPDFClipPath_CountPaths(clip: number): number
  FPDFPageObj_SetMatrix(obj: number, matrixPtr: number): boolean
  FPDFPageObj_NewImageObj(doc: number): number
  FPDFPage_InsertObjectAtIndex(page: number, obj: number, index: number): boolean
  FPDFImageObj_GetImagePixelSize(obj: number, wPtr: number, hPtr: number): boolean
  /** FPDF_IMAGEOBJ_METADATA (28 bytes): u32 width, height; f32 dpi x, y; u32 bpp; i32 cs, mcid. */
  FPDFImageObj_GetImageMetadata(obj: number, page: number, metadataPtr: number): boolean
  /** Bytes written (the full length when `buffer` is 0 or too small). */
  FPDFImageObj_GetImageDataRaw(obj: number, buffer: number, length: number): number
  FPDFImageObj_GetImageDataDecoded(obj: number, buffer: number, length: number): number
  FPDFImageObj_GetBitmap(obj: number): number
  FPDFImageObj_SetBitmap(pages: number, count: number, obj: number, bitmap: number): boolean
  FPDFBitmap_CreateEx(w: number, h: number, format: number, first: number, stride: number): number
  FPDFBitmap_GetFormat(bitmap: number): number
  FPDFBitmap_GetWidth(bitmap: number): number
  FPDFBitmap_GetHeight(bitmap: number): number
  FPDFBitmap_GetStride(bitmap: number): number
  FPDFBitmap_GetBuffer(bitmap: number): number
  FPDFBitmap_Destroy(bitmap: number): void
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
  /**
   * Pixel redaction (see the header): pageIndex → the image XObjects the pdf-lib pre-pass found on
   * that page (pixel-redact-doc.ts `imageCandidates`). An image matched to none of them is removed
   * whole. Off when absent; the export passes it.
   */
  pixels?: PageCandidates
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
   * The object's bounds (for invisible text its own, not the pad the overlap test used), in
   * unrotated user space; null when the extent is unknown (the caller must then treat the whole
   * page as removed).
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

/** How far below the baseline the invisible-text pad reaches, in em (descenders: ~0.2–0.25 em). */
export const PAD_DESCENT = 0.25

const UNKNOWN_BOX: PdfBox = Object.freeze({ l: NaN, b: NaN, r: NaN, t: NaN })

/**
 * The bounds of a text object grown for the overlap test when the text is invisible (render
 * mode 3) or in a glyphless OCR font: the union of `box` with the object's em box (see the header:
 * the baseline extent of `box`, from PAD_DESCENT em below the baseline to 1 em above it, along the
 * em vector size × (c, d) from the text origin (e, f)). `fb` is scratch memory of at least 32
 * bytes. Other objects (and text that is neither) keep `box`.
 */
function invisibleTextPad(pdfium: PdfiumModule, obj: number, box: PdfBox, fb: number): PdfBox {
  if (pdfium.FPDFPageObj_GetType(obj) !== FPDF_PAGEOBJ_TEXT) return box
  const invisible =
    pdfium.FPDFTextObj_GetTextRenderMode(obj) === FPDF_TEXTRENDERMODE_INVISIBLE ||
    namedAs(baseFontName(pdfium, obj), GLYPHLESS_FONT_NAMES)
  if (!invisible) return box
  const rt = pdfium.pdfium
  // Size × the text matrix's y axis (c, d): the em vector in user space [measured: the matrix
  // carries Tz and the CTM, the size is the bare Tf operand; (e, f) is the text origin on the
  // baseline]. A matrix or size PDFium cannot give makes the extent unknown, which the caller
  // turns into a whole-page removal.
  if (!pdfium.FPDFTextObj_GetFontSize(obj, fb)) return UNKNOWN_BOX
  const size = Math.abs(rt.getValue(fb, 'float'))
  if (!pdfium.FPDFPageObj_GetMatrix(obj, fb + 8)) return UNKNOWN_BOX
  const [a, b, c, d, e, f] = [0, 4, 8, 12, 16, 20].map((o) => rt.getValue(fb + 8 + o, 'float'))
  const n = Math.hypot(a, b)
  if (!(n > 0) || !Number.isFinite(size)) return UNKNOWN_BOX
  // The baseline direction, and the extent of `box` along it measured from the origin.
  const ux = a / n
  const uy = b / n
  const along = [
    [box.l, box.b],
    [box.r, box.b],
    [box.r, box.t],
    [box.l, box.t]
  ].map(([x, y]) => (x - e) * ux + (y - f) * uy)
  const s0 = Math.min(...along)
  const s1 = Math.max(...along)
  // A mirrored or flipped text matrix still has its em box on the side (c, d) points to.
  const vx = size * c
  const vy = size * d
  const xs: number[] = [box.l, box.r]
  const ys: number[] = [box.b, box.t]
  for (const s of [s0, s1])
    for (const t of [-PAD_DESCENT, 1]) {
      xs.push(e + s * ux + t * vx)
      ys.push(f + s * uy + t * vy)
    }
  return { l: Math.min(...xs), b: Math.min(...ys), r: Math.max(...xs), t: Math.max(...ys) }
}

/**
 * `hits` (annotation indices of `page`) plus every annotation tied to one of them, to a fixpoint:
 * the /Popup of a removed annotation, and each annotation whose /Parent or /IRT is a removed one.
 */
function linkedAnnots(
  pdfium: PdfiumModule,
  page: number,
  count: number,
  hits: ReadonlySet<number>
): Set<number> {
  const gone = new Set(hits)
  if (!gone.size) return gone
  /** The page index of the annotation `key` of annotation `i` names (-1: none, or off the page). */
  const linked = (i: number, key: string): number => {
    const annot = pdfium.FPDFPage_GetAnnot(page, i)
    if (!annot) return -1
    try {
      const other = pdfium.FPDFAnnot_GetLinkedAnnot(annot, key)
      if (!other) return -1
      try {
        return pdfium.FPDFPage_GetAnnotIndex(page, other)
      } finally {
        pdfium.FPDFPage_CloseAnnot(other)
      }
    } finally {
      pdfium.FPDFPage_CloseAnnot(annot)
    }
  }
  for (let grew = true; grew; ) {
    grew = false
    for (let i = 0; i < count; i++) {
      const add = (j: number): void => {
        if (j < 0 || j >= count || gone.has(j)) return
        gone.add(j)
        grew = true
      }
      if (gone.has(i)) add(linked(i, 'Popup'))
      else if (['Parent', 'IRT'].some((k) => gone.has(linked(i, k)))) add(i)
    }
  }
  return gone
}

const finiteBox = (b: PdfBox): boolean =>
  Number.isFinite(b.l) && Number.isFinite(b.b) && Number.isFinite(b.r) && Number.isFinite(b.t)

const FPDF_PAGEOBJ_IMAGE = 3
/** FPDFBitmap_* formats. */
const BITMAP_GRAY = 1
const BITMAP_BGR = 2
const BITMAP_BGRX = 3
/** FPDF_COLORSPACE_* of each plan colour space. */
const PDFIUM_COLORSPACE = { DeviceGray: 1, DeviceRGB: 2, Indexed: 10 } as const
/**
 * The bits per pixel FPDFImageObj_GetImageMetadata reports for a plan's layout: 1 for 1-bit Gray
 * and Indexed, 8 for the other Gray and Indexed depths and for 1- and 2-bit RGB, 24 for 4- and
 * 8-bit RGB [measured, @embedpdf/pdfium 2.14.4, every depth of the three colour spaces, Flate,
 * CCITT and DCT]. Anything else falls back to whole-image removal.
 */
const pdfiumBpp = (plan: ImagePlan): number =>
  plan.colorSpace.kind === 'DeviceRGB' ? (plan.bpc >= 4 ? 24 : 8) : plan.bpc === 1 ? 1 : 8

/**
 * `n` bytes PDFium writes through `fill(ptr, n)`, copied out of the heap; null if it wrote fewer,
 * or if the heap cannot hold them (malloc gives 0, and PDFium would take a 0 buffer for a length
 * query and report n written, so the "samples" would be whatever the heap holds at address 0).
 */
function readOut(
  pdfium: PdfiumModule,
  n: number,
  fill: (ptr: number, n: number) => number
): Uint8Array | null {
  const rt = pdfium.pdfium
  const ptr = rt.wasmExports.malloc(n)
  if (!ptr) return null
  try {
    if (fill(ptr, n) < n) return null
    return new Uint8Array(rt.HEAPU8.subarray(ptr, ptr + n)) // a copy: the heap may grow later
  } finally {
    rt.wasmExports.free(ptr)
  }
}

/** PDFium's decode of an image object (FPDFImageObj_GetBitmap), as the heap holds it. */
interface PdfiumBitmap {
  heap: Uint8Array
  buf: number
  /** Bytes per row. */
  stride: number
  /** Bytes per pixel: 1 (grey) or 3 / 4 (BGR / BGRx). */
  px: 1 | 3 | 4
}

/** Bytes per pixel of the FPDFBitmap formats the pass reads. */
const BITMAP_PIXEL_BYTES: Partial<Record<number, 1 | 3 | 4>> = {
  [BITMAP_GRAY]: 1,
  [BITMAP_BGR]: 3,
  [BITMAP_BGRX]: 4
}

/** `fn` on PDFium's W × H decode of `obj`; null when there is none, or not in a grey/BGR format. */
function withBitmap<T>(
  pdfium: PdfiumModule,
  obj: number,
  W: number,
  H: number,
  fn: (b: PdfiumBitmap) => T
): T | null {
  const bmp = pdfium.FPDFImageObj_GetBitmap(obj)
  if (!bmp) return null
  try {
    if (pdfium.FPDFBitmap_GetWidth(bmp) !== W || pdfium.FPDFBitmap_GetHeight(bmp) !== H) return null
    const fmt = pdfium.FPDFBitmap_GetFormat(bmp)
    const px = BITMAP_PIXEL_BYTES[fmt]
    if (!px) return null
    const buf = pdfium.FPDFBitmap_GetBuffer(bmp)
    if (!buf) return null
    return fn({ heap: pdfium.pdfium.HEAPU8, buf, stride: pdfium.FPDFBitmap_GetStride(bmp), px })
  } finally {
    pdfium.FPDFBitmap_Destroy(bmp)
  }
}

/**
 * Does the 8-bit raster `r` (W × H, RGB order) show exactly what PDFium's decode `b` does? A grey
 * raster matches a BGR decode whose three channels all equal it.
 */
function sameAsBitmap(
  r: PixelReplacement['interim'],
  W: number,
  H: number,
  b: PdfiumBitmap
): boolean {
  const { heap, buf, stride, px } = b
  if (r.channels === 3 && px === 1) return false
  const d = r.data
  for (let y = 0; y < H; y++) {
    const row = buf + y * stride
    if (px === 1) {
      for (let x = 0, i = y * W; x < W; x++, i++) if (heap[row + x] !== d[i]) return false
    } else if (r.channels === 1) {
      for (let x = 0, s = row, i = y * W; x < W; x++, s += px, i++) {
        const v = d[i]
        if (heap[s] !== v || heap[s + 1] !== v || heap[s + 2] !== v) return false
      }
    } else {
      for (let x = 0, s = row, i = y * W * 3; x < W; x++, s += px, i += 3)
        if (heap[s + 2] !== d[i] || heap[s + 1] !== d[i + 1] || heap[s] !== d[i + 2]) return false
    }
  }
  return true
}

/**
 * The image's samples in the plan's layout (packed rows, its depth and colour space), or null when
 * PDFium cannot give exactly that. 'samples' is the stream after its non-image filters; 'bitmap'
 * is PDFium's decode of a CCITT, JBIG2 or DCT image, converted back to samples (1-bit sources must
 * decode to pure black and white, or the image is not what the plan says).
 *
 * The plan is read off pdf-lib's view of the dictionary, PDFium's off its own, and the two can
 * differ (a file defining the object twice: pdf-lib keeps the last definition, PDFium follows the
 * xref), and PDFium's metadata cannot tell 2, 4 and 8 bits apart. So 'samples' must be EXACTLY
 * stride × H bytes (trailing bytes, which readers ignore, are not told apart from a deeper reading)
 * and, expanded under the plan, must reproduce PDFium's own decode of the object sample for sample
 * [measured: it does, exactly, for every in-scope depth and colour space, Indexed included].
 * Otherwise the box would be mapped onto other bytes than the ones shown under it, and the image
 * is removed whole instead.
 */
function sourceSamples(
  pdfium: PdfiumModule,
  obj: number,
  W: number,
  H: number,
  plan: ImagePlan
): Uint8Array | null {
  const nc = componentsOf(plan.colorSpace)
  const stride = rowBytesOf(W, nc, plan.bpc)
  if (plan.decode === 'samples') {
    const n = pdfium.FPDFImageObj_GetImageDataDecoded(obj, 0, 0)
    if (n !== stride * H) return null
    const samples = readOut(pdfium, n, (p, len) => pdfium.FPDFImageObj_GetImageDataDecoded(obj, p, len)) // prettier-ignore
    if (!samples) return null
    const shown = expandSamples(samples, W, H, plan)
    return withBitmap(pdfium, obj, W, H, (b) => sameAsBitmap(shown, W, H, b)) ? samples : null
  }
  return withBitmap(pdfium, obj, W, H, ({ heap, buf, stride: bs, px }) => {
    const out = new Uint8Array(stride * H)
    if (plan.colorSpace.kind === 'DeviceGray') {
      if (px !== 1) return null
      for (let r = 0; r < H; r++) {
        const row = buf + r * bs
        if (plan.bpc === 8) {
          out.set(heap.subarray(row, row + W), r * stride)
          continue
        }
        if (plan.bpc !== 1) return null
        for (let x = 0; x < W; x++) {
          const v = heap[row + x]
          if (v === 255) out[r * stride + (x >> 3)] |= 0x80 >> (x & 7)
          else if (v !== 0) return null
        }
      }
      return out
    }
    if (plan.colorSpace.kind !== 'DeviceRGB' || plan.bpc !== 8 || px === 1) return null
    for (let r = 0; r < H; r++)
      for (let x = 0; x < W; x++) {
        const s = buf + r * bs + x * px
        const d = r * stride + x * 3
        out[d] = heap[s + 2]
        out[d + 1] = heap[s + 1]
        out[d + 2] = heap[s]
      }
    return out
  })
}

/** A new image object showing the 8-bit `interim` raster, placed by the matrix at `matrixPtr`. */
function interimImage(
  pdfium: PdfiumModule,
  doc: number,
  interim: PixelReplacement['interim'],
  W: number,
  H: number,
  matrixPtr: number
): number {
  const bmp = pdfium.FPDFBitmap_CreateEx(W, H, interim.channels === 1 ? BITMAP_GRAY : BITMAP_BGR, 0, 0) // prettier-ignore
  if (!bmp) return 0
  let obj = 0
  try {
    const bs = pdfium.FPDFBitmap_GetStride(bmp)
    const buf = pdfium.FPDFBitmap_GetBuffer(bmp)
    const heap = pdfium.pdfium.HEAPU8
    const { data } = interim
    if (interim.channels === 1)
      for (let r = 0; r < H; r++) heap.set(data.subarray(r * W, r * W + W), buf + r * bs)
    else
      for (let r = 0; r < H; r++)
        for (let x = 0; x < W; x++) {
          const s = (r * W + x) * 3
          const d = buf + r * bs + x * 3
          heap[d] = data[s + 2]
          heap[d + 1] = data[s + 1]
          heap[d + 2] = data[s]
        }
    obj = pdfium.FPDFPageObj_NewImageObj(doc)
    if (!obj) return 0
    if (
      !pdfium.FPDFImageObj_SetBitmap(0, 0, obj, bmp) ||
      !pdfium.FPDFPageObj_SetMatrix(obj, matrixPtr)
    ) {
      pdfium.FPDFPageObj_Destroy(obj)
      return 0
    }
    return obj
  } finally {
    pdfium.FPDFBitmap_Destroy(bmp)
  }
}

/**
 * Pixel redaction of one image object (see the header): a new image object, not yet on the page,
 * with every sample `rects` touch blanked, and the replacement record for the pdf-lib pass. Null
 * when the image is out of scope or any step fails: the caller then removes the whole image.
 */
function pixelRedact(
  pdfium: PdfiumModule,
  doc: number,
  page: number,
  obj: number,
  box: PdfBox,
  rects: readonly RedactRect[],
  candidates: readonly ImageCandidate[]
): { obj: number; replacement: PixelReplacement } | null {
  if (pdfium.FPDFPageObj_GetType(obj) !== FPDF_PAGEOBJ_IMAGE) return null
  // The new object carries neither the original's graphics state (soft mask, alpha, blend mode),
  // nor its clip, nor its marked content (optional content, tags): any of them is out of scope.
  if (pdfium.FPDFPageObj_HasTransparency(obj)) return null
  const clip = pdfium.FPDFPageObj_GetClipPath(obj)
  if (clip && pdfium.FPDFClipPath_CountPaths(clip) > 0) return null
  if (pdfium.FPDFPageObj_CountMarks(obj) > 0) return null
  const rt = pdfium.pdfium
  const mp = rt.wasmExports.malloc(64) // FS_MATRIX at 0..23, pixel size at 24..31, metadata at 32..59
  if (!mp) return null
  try {
    if (!pdfium.FPDFPageObj_GetMatrix(obj, mp)) return null
    const m = [0, 4, 8, 12, 16, 20].map((o) => rt.getValue(mp + o, 'float')) as unknown as Matrix
    if (!isAxisAligned(m)) return null
    if (!pdfium.FPDFImageObj_GetImagePixelSize(obj, mp + 24, mp + 28)) return null
    const W = rt.getValue(mp + 24, 'i32')
    const H = rt.getValue(mp + 28, 'i32')
    if (!(W > 0 && H > 0)) return null
    const rawLength = pdfium.FPDFImageObj_GetImageDataRaw(obj, 0, 0)
    if (!(rawLength > 0)) return null
    const raw = readOut(pdfium, rawLength, (p, n) => pdfium.FPDFImageObj_GetImageDataRaw(obj, p, n))
    if (!raw) return null
    const cand = matchCandidate(candidates, W, H, raw)
    if (!cand || 'skip' in cand.plan) return null
    const plan = cand.plan
    // PDFium's own reading of the object must agree with the plan's sample layout (an inline image
    // whose data happened to equal an XObject's would otherwise be read with the wrong layout).
    if (!pdfium.FPDFImageObj_GetImageMetadata(obj, page, mp + 32)) return null
    const bpp = rt.getValue(mp + 48, 'i32')
    const csId = rt.getValue(mp + 52, 'i32')
    if (csId !== PDFIUM_COLORSPACE[plan.colorSpace.kind]) return null
    if (bpp !== pdfiumBpp(plan)) return null
    const px = rects.map((rc) => pixelRect(m, W, H, rc)).filter((p): p is PixelRect => !!p)
    if (!px.length) return null
    const cs = plan.colorSpace
    // The budget, before anything is decoded (see MAX_RASTER_BYTES).
    if (W * H * channelsOf(cs) > MAX_RASTER_BYTES) return null
    const samples = sourceSamples(pdfium, obj, W, H, plan)
    if (!samples) return null
    const nc = componentsOf(cs)
    blankSamples(samples, W, nc, plan.bpc, px, blankValue(cs, plan.bpc))
    // The growth gate, given up on as soon as it is sure to fail (a JPEG scan).
    const data = encodeWithin(samples, rowBytesOf(W, nc, plan.bpc), MAX_GROWTH * rawLength)
    if (!data) return null
    const interim = expandSamples(samples, W, H, plan)
    const created = interimImage(pdfium, doc, interim, W, H, mp)
    if (!created) return null
    return {
      obj: created,
      replacement: {
        width: W,
        height: H,
        interim,
        final: { bpc: plan.bpc, colorSpace: cs, data },
        sourceLength: rawLength,
        rects: px,
        box: { ...box }
      }
    }
  } finally {
    rt.wasmExports.free(mp)
  }
}

/** The page's object index of `obj`, or -1. */
function objectIndex(pdfium: PdfiumModule, page: number, obj: number): number {
  const n = pdfium.FPDFPage_CountObjects(page)
  for (let i = 0; i < n; i++) if (pdfium.FPDFPage_GetObject(page, i) === obj) return i
  return -1
}

/**
 * Redact one loaded page; returns what it removed (see `RemovedObject`). Content objects in the
 * `dropOcrText` sweep that do not themselves overlap a box are removed but NOT reported: they are
 * invisible text, so no pixel goes with them and no OCR word over them needs to go either. An image
 * redacted pixel by pixel (`pixels`) is not reported: it is replaced, not removed.
 */
function redactPage(
  pdfium: PdfiumModule,
  doc: number,
  page: number,
  rects: RedactRect[],
  opts: RedactOptions,
  candidates: readonly ImageCandidate[] | undefined
): { removed: RemovedObject[]; pixels: PixelReplacement[] } {
  const rt = pdfium.pdfium
  const { malloc, free } = rt.wasmExports
  const removed: RemovedObject[] = []
  const pixels: PixelReplacement[] = []
  const fb = malloc(48) // object bounds / annotation rects at 0..15, the pad's scratch at 16..47
  try {
    // 1) Remove page CONTENT objects overlapping any rect (collect handles, then remove by handle).
    //    An in-scope image is swapped for a pixel-redacted copy instead (`swaps`).
    const doomed: number[] = []
    const swaps: { orig: number; obj: number; replacement: PixelReplacement }[] = []
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
      const known = finiteBox(box) && finiteBox(raw)
      // Unknown extent (non-finite bounds, or an invisible text object whose pad PDFium cannot
      // give): removed, and reported as unknown. `overlaps` already said yes to NaN bounds before
      // the report existed, and for invisible text the removal changes no pixel.
      const hit = !known || rects.some((rc) => overlaps(box.l, box.b, box.r, box.t, rc))
      if (hit) {
        if (known && candidates) {
          const over = rects.filter((rc) => overlaps(raw.l, raw.b, raw.r, raw.t, rc))
          const swap = pixelRedact(pdfium, doc, page, obj, raw, over, candidates)
          if (swap) {
            swaps.push({ orig: obj, ...swap })
            continue
          }
        }
        doomed.push(obj)
        // The object's OWN bounds, not the pad: the pad only decides removal. A padded object is
        // invisible text, which paints no pixel an OCR word could describe, and the em box would
        // reach the footprints of the words on the lines above and below (rule 2 would drop them).
        removed.push({ type: pdfium.FPDFPageObj_GetType(obj), box: known ? raw : null })
      } else if (sweep) doomed.push(obj)
    }
    // The copy takes the original's place in the object list (its z-order), then the original goes
    // like any removed object. Should PDFium refuse the insertion, the image is removed whole.
    for (const s of swaps) {
      const at = objectIndex(pdfium, page, s.orig)
      if (at >= 0 && pdfium.FPDFPage_InsertObjectAtIndex(page, s.obj, at)) {
        pixels.push(s.replacement)
      } else {
        pdfium.FPDFPageObj_Destroy(s.obj)
        removed.push({ type: FPDF_PAGEOBJ_IMAGE, box: s.replacement.box })
      }
      doomed.push(s.orig)
    }
    for (const obj of doomed) {
      if (!pdfium.FPDFPage_RemoveObject(page, obj)) {
        throw new Error('redact: FPDFPage_RemoveObject failed')
      }
      pdfium.FPDFPageObj_Destroy(obj)
    }

    // 2) Remove ANNOTATIONS / widgets overlapping any rect, and the annotations tied to them
    //    (`linkedAnnots`), descending so indices stay valid. FS_RECTF layout:
    //    { left@0, top@4, right@8, bottom@12 }.
    const annotCount = pdfium.FPDFPage_GetAnnotCount(page)
    const boxes = new Map<number, PdfBox | null>()
    const hits = new Set<number>()
    for (let i = 0; i < annotCount; i++) {
      const annot = pdfium.FPDFPage_GetAnnot(page, i)
      if (!annot) continue
      const ok = pdfium.FPDFAnnot_GetRect(annot, fb)
      const l = rt.getValue(fb, 'float')
      const t = rt.getValue(fb + 4, 'float')
      const r = rt.getValue(fb + 8, 'float')
      const b = rt.getValue(fb + 12, 'float')
      pdfium.FPDFPage_CloseAnnot(annot)
      // A rect may be stored with its corners swapped: report it normalised.
      const box = { l: Math.min(l, r), b: Math.min(b, t), r: Math.max(l, r), t: Math.max(b, t) }
      boxes.set(i, ok && finiteBox(box) ? box : null)
      if (ok && rects.some((rc) => overlaps(l, b, r, t, rc))) hits.add(i)
    }
    const gone = linkedAnnots(pdfium, page, annotCount, hits)
    for (const i of [...gone].sort((x, y) => y - x)) {
      if (!pdfium.FPDFPage_RemoveAnnot(page, i)) {
        throw new Error('redact: FPDFPage_RemoveAnnot failed')
      }
      // A tied annotation is reported too: what it painted (a reply's icon) goes with it.
      removed.push({ type: 'annot', box: boxes.get(i) ?? null })
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
  return { removed, pixels }
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

/** The marked-content tag of the PDFx OCR layer (ocr-layer.ts `OCR_MARK`, kept free of pdf-lib). */
const OCR_MARK_NAME = 'PDFxOCR'

/** Does page object `obj` sit inside a `/PDFxOCR` marked-content sequence? `buf`: ≥ 2 KB scratch. */
function hasOcrMark(pdfium: PdfiumModule, obj: number, buf: number, len: number): boolean {
  const rt = pdfium.pdfium
  const n = pdfium.FPDFPageObj_CountMarks(obj)
  for (let i = 0; i < n; i++) {
    const mark = pdfium.FPDFPageObj_GetMark(obj, i)
    if (!mark) continue
    // UTF-16LE name, NUL-terminated; outLen (bytes, NUL included) at the end of the buffer.
    const outLen = buf + len - 4
    if (!pdfium.FPDFPageObjMark_GetName(mark, buf, len - 4, outLen)) continue
    const bytes = rt.getValue(outLen, 'i32')
    if (bytes !== (OCR_MARK_NAME.length + 1) * 2) continue
    let name = ''
    for (let k = 0; k < OCR_MARK_NAME.length; k++)
      name += String.fromCharCode(rt.HEAPU8[buf + 2 * k] | (rt.HEAPU8[buf + 2 * k + 1] << 8))
    if (name === OCR_MARK_NAME) return true
  }
  return false
}

/** FPDFPageObj_GetType of a Form XObject. */
const FPDF_PAGEOBJ_FORM = 5

/**
 * Remove the PDFx OCR text layer from `pages` (page indices) of `bytes` when no tagged stream holds
 * it any more (DESIGN.md §3.7.6 fallback): an earlier rewrite MERGED its streams into the page's
 * other content, or a later tool wrapped the page, layer included, into a Form XObject (N-up,
 * stamping). Nothing is left to drop with pdf-lib, but the layer's text objects still carry the
 * `/PDFxOCR` mark. Every text object inside that mark, or shown in the PDFx OCR font (a rewrite
 * that lost the marks), is removed, on the page and inside the Form XObjects the page draws, then
 * the page content is regenerated (`FPDFPage_GenerateContent`, the same mechanics as `redactPdf`),
 * which also rewrites those forms, and the document is rewritten in full (FPDF_NO_INCREMENTAL). A
 * text object in the font draws nothing (3 Tr, glyphless), so no visible content goes with it.
 * With no text object left in the font, GenerateContent also unbinds it from the page's (and the
 * form's) resources. All three measured in ocr-replace.node.test.ts.
 *
 * Only ONE level of forms: GenerateContent does not rewrite a form nested in another form, even
 * with its objects removed and the outer form object marked dirty [measured, PDFium in
 * @embedpdf/pdfium 2.14.4], so nothing is removed there and the caller's check after the drop
 * (build.ts `passExistingOcr`) fails the export instead. A form another page also draws changes
 * for that page too: it loses the same layer text (never gains any).
 *
 * Returns the rewritten bytes and the number of objects removed per page. Pages with nothing to
 * remove are not regenerated. Fails closed: any PDFium failure throws.
 */
export function stripOcrText(
  pdfium: PdfiumModule,
  bytes: Uint8Array,
  pages: Iterable<number>
): { bytes: Uint8Array; removed: Map<number, number> } {
  const removed = new Map<number, number>()
  const rt = pdfium.pdfium
  const { malloc, free } = rt.wasmExports
  const filePtr = malloc(bytes.length)
  rt.HEAPU8.set(bytes, filePtr)
  const doc = pdfium.FPDF_LoadMemDocument(filePtr, bytes.length, '')
  if (!doc) {
    free(filePtr)
    throw new Error('ocr: failed to load PDF to remove its recognized text')
  }
  const NAME_BUF = 2048
  const buf = malloc(NAME_BUF)
  try {
    for (const pageIndex of new Set(pages)) {
      const page = pdfium.FPDF_LoadPage(doc, pageIndex)
      if (!page) throw new Error(`ocr: FPDF_LoadPage failed for page ${pageIndex}`)
      try {
        /** [the Form XObject holding it (0: the page itself), the text object]. */
        const doomed: [number, number][] = []
        const isDoomed = (obj: number): boolean =>
          hasOcrMark(pdfium, obj, buf, NAME_BUF) || isOcrText(pdfium, obj)
        const count = pdfium.FPDFPage_CountObjects(page)
        for (let i = 0; i < count; i++) {
          const obj = pdfium.FPDFPage_GetObject(page, i)
          if (!obj) continue
          const type = pdfium.FPDFPageObj_GetType(obj)
          if (type === FPDF_PAGEOBJ_TEXT && isDoomed(obj)) doomed.push([0, obj])
          if (type !== FPDF_PAGEOBJ_FORM) continue
          const n = pdfium.FPDFFormObj_CountObjects(obj)
          for (let j = 0; j < n; j++) {
            const inner = pdfium.FPDFFormObj_GetObject(obj, j)
            if (inner && pdfium.FPDFPageObj_GetType(inner) === FPDF_PAGEOBJ_TEXT && isDoomed(inner))
              doomed.push([obj, inner])
          }
        }
        removed.set(pageIndex, doomed.length)
        if (!doomed.length) continue
        for (const [form, obj] of doomed) {
          const ok = form
            ? pdfium.FPDFFormObj_RemoveObject(form, obj)
            : pdfium.FPDFPage_RemoveObject(page, obj)
          if (!ok) throw new Error('ocr: removing a recognized-text object failed')
          pdfium.FPDFPageObj_Destroy(obj)
        }
        if (!pdfium.FPDFPage_GenerateContent(page))
          throw new Error('ocr: FPDFPage_GenerateContent failed')
      } finally {
        pdfium.FPDF_ClosePage(page)
      }
    }
    return { bytes: saveDocument(pdfium, doc), removed }
  } finally {
    free(buf)
    pdfium.FPDF_CloseDocument(doc)
    free(filePtr)
  }
}

/** `redactPdf`'s output plus what it removed: pageIndex → `RemovedObject`s (§3.7.3 rule 2). */
export interface RedactResult {
  bytes: Uint8Array
  /** One entry for every page that had rects (empty when nothing overlapped). */
  removed: Map<number, RemovedObject[]>
  /**
   * pageIndex → its pixel-redacted images (only pages that have one). Their objects in `bytes` are
   * the 8-bit interims: pixel-redact-doc.ts `swapPixelImages` puts the final streams in.
   */
  pixels: Map<number, PixelReplacement[]>
}

/** `redactPdf`, also returning the removed-object report of every redacted page. */
export function redactPdfReport(
  pdfium: PdfiumModule,
  bytes: Uint8Array,
  pages: PageRedaction[],
  opts: RedactOptions = {}
): RedactResult {
  const steps = redactSteps(pdfium, bytes, pages, opts)
  for (;;) {
    const s = steps.next()
    if (s.done) return s.value
  }
}

/**
 * `redactPdfReport`, giving the event loop a turn after each redacted page: the pass runs on the
 * renderer thread, and a pixel-redacted page can take a few hundred ms (MAX_RASTER_BYTES bounds it).
 * The document stays open in between; nothing else touches it.
 */
export async function redactPdfReportAsync(
  pdfium: PdfiumModule,
  bytes: Uint8Array,
  pages: PageRedaction[],
  opts: RedactOptions = {}
): Promise<RedactResult> {
  const steps = redactSteps(pdfium, bytes, pages, opts)
  for (;;) {
    const s = steps.next()
    if (s.done) return s.value
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

/** The pass, one step per redacted page (see redactPdfReport / redactPdfReportAsync). */
function* redactSteps(
  pdfium: PdfiumModule,
  bytes: Uint8Array,
  pages: PageRedaction[],
  opts: RedactOptions
): Generator<void, RedactResult> {
  const removed = new Map<number, RemovedObject[]>()
  const pixels = new Map<number, PixelReplacement[]>()
  const rt = pdfium.pdfium
  const { malloc, free } = rt.wasmExports
  const filePtr = malloc(bytes.length)
  if (!filePtr) throw new Error('redact: out of memory loading the PDF')
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
        const got = redactPage(pdfium, doc, page, rects, opts, opts.pixels?.get(pageIndex))
        removed.set(pageIndex, [...(removed.get(pageIndex) ?? []), ...got.removed])
        if (got.pixels.length)
          pixels.set(pageIndex, [...(pixels.get(pageIndex) ?? []), ...got.pixels])
      } finally {
        pdfium.FPDF_ClosePage(page)
      }
      yield
    }
    return { bytes: saveDocument(pdfium, doc), removed, pixels }
  } finally {
    pdfium.FPDF_CloseDocument(doc)
    free(filePtr)
  }
}
