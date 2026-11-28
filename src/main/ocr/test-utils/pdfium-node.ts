// Test-only: boot the real PDFium WASM in the test realm, and the fixtures the raster tests share.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { init } from '@embedpdf/pdfium'
import { PDFDict, PDFDocument, PDFName, PDFNumber, degrees, rgb } from 'pdf-lib'

import type { PdfiumRaster } from '../process/raster-core'
import type { PdfiumTriage } from '../process/triage-pdfium'

export const PDFIUM_WASM_PATH = fileURLToPath(
  new URL('../../../../node_modules/@embedpdf/pdfium/dist/pdfium.wasm', import.meta.url)
)

export type TestPdfium = PdfiumRaster &
  PdfiumTriage & {
    PDFiumExt_Init(): void
    FPDF_LoadMemDocument(ptr: number, size: number, password: string): number
  }

/** A fresh PDFium instance (each has its own heap), with every printErr line handed to `onErr`. */
export async function loadTestPdfium(
  onErr: (line: string) => void = () => {}
): Promise<TestPdfium> {
  const mod = (await init({
    wasmBinary: readFileSync(PDFIUM_WASM_PATH),
    print: () => {},
    printErr: (l: string) => onErr(l)
  } as unknown as Parameters<typeof init>[0])) as unknown as TestPdfium
  mod.PDFiumExt_Init()
  return mod
}

export interface FrameCase {
  name: string
  rotate?: number
  crop?: [number, number, number, number]
  media?: [number, number, number, number]
  /** /Rotate on the Pages root instead of the page (inherited). */
  inheritedRotate?: number
}

export const FRAME_CASES: FrameCase[] = [
  { name: '/Rotate 0' },
  { name: '/Rotate 90', rotate: 90 },
  { name: '/Rotate 180', rotate: 180 },
  { name: '/Rotate 270', rotate: 270 },
  { name: 'offset CropBox', crop: [100, 150, 400, 600] },
  { name: 'offset CropBox + /Rotate 90', crop: [100, 150, 400, 600], rotate: 90 },
  { name: 'offset CropBox + /Rotate 270', crop: [100, 150, 400, 600], rotate: 270 },
  { name: 'offset MediaBox', media: [-50, -60, 562, 732] },
  { name: 'inherited /Rotate 90', inheritedRotate: 90 },
  {
    name: 'inherited /Rotate 270 + offset CropBox',
    inheritedRotate: 270,
    crop: [100, 150, 400, 600]
  }
]

/** The asymmetric marks drawn on every frame page (user space, relative to the MediaBox origin). */
export const FRAME_MARKS = [
  { x: 110, y: 160, w: 60, h: 30 },
  { x: 300, y: 500, w: 20, h: 80 }
]

/** One page per case; an inherited /Rotate case gets its own document (the Pages root is shared). */
export async function frameFixture(c: FrameCase): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  if (c.media) page.node.set(PDFName.of('MediaBox'), doc.context.obj(c.media))
  const mb = c.media ?? [0, 0, 612, 792]
  for (const m of FRAME_MARKS)
    page.drawRectangle({
      x: mb[0] + m.x,
      y: mb[1] + m.y,
      width: m.w,
      height: m.h,
      color: rgb(0, 0, 0)
    })
  if (c.crop) page.node.set(PDFName.of('CropBox'), doc.context.obj(c.crop))
  if (c.rotate) page.setRotation(degrees(c.rotate))
  if (c.inheritedRotate) {
    const pages = doc.catalog.lookup(PDFName.of('Pages'), PDFDict)
    pages.set(PDFName.of('Rotate'), PDFNumber.of(c.inheritedRotate))
    page.node.delete(PDFName.of('Rotate'))
  }
  return doc.save()
}

/** A page whose only marking is a filled text-field widget (appearance stream, no page content). */
export async function widgetFixture(): Promise<{
  bytes: Uint8Array
  rect: { x: number; y: number; w: number; h: number }
}> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const rect = { x: 100, y: 600, w: 300, h: 60 }
  const field = doc.getForm().createTextField('signer.name')
  field.setText('WIDGET VALUE')
  field.addToPage(page, {
    x: rect.x,
    y: rect.y,
    width: rect.w,
    height: rect.h,
    borderWidth: 2,
    borderColor: rgb(0, 0, 0),
    textColor: rgb(0, 0, 0)
  })
  return { bytes: await doc.save(), rect }
}

/** Fraction-of-ink IoU between a grey raster (ink = v < 128) and a boolean mask. */
export function inkIoU(grey: Uint8Array, mask: Uint8Array): number {
  let inter = 0
  let union = 0
  for (let i = 0; i < grey.length; i++) {
    const a = grey[i] < 128
    const b = mask[i] === 1
    if (a && b) inter++
    if (a || b) union++
  }
  return union === 0 ? 1 : inter / union
}
