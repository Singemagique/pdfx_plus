// The raster thread's PDFium logic against the real WASM (DESIGN.md §3.3.3, §3.3.4, §3.4.2):
// FPDF_LoadCustomDocument over a SharedArrayBuffer, the grey render and its frame against pdf.js,
// flags 0 leaving widget appearances out, the reopen watermark, the headroom probe, the
// silent-blank guard and RuntimeError propagation.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  PDFDocument,
  PDFName,
  StandardFonts,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rgb
} from 'pdf-lib'

import {
  DEFAULT_RASTER_LIMITS,
  FPDF_RENDER_NO_SMOOTHIMAGE,
  FPDFBitmap_Gray,
  paintBoxesWhite,
  RasterEngine,
  fitRaster,
  makePrintErr,
  type RenderOutcome
} from './raster-core'
import {
  FRAME_CASES,
  FRAME_MARKS,
  frameFixture,
  inkIoU,
  loadTestPdfium,
  widgetFixture,
  type TestPdfium
} from '../test-utils/pdfium-node'

const FPDF_ANNOT = 0x01
const ENLARGE_LINE =
  'Cannot enlarge memory, requested 2147549184 bytes, but the limit is 2147483648 bytes!'

let mod: TestPdfium
const docs: PDFDocumentProxy[] = []

beforeAll(async () => {
  mod = await loadTestPdfium()
})

afterAll(async () => {
  for (const d of docs) await d.destroy()
})

function shared(bytes: Uint8Array): Uint8Array {
  const sab = new SharedArrayBuffer(bytes.length)
  const view = new Uint8Array(sab)
  view.set(bytes)
  return view
}

async function pdfjs(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const d = (await getDocument({ data: bytes.slice(), verbosity: 0 })
    .promise) as unknown as PDFDocumentProxy
  docs.push(d)
  return d
}

function ok(out: RenderOutcome): Extract<RenderOutcome, { kind: 'ok' }> {
  if (out.kind !== 'ok') throw new Error(`render did not succeed: ${JSON.stringify(out)}`)
  return out
}

async function onePage(draw?: (doc: PDFDocument) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  page.drawRectangle({ x: 72, y: 600, width: 200, height: 100, color: rgb(0, 0, 0) })
  draw?.(doc)
  return doc.save()
}

describe('FPDF_LoadCustomDocument over a SharedArrayBuffer', () => {
  it('opens, counts pages and renders without copying the file into the heap', async () => {
    const doc = await PDFDocument.create()
    for (let i = 0; i < 3; i++) doc.addPage([300, 400])
    const engine = new RasterEngine(mod)
    engine.attach('s1', shared(await doc.save()))
    expect(engine.pageCount('s1')).toEqual({ pageCount: 3 })
    const out = ok(
      engine.render({
        src: 's1',
        index: 2,
        dpi: 72,
        userUnit: 1,
        frame: { width: 300, height: 400 }
      })
    )
    expect([out.width, out.height, out.data.length]).toEqual([300, 400, 300 * 400])
    // An empty page renders white: FillRect white under a Gray bitmap.
    expect(out.data.every((v) => v === 255)).toBe(true)
    engine.closeAll()
  })

  it('reports PDFium open errors instead of throwing', () => {
    const engine = new RasterEngine(mod)
    engine.attach('junk', shared(new TextEncoder().encode('%PDF-1.7\nnot really a pdf')))
    const r = engine.pageCount('junk')
    expect('pdfiumError' in r && r.pdfiumError).toBeGreaterThan(0)
    expect(engine.pageCount('never-attached')).toEqual({ pdfiumError: -1 })
  })
})

