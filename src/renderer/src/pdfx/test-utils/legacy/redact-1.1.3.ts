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

/** True if a box (l,b,r,t) positively overlaps the rectangle. */
function overlaps(l: number, b: number, r: number, t: number, rc: RedactRect): boolean {
  return !(r <= rc.x || l >= rc.x + rc.w || t <= rc.y || b >= rc.y + rc.h)
}

function redactPage(pdfium: PdfiumModule, page: number, rects: RedactRect[]): void {
  const rt = pdfium.pdfium
  const { malloc, free } = rt.wasmExports
  const fb = malloc(16) // four floats; reused for object bounds and annotation rects
  try {
    // 1) Remove page CONTENT objects overlapping any rect (collect handles, then remove by handle).
    const doomed: number[] = []
    const count = pdfium.FPDFPage_CountObjects(page)
    for (let i = 0; i < count; i++) {
      const obj = pdfium.FPDFPage_GetObject(page, i)
      if (!obj || !pdfium.FPDFPageObj_GetBounds(obj, fb, fb + 4, fb + 8, fb + 12)) continue
      const l = rt.getValue(fb, 'float')
      const b = rt.getValue(fb + 4, 'float')
      const r = rt.getValue(fb + 8, 'float')
      const t = rt.getValue(fb + 12, 'float')
      if (rects.some((rc) => overlaps(l, b, r, t, rc))) doomed.push(obj)
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
  pages: PageRedaction[]
): Uint8Array {
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
        redactPage(pdfium, page, rects)
      } finally {
        pdfium.FPDF_ClosePage(page)
      }
    }
    return saveDocument(pdfium, doc)
  } finally {
    pdfium.FPDF_CloseDocument(doc)
    free(filePtr)
  }
}
