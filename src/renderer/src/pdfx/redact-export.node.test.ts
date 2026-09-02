import { describe, expect, it, beforeAll } from 'vitest'
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import type { PDFDocumentProxy } from 'pdfjs-dist'

import { applyRedactedBytes, buildRedactedSources } from './redact-export'
import { makePageKey, type Overlay } from '../edit/model'
import type { EditLayer } from './build'
import type { DocEntry, PageEntry } from '../types'
import {
  extractText as extractTextWith,
  loadTestPdfium,
  makeTextPdf,
  type TextPdfium
} from '../test-utils/pdfium'

let pdfium: TextPdfium

beforeAll(async () => {
  pdfium = await loadTestPdfium()
})

const extractText = (bytes: Uint8Array): string => extractTextWith(pdfium, bytes)

// A one-page DocEntry whose source proxy reports a given /Rotate and view box (CropBox∩MediaBox
// in user space) — enough for the wiring under test.
function fakeDoc(
  bytes: Uint8Array,
  w: number,
  h: number,
  view: number[] = [0, 0, w, h],
  rotate = 0
): DocEntry {
  const source = {
    id: 's1',
    bytes,
    pdf: { getPage: async () => ({ rotate, view }) } as unknown as PDFDocumentProxy
  }
  const page: PageEntry = { id: 'p1', source, pageIndex: 0, width: w, height: h }
  return { id: 'd1', name: 'Doc', pages: [page] }
}

const redactionOverlay = (): Overlay => ({
  id: 'r1',
  pageKey: makePageKey('s1', 0),
  z: 0,
  createdAt: 0,
  geom: { x: 40, y: 693, w: 320, h: 28, rotation: 0, opacity: 1 },
  type: 'redaction',
  fill: { r: 0, g: 0, b: 0 }
})

describe('buildRedactedSources', () => {
  it('removes redacted content from the source bytes used on export', async () => {
    const bytes = await makeTextPdf()
    const editLayer: EditLayer = {
      overlays: new Map([[makePageKey('s1', 0), [redactionOverlay()]]]),
      attachments: new Map()
    }
    const redacted = await buildRedactedSources(editLayer, [fakeDoc(bytes, 400, 800)], pdfium)

    expect(redacted.has('s1')).toBe(true)
    const after = extractText(redacted.get('s1')!)
    expect(after).not.toContain('SECRET')
    expect(after).toContain('PUBLIC line one')
    expect(after).toContain('PUBLIC line three')

    // applyRedactedBytes swaps the redacted bytes in for that source.
    const swapped = applyRedactedBytes([{ sourceKey: 's1', bytes, pageIndex: 0 }], redacted)
    expect(swapped[0].bytes).toBe(redacted.get('s1'))
  })

  it('redacts the correct region on a page whose MediaBox origin is not (0,0)', async () => {
    // MediaBox [50,50,450,850]: text is in absolute user space; the editor box is view-relative.
    const doc = await PDFDocument.create()
    const page = doc.addPage()
    page.setMediaBox(50, 50, 400, 800)
    const font = await doc.embedFont(StandardFonts.Helvetica)
    page.drawText('PUBLIC up', { x: 100, y: 600, size: 18, font })
    page.drawText('SECRET-9X42', { x: 100, y: 400, size: 18, font })
    page.drawText('PUBLIC down', { x: 100, y: 200, size: 18, font })
    const bytes = await doc.save()

    // Box over SECRET in VIEW-relative coords (absolute y≈400 → view-relative y≈350).
    const redaction: Overlay = {
      ...redactionOverlay(),
      geom: { x: 20, y: 320, w: 360, h: 70, rotation: 0, opacity: 1 }
    }
    const editLayer: EditLayer = {
      overlays: new Map([[makePageKey('s1', 0), [redaction]]]),
      attachments: new Map()
    }
    const docs = [fakeDoc(bytes, 400, 800, [50, 50, 450, 850])]

    const redacted = await buildRedactedSources(editLayer, docs, pdfium)
    const after = extractText(redacted.get('s1')!)
    expect(after).not.toContain('SECRET') // origin offset applied → the right line is removed
    expect(after).toContain('PUBLIC up') // unaffected lines survive
    expect(after).toContain('PUBLIC down')
  })

  it('unrotates the box on an intrinsic-/Rotate-90 page with an offset view box', async () => {
    // Portrait 400×800 page (MediaBox [50,50,450,850]) stored with /Rotate 90 → pdf.js shows the
    // editor an 800×400 landscape page, so the redaction box is captured in that rotation-baked
    // space and must be mapped back exactly like the crop export does (see build.node.test.ts's
    // crop-rotation cases). Text is drawn in unrotated user space, which is what PDFium sees.
    const doc = await PDFDocument.create()
    const page = doc.addPage()
    page.setMediaBox(50, 50, 400, 800)
    page.setRotation(degrees(90))
    const font = await doc.embedFont(StandardFonts.Helvetica)
    page.drawText('PUBLIC up', { x: 100, y: 790, size: 18, font })
    page.drawText('SECRET-9X42', { x: 100, y: 750, size: 18, font })
    page.drawText('PUBLIC down', { x: 100, y: 600, size: 18, font })
    const bytes = await doc.save()

    // Visual {693,40,28,320} —unrotate(90, W=400, H=800)→ {40,693,320,28}, +view origin (50,50)
    // ⇒ absolute {90,743,320,28}, which is exactly the SECRET band and nothing else.
    const redaction: Overlay = {
      ...redactionOverlay(),
      geom: { x: 693, y: 40, w: 28, h: 320, rotation: 0, opacity: 1 }
    }
    const editLayer: EditLayer = {
      overlays: new Map([[makePageKey('s1', 0), [redaction]]]),
      attachments: new Map()
    }

    // Record the rect handed to the engine: redactPdf paints the black box with the very rect it
    // redacts, so intercepting FPDFPageObj_CreateNewRect observes it exactly.
    const painted: number[][] = []
    const spy = Object.create(pdfium) as TextPdfium
    spy.FPDFPageObj_CreateNewRect = (x, y, w, h) => {
      painted.push([x, y, w, h])
      return pdfium.FPDFPageObj_CreateNewRect(x, y, w, h)
    }

    const redacted = await buildRedactedSources(
      editLayer,
      [fakeDoc(bytes, 800, 400, [50, 50, 450, 850], 90)],
      spy
    )
    expect(painted).toEqual([[90, 743, 320, 28]]) // unrotated + offset by the view-box origin
    const after = extractText(redacted.get('s1')!)
    expect(after).not.toContain('SECRET')
    expect(after).toContain('PUBLIC up')
    expect(after).toContain('PUBLIC down')
  })

  it('returns an empty map when there are no redaction overlays', async () => {
    const bytes = await makeTextPdf()
    const editLayer: EditLayer = { overlays: new Map(), attachments: new Map() }
    const redacted = await buildRedactedSources(editLayer, [fakeDoc(bytes, 400, 800)], pdfium)
    expect(redacted.size).toBe(0)
    // and applyRedactedBytes is a no-op
    const pages = [{ sourceKey: 's1', bytes, pageIndex: 0 }]
    expect(applyRedactedBytes(pages, redacted)).toBe(pages)
  })
})