describe('grey render frame equals the pdf.js PageEntry frame', () => {
  const DPI = 144
  for (const c of FRAME_CASES) {
    it(c.name, async () => {
      const bytes = await frameFixture(c)
      const js = await pdfjs(bytes)
      const page = await js.getPage(1)
      const vp1 = page.getViewport({ scale: 1 })
      const engine = new RasterEngine(mod)
      engine.attach('f', shared(bytes))
      // The frame check inside render() is the one the app relies on: sending pdf.js's frame and
      // getting 'ok' back means PDFium's rotated view box equals it to 1e-3 pt.
      const out = ok(
        engine.render({
          src: 'f',
          index: 0,
          dpi: DPI,
          userUnit: 1,
          frame: { width: vp1.width, height: vp1.height }
        })
      )
      expect(out.width).toBe(Math.round((vp1.width * DPI) / 72))
      expect(out.height).toBe(Math.round((vp1.height * DPI) / 72))

      // Where the ink lands must match where pdf.js maps the marks (user space → viewport), which
      // catches a raster that has the right size but the wrong rotation or origin.
      const vp = page.getViewport({ scale: out.width / vp1.width })
      const mb = c.media ?? [0, 0, 612, 792]
      const mask = new Uint8Array(out.width * out.height)
      for (const m of FRAME_MARKS) {
        const [ax, ay] = vp.convertToViewportPoint(mb[0] + m.x, mb[1] + m.y)
        const [bx, by] = vp.convertToViewportPoint(mb[0] + m.x + m.w, mb[1] + m.y + m.h)
        const [x0, x1] = [Math.min(ax, bx), Math.max(ax, bx)]
        const [y0, y1] = [Math.min(ay, by), Math.max(ay, by)]
        for (let y = 0; y < out.height; y++)
          for (let x = 0; x < out.width; x++)
            if (x + 0.5 >= x0 && x + 0.5 <= x1 && y + 0.5 >= y0 && y + 0.5 <= y1)
              mask[y * out.width + x] = 1
      }
      expect(mask.some((v) => v === 1)).toBe(true)
      expect(inkIoU(out.data, mask)).toBeGreaterThan(0.95)
      engine.closeAll()
    })
  }

  it('fails a page whose frame does not match instead of placing text wrongly', async () => {
    const bytes = await frameFixture({ name: 'r90', rotate: 90 })
    const engine = new RasterEngine(mod)
    engine.attach('f', shared(bytes))
    // The unrotated size is what a renderer that ignored /Rotate would send.
    expect(
      engine.render({
        src: 'f',
        index: 0,
        dpi: 72,
        userUnit: 1,
        frame: { width: 612, height: 792 }
      })
    ).toEqual({
      kind: 'failed',
      status: 'failed',
      reason: 'frame-mismatch'
    })
  })

  it('fails /UserUnit ≠ 1 and an index past the end', async () => {
    const engine = new RasterEngine(mod)
    engine.attach('s', shared(await onePage()))
    const frame = { width: 612, height: 792 }
    expect(engine.render({ src: 's', index: 0, dpi: 72, userUnit: 2, frame })).toMatchObject({
      reason: 'user-unit'
    })
    expect(engine.render({ src: 's', index: 1, dpi: 72, userUnit: 1, frame })).toMatchObject({
      reason: 'page-missing'
    })
  })
})

