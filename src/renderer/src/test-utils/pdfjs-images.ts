// Shared pdf.js image-decoding fixtures for the renderer's node tests (pdfjs-assets*). Test-only:
// it lives inside src/renderer/src so tsconfig.web.json type-checks it, and is excluded from
// coverage.
//
// Runs the real pdfjs-dist decoder in node. The legacy build is pdf.js's supported Node entry (the
// modern one needs DOMMatrix); its image-decoder and asset-loading code is the same one the app
// bundles. NOTE: pdf.js caches its wasm decoder modules in static fields for the life of the
// (in-process "fake") worker — a decoder that failed to initialise stays failed, one that loaded
// stays loaded — so a suite must not mix decodes with and without the asset options. Vitest
// isolates each test file, so keep such cases in separate files.

import { fileURLToPath } from 'node:url'
import { PDFDocument, PDFName } from 'pdf-lib'
import { getDocument, ImageKind, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
// Run pdf.js's worker in-process (its "fake worker": it picks up globalThis.pdfjsWorker).
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'

import type { PdfjsAssetOptions } from '../pdfx/pdfjs-assets'

/** node_modules/pdfjs-dist/ as a '/'-separated directory path ending in '/' (fs accepts '/'). */
export const PDFJS_DIST_DIR = fileURLToPath(
  new URL('../../../../node_modules/pdfjs-dist/', import.meta.url)
).replace(/\\/g, '/')

// 8 x 2 bi-level image, both rows = 4 white then 4 black pixels, hand-encoded as CCITT Group 4
// (K < 0): row 1 = horizontal mode 001 + white-run 4 (1011) + black-run 4 (011); row 2 = two
// vertical-0 codes (1 1) copying row 1; then EOFB (000000000001 x2), zero-padded to a byte.
const CCITT_G4 = Uint8Array.from([0x36, 0xf0, 0x01, 0x00, 0x10])
const CCITT_ROW = [255, 255, 255, 255, 0, 0, 0, 0]

// 8 x 8 greyscale JPEG 2000 codestream (lossless, written by OpenJPEG via Pillow): columns 0-3
// black, columns 4-7 white.
const JPX = Uint8Array.from(
  atob(
    '/0//UQApAAAAAAAIAAAACAAAAAAAAAAAAAAACAAAAAgAAAAAAAAAAAABBwEB/1IADAAAAAEAAwQEAAH/XAANQEBISFBISFBISFD/ZAAlAAFDcmVhdGVkIGJ5IE9wZW5KUEVHIHZlcnNpb24gMi41LjT/kAAKAAAAAAAnAAH/k8+0CAc/35gQBJPPwBQJQLM658faBgAXK7z/2Q=='
  ),
  (c) => c.charCodeAt(0)
)
const JPX_ROW = [0, 0, 0, 0, 255, 255, 255, 255]

/** One-page PDF that paints a single image XObject built from `data` + `dict` over the page. */
async function imagePdf(data: Uint8Array, dict: Record<string, unknown>): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([8, 8])
  const image = doc.context.register(
    doc.context.stream(data, { Type: 'XObject', Subtype: 'Image', ...dict } as never)
  )
  page.node.setXObject(PDFName.of('Im0'), image)
  page.node.addContentStream(doc.context.register(doc.context.stream('q 8 0 0 8 0 0 cm /Im0 Do Q')))
  return doc.save()
}

/** A PDF whose only image is CCITT G4 (decoded by jbig2.wasm), and the greyscale rows it holds. */
export async function ccittPdf(): Promise<{ pdf: Uint8Array; expected: number[][] }> {
  const pdf = await imagePdf(CCITT_G4, {
    Width: 8,
    Height: 2,
    ColorSpace: 'DeviceGray',
    BitsPerComponent: 1,
    Filter: 'CCITTFaxDecode',
    DecodeParms: { K: -1, Columns: 8, Rows: 2 }
  })
  return { pdf, expected: [CCITT_ROW, CCITT_ROW] }
}

/** A PDF whose only image is JPEG 2000 (decoded by openjpeg.wasm), and the rows it holds. */
export async function jpxPdf(): Promise<{ pdf: Uint8Array; expected: number[][] }> {
  const pdf = await imagePdf(JPX, { Width: 8, Height: 8, Filter: 'JPXDecode' })
  return { pdf, expected: Array.from({ length: 8 }, () => JPX_ROW) }
}

interface DecodedImage {
  width: number
  height: number
  kind: number
  data: Uint8Array | Uint8ClampedArray
}

/** Luminance (0 black .. 255 white) of pixel (x, y), whatever packing pdf.js chose. */
function grey(img: DecodedImage, x: number, y: number): number {
  switch (img.kind) {
    case ImageKind.GRAYSCALE_1BPP: {
      const rowBytes = (img.width + 7) >> 3
      return (img.data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0
    }
    case ImageKind.RGB_24BPP:
      return img.data[(y * img.width + x) * 3]
    case ImageKind.RGBA_32BPP:
      return img.data[(y * img.width + x) * 4]
    default:
      throw new Error(`unexpected image kind ${img.kind}`)
  }
}

/**
 * Decode page 1's (only) image XObject through pdf.js with `options` and return its greyscale
 * rows, or null when pdf.js could not decode it (it then drops the image: a blank page).
 */
export async function decodeImageRows(
  bytes: Uint8Array,
  options: Partial<PdfjsAssetOptions>
): Promise<number[][] | null> {
  const pdf = await getDocument({ data: bytes, verbosity: 0, ...options }).promise
  try {
    const page = await pdf.getPage(1)
    const ops = await page.getOperatorList()
    const at = ops.fnArray.indexOf(OPS.paintImageXObject)
    if (at < 0) return null
    const id = ops.argsArray[at][0] as string
    const img = await new Promise<DecodedImage | null>((resolve) => page.objs.get(id, resolve))
    if (!img) return null
    return Array.from({ length: img.height }, (_, y) =>
      Array.from({ length: img.width }, (_, x) => grey(img, x, y))
    )
  } finally {
    await pdf.destroy()
  }
}