describe('render flags 0', () => {
  type Rect = { x: number; y: number; w: number; h: number }
  const inkIn = (grey: Uint8Array, rect: Rect): number => {
    let n = 0
    for (let y = 792 - rect.y - rect.h; y < 792 - rect.y; y++)
      for (let x = rect.x; x < rect.x + rect.w; x++) if (grey[y * 612 + x] < 128) n++
    return n
  }
  const engineRender = (bytes: Uint8Array): Uint8Array => {
    const engine = new RasterEngine(mod)
    engine.attach('a', shared(bytes))
    const out = ok(
      engine.render({
        src: 'a',
        index: 0,
        dpi: 72,
        userUnit: 1,
        frame: { width: 612, height: 792 }
      })
    )
    engine.closeAll()
    return out.data
  }
  /** Render page 0 at 72 dpi straight through PDFium, optionally flattening annotations first. */
  const directRender = (bytes: Uint8Array, flags: number, flatten = false): Uint8Array => {
    const p = mod.pdfium.wasmExports.malloc(bytes.length)
    mod.pdfium.HEAPU8.set(bytes, p)
    const doc = mod.FPDF_LoadMemDocument(p, bytes.length, '')
    let page = mod.FPDF_LoadPage(doc, 0)
    if (flatten) {
      // FLAT_NORMALDISPLAY: the widget's appearance becomes page content. PDFium wants the page
      // reloaded afterwards.
      expect(
        (mod as unknown as { FPDFPage_Flatten(p: number, f: number): number }).FPDFPage_Flatten(
          page,
          0
        )
      ).toBe(1)
      mod.FPDF_ClosePage(page)
      page = mod.FPDF_LoadPage(doc, 0)
    }
    const bmp = mod.FPDFBitmap_CreateEx(612, 792, FPDFBitmap_Gray, 0, 0)
    mod.FPDFBitmap_FillRect(bmp, 0, 0, 612, 792, 0xffffffff)
    mod.FPDF_RenderPageBitmap(bmp, page, 0, 0, 612, 792, 0, flags)
    const buf = mod.FPDFBitmap_GetBuffer(bmp)
    const grey = mod.pdfium.HEAPU8.slice(buf, buf + 612 * 792)
    mod.FPDFBitmap_Destroy(bmp)
    mod.FPDF_ClosePage(page)
    mod.FPDF_CloseDocument(doc)
    mod.pdfium.wasmExports.free(p)
    return grey
  }

  it('leaves a filled form widget out of the OCR raster', async () => {
    const { bytes, rect } = await widgetFixture()
    expect(inkIn(engineRender(bytes), rect)).toBe(0)
    // Control: the widget's appearance is real. Flattened into page content, it paints.
    expect(inkIn(directRender(bytes, 0, true), rect)).toBeGreaterThan(100)
  })

  it('leaves an annotation appearance (a stamp) out, which FPDF_ANNOT would paint', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([612, 792])
    const rect = { x: 100, y: 400, w: 200, h: 50 }
    const ap = doc.context.register(
      doc.context.stream('0 g 0 0 200 50 re f', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 200, 50]
      })
    )
    const annot = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Stamp',
        Rect: [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h],
        F: 4,
        AP: { N: ap }
      })
    )
    page.node.addAnnot(annot)
    const bytes = await doc.save()
    expect(inkIn(engineRender(bytes), rect)).toBe(0)
    expect(inkIn(directRender(bytes, FPDF_ANNOT), rect)).toBeGreaterThan(rect.w * rect.h * 0.9)
  })
})

describe('pixel caps', () => {
  it('lowers the DPI until the raster fits 7,200 px and 36 MP', () => {
    const L = DEFAULT_RASTER_LIMITS
    expect(fitRaster(612, 792, 300, L)).toEqual({ dpi: 300, width: 2550, height: 3300 })
    // A4 at 600 DPI is 7016 px tall: allowed (34.8 MP, under both caps).
    expect(fitRaster(595.28, 841.89, 600, L)).toMatchObject({ dpi: 600, height: 7016 })
    // A0 at 300 DPI would be 9933 × 14043.
    const a0 = fitRaster(2383.94, 3370.39, 300, L)
    expect(Math.max(a0.width, a0.height)).toBeLessThanOrEqual(7200)
    expect(a0.width * a0.height).toBeLessThanOrEqual(36_000_000)
    expect(a0.dpi).toBeLessThan(300)
    // A long strip trips the area cap only through the side cap.
    const strip = fitRaster(100, 14400, 300, L)
    expect(strip.height).toBeLessThanOrEqual(7200)
  })
})

describe('memory guards', () => {
  it('discards a bitmap rendered after "Cannot enlarge memory" (the silent-blank guard)', async () => {
    let engine!: RasterEngine
    const faulty = {
      ...mod,
      FPDF_RenderPageBitmap: (...args: Parameters<TestPdfium['FPDF_RenderPageBitmap']>) => {
        // What PR0 saw near the 2 GiB cap: the line, then a normal return with a white bitmap.
        engine.noteStderr(ENLARGE_LINE)
        mod.FPDF_RenderPageBitmap(...args)
      }
    } as TestPdfium
    engine = new RasterEngine(faulty)
    engine.attach('s', shared(await onePage()))
    expect(
      engine.render({
        src: 's',
        index: 0,
        dpi: 72,
        userUnit: 1,
        frame: { width: 612, height: 792 }
      })
    ).toEqual({
      kind: 'heap-exhausted'
    })
    // The same line outside a render (e.g. a probe or a later allocation) is not a render failure.
    engine.noteStderr(ENLARGE_LINE)
    const clean = new RasterEngine(mod)
    clean.attach('s', shared(await onePage()))
    clean.noteStderr(ENLARGE_LINE)
    expect(
      clean.render({ src: 's', index: 0, dpi: 72, userUnit: 1, frame: { width: 612, height: 792 } })
        .kind
    ).toBe('ok')
    expect(engine.stderrTail).toContain(ENLARGE_LINE)
  })

  it('routes PDFium printErr lines into the engine, also those printed during a render', async () => {
    // What raster-thread.ts hands the Emscripten glue as `printErr`.
    let engine: RasterEngine | null = null
    const early: string[] = []
    const printErr = makePrintErr(() => engine, early)
    printErr('init line')
    expect(early).toEqual(['init line'])
    const faulty = {
      ...mod,
      FPDF_RenderPageBitmap: (...args: Parameters<TestPdfium['FPDF_RenderPageBitmap']>) => {
        // PDFium itself prints, through the glue, in the middle of the render call.
        printErr(ENLARGE_LINE)
        mod.FPDF_RenderPageBitmap(...args)
      }
    } as TestPdfium
    engine = new RasterEngine(faulty)
    engine.attach('s', shared(await onePage()))
    expect(
      engine.render({
        src: 's',
        index: 0,
        dpi: 72,
        userUnit: 1,
        frame: { width: 612, height: 792 }
      })
    ).toEqual({ kind: 'heap-exhausted' })
    expect(early).toEqual(['init line'])
    expect(engine.stderrTail).toEqual([ENLARGE_LINE])
  })

  it('answers heap-exhausted when the headroom probe cannot allocate', async () => {
    const big = DEFAULT_RASTER_LIMITS.decodeAllowance
    const starved = {
      ...mod,
      pdfium: {
        ...mod.pdfium,
        HEAPU8: mod.pdfium.HEAPU8,
        wasmExports: {
          malloc: (n: number) => (n >= big ? 0 : mod.pdfium.wasmExports.malloc(n)),
          free: (p: number) => mod.pdfium.wasmExports.free(p)
        }
      }
    } as unknown as TestPdfium
    // HEAPU8 is a live getter on the real module; read it through a getter here too.
    Object.defineProperty(starved.pdfium, 'HEAPU8', { get: () => mod.pdfium.HEAPU8 })
    const engine = new RasterEngine(starved)
    engine.attach('s', shared(await onePage()))
    expect(
      engine.render({
        src: 's',
        index: 0,
        dpi: 72,
        userUnit: 1,
        frame: { width: 612, height: 792 }
      })
    ).toEqual({
      kind: 'heap-exhausted'
    })
  })

  it('closes and reopens a document whose heap growth passed the watermark', async () => {
    let opens = 0
    const counting = {
      ...mod,
      FPDF_LoadCustomDocument: (fa: number, pw: string) => {
        opens++
        return mod.FPDF_LoadCustomDocument(fa, pw)
      }
    } as TestPdfium
    const frame = { width: 612, height: 792 }
    const bytes = await onePage()

    const keep = new RasterEngine(counting, { ...DEFAULT_RASTER_LIMITS, reopenWatermark: Infinity })
    keep.attach('s', shared(bytes))
    for (let i = 0; i < 3; i++) ok(keep.render({ src: 's', index: 0, dpi: 72, userUnit: 1, frame }))
    expect(opens).toBe(1)

    opens = 0
    // Watermark −1: any amount served counts as "past it", so every render reopens.
    const reopen = new RasterEngine(counting, { ...DEFAULT_RASTER_LIMITS, reopenWatermark: -1 })
    reopen.attach('s', shared(bytes))
    for (let i = 0; i < 3; i++)
      ok(reopen.render({ src: 's', index: 0, dpi: 72, userUnit: 1, frame }))
    expect(opens).toBe(3)
    keep.closeAll()
    reopen.closeAll()
  })

  it('reopens after a constant number of pages: the watermark bounds the bytes a document holds', async () => {
    // Every page draws its own uncompressed 512 × 512 DeviceGray image (256 KiB of stream data),
    // the case PDFium retains until the document closes. With the watermark measured as heap
    // growth, the gaps between reopens grew every cycle (freed memory is reused without growing
    // HEAPU8); measured as bytes served they stay constant.
    const SIDE = 512
    const PAGES = 40
    const doc = await PDFDocument.create()
    for (let i = 0; i < PAGES; i++) {
      const img = doc.context.stream(new Uint8Array(SIDE * SIDE).fill((i * 37) % 256), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: SIDE,
        Height: SIDE,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8
      })
      const page = doc.addPage([72, 72])
      const name = page.node.newXObject('Im', doc.context.register(img))
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(72, 0, 0, 72, 0, 0),
        drawObject(name),
        popGraphicsState()
      )
    }
    const bytes = await doc.save({ useObjectStreams: false })
    let current = -1
    const opensAt: number[] = []
    const counting = {
      ...mod,
      FPDF_LoadCustomDocument: (fa: number, pw: string) => {
        opensAt.push(current)
        return mod.FPDF_LoadCustomDocument(fa, pw)
      }
    } as TestPdfium
    const watermark = 2 * 2 ** 20
    const engine = new RasterEngine(counting, {
      ...DEFAULT_RASTER_LIMITS,
      reopenWatermark: watermark
    })
    engine.attach('s', shared(bytes))
    for (current = 0; current < PAGES; current++)
      ok(
        engine.render({
          src: 's',
          index: current,
          dpi: 18,
          userUnit: 1,
          frame: { width: 72, height: 72 }
        })
      )
    engine.closeAll()
    const gaps = opensAt.slice(1).map((p, i) => p - opensAt[i])
    // 2 MiB / 256 KiB = 8 pages per cycle (plus the page that crosses the mark).
    expect(gaps.length).toBeGreaterThanOrEqual(3)
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(Math.ceil(watermark / (SIDE * SIDE)) + 1)
  })

  it('lets a WebAssembly.RuntimeError out (the thread then poisons itself)', async () => {
    const trapping = {
      ...mod,
      FPDF_RenderPageBitmap: () => {
        throw new WebAssembly.RuntimeError('unreachable')
      }
    } as unknown as TestPdfium
    const engine = new RasterEngine(trapping)
    engine.attach('s', shared(await onePage()))
    expect(() =>
      engine.render({
        src: 's',
        index: 0,
        dpi: 72,
        userUnit: 1,
        frame: { width: 612, height: 792 }
      })
    ).toThrow(WebAssembly.RuntimeError)
  })
})

describe('PR6: near-scanned text mask and the NO_SMOOTHIMAGE flag (§3.4.1, §3.4.2)', () => {
  const dark = (d: Uint8Array): number => d.reduce((n, v) => n + (v < 128 ? 1 : 0), 0)

  it('maskText removes visible top-level text, paints text inside forms white, keeps the rest', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const page = doc.addPage([612, 792])
    // A "scan" (a black box), visible text over it, invisible text, and text inside a Form XObject.
    page.drawRectangle({ x: 72, y: 72, width: 100, height: 100, color: rgb(0, 0, 0) })
    page.drawText('VISIBLE HEADER', { x: 72, y: 700, size: 24, font })
    const formText = page.doc.context.stream(`BT /F1 24 Tf 72 600 Td (IN A FORM) Tj ET`, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 612, 792],
      Resources: { Font: { F1: font.ref } }
    })
    const fm = page.node.newXObject('Fm', doc.context.register(formText))
    page.pushOperators(pushGraphicsState(), drawObject(fm), popGraphicsState())
    const bytes = await doc.save()
    const engine = new RasterEngine(mod)
    engine.attach('m', shared(bytes))
    const req = { src: 'm', index: 0, dpi: 72, userUnit: 1, frame: { width: 612, height: 792 } }
    const plain = ok(engine.render(req))
    const masked = ok(engine.render({ ...req, maskText: true }))
    const band = (d: Uint8Array, y0: number, y1: number): Uint8Array => d.slice(y0 * 612, y1 * 612)
    // Header (top-level text) at y ≈ 700 pt → rows 70..100; the form text at y ≈ 600 → rows 170..200.
    expect(dark(band(plain.data, 70, 100))).toBeGreaterThan(100)
    expect(dark(band(masked.data, 70, 100))).toBe(0)
    expect(dark(band(plain.data, 170, 200))).toBeGreaterThan(100)
    expect(dark(band(masked.data, 170, 200))).toBe(0)
    // The scan is untouched.
    expect(dark(band(masked.data, 620, 720))).toBe(dark(band(plain.data, 620, 720)))
    // In memory only: the next render of the page has its text again.
    expect(dark(band(ok(engine.render(req)).data, 70, 100))).toBe(dark(band(plain.data, 70, 100)))
    void PDFName
    engine.closeAll()
  })

  it('paintBoxesWhite maps overlay boxes to pixels with a 1 px margin', () => {
    const d = new Uint8Array(100 * 50)
    paintBoxesWhite(d, 100, 50, [{ x0: 10, y0: 10, x1: 20, y1: 20 }], 200, 100)
    // pt → px is ×0.5; y flips: rows 40..45 → minus/plus 1 px.
    expect(d[39 * 100 + 5]).toBe(255)
    expect(d[45 * 100 + 10]).toBe(255)
    expect(d[46 * 100 + 10]).toBe(0)
    expect(d[42 * 100 + 11]).toBe(0)
  })

  it('FPDF_RENDER_NO_SMOOTHIMAGE (0x2000): no effect on an exact 1:1 1-bit render, live when scaled', async () => {
    // A 1-bit checker of 2 px cells, placed 1:1 at 300 DPI (the page is w × 72/300 pt), the way a
    // scan is: PR0b measured PDFium's raster of such a placement 97.8% exact against the source.
    const w = 600
    const h = 300
    const rowBytes = w / 8
    const bits = new Uint8Array(rowBytes * h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (((x >> 1) + (y >> 1)) % 2) bits[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7)
    const doc = await PDFDocument.create()
    const pw = (w * 72) / 300
    const ph = (h * 72) / 300
    const page = doc.addPage([pw, ph])
    const img = doc.context.register(
      doc.context.stream(bits, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: w,
        Height: h,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 1
      })
    )
    const name = page.node.newXObject('Im', img)
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(pw, 0, 0, ph, 0, 0),
      drawObject(name),
      popGraphicsState()
    )
    const engine = new RasterEngine(mod)
    engine.attach('b', shared(await doc.save()))
    const req = { src: 'b', index: 0, dpi: 300, userUnit: 1, frame: { width: pw, height: ph } }
    const smooth = ok(engine.render(req))
    const sharp = ok(engine.render({ ...req, flags: FPDF_RENDER_NO_SMOOTHIMAGE }))
    expect(FPDF_RENDER_NO_SMOOTHIMAGE).toBe(0x2000)
    expect([sharp.width, sharp.height]).toEqual([w, h])
    // The flag is live in this PDFium build: the two renders differ, and the unsmoothed one is
    // closer to the source bits.
    const exact = (d: Uint8Array): number => {
      let n = 0
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const ink = ((x >> 1) + (y >> 1)) % 2 === 0
          if (d[y * w + x] < 128 === ink) n++
        }
      return n / (w * h)
    }
    const r15 = { ...req, dpi: 450 }
    const s15 = ok(engine.render(r15))
    const n15 = ok(engine.render({ ...r15, flags: FPDF_RENDER_NO_SMOOTHIMAGE }))
    const grey = (d: Uint8Array): number => d.filter((v) => v !== 0 && v !== 255).length
    // [measured] An exact integer 1:1 placement is copied bit for bit either way …
    expect(exact(smooth.data)).toBe(1)
    expect(Buffer.from(sharp.data).equals(Buffer.from(smooth.data))).toBe(true)
    // … while at 1.5× (a 200 DPI fax rendered at 300) smoothing makes grey edges and the flag
    // keeps every pixel black or white.
    expect(grey(s15.data)).toBeGreaterThan(0)
    expect(grey(n15.data)).toBe(0)
    // Only that flag gets through: anything else is masked off.
    const other = ok(engine.render({ ...r15, flags: FPDF_RENDER_NO_SMOOTHIMAGE | 0x10 | 0x01 }))
    expect(Buffer.from(other.data).equals(Buffer.from(n15.data))).toBe(true)
    engine.closeAll()
  })
})
