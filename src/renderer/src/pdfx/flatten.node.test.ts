import { describe, expect, it } from 'vitest'
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'

import { buildPdf, type EditLayer } from './build'
import { alignedX, polylineSegments, type Attachment } from './flatten'
import { makePageKey, newOverlayId, type Geom, type Overlay } from '../edit/model'

// 1x1 transparent PNG.
const PNG_1x1 = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
    'base64'
  )
)

async function makeSourcePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([300, 300])
  return doc.save()
}

const geom = (over: Partial<Geom> = {}): Geom => ({
  x: 20,
  y: 20,
  w: 100,
  h: 40,
  rotation: 0,
  opacity: 1,
  ...over
})

function pageImageXObjectCount(doc: PDFDocument, pageIndex: number): number {
  const resources = doc.getPage(pageIndex).node.Resources()
  const xobj = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict)
  return xobj ? xobj.entries().length : 0
}

describe('pure helpers', () => {
  it('polylineSegments splits a flat polyline into consecutive segments', () => {
    expect(polylineSegments([0, 0, 1, 1, 2, 2])).toEqual([
      [0, 0, 1, 1],
      [1, 1, 2, 2]
    ])
    expect(polylineSegments([0, 0])).toEqual([]) // a single point has no segment
  })

  it('alignedX positions a line by alignment within a box', () => {
    expect(alignedX(100, 200, 50, 'left')).toBe(100)
    expect(alignedX(100, 200, 50, 'center')).toBe(175)
    expect(alignedX(100, 200, 50, 'right')).toBe(250)
  })
})

describe('flatten on export', () => {
  const base = (over: Partial<Overlay> & Pick<Overlay, 'type'>): Overlay =>
    ({
      id: newOverlayId(),
      pageKey: makePageKey('a', 0),
      z: 0,
      createdAt: 0,
      geom: geom(),
      ...over
    }) as Overlay

  function editLayer(): EditLayer {
    const overlays = new Map<string, Overlay[]>()
    overlays.set(makePageKey('a', 0), [
      base({ type: 'highlight', color: { r: 1, g: 0.9, b: 0.2 }, z: 0 }),
      base({ type: 'image', attachmentId: 'png1', mime: 'image/png', z: 1 }),
      base({
        type: 'ink',
        paths: [[10, 10, 50, 50, 80, 20]],
        strokeWidth: 2,
        color: { r: 0, g: 0, b: 0 },
        z: 2
      }),
      base({
        type: 'text',
        text: 'Approved\nA. Jara',
        fontSize: 12,
        color: { r: 0.1, g: 0.1, b: 0.1 },
        font: 'Helvetica',
        align: 'center',
        z: 3
      }),
      // redaction is handled by the external pre-pass, so the draw pass must skip it.
      base({ type: 'redaction', fill: { r: 0, g: 0, b: 0 }, z: 4 })
    ])
    const attachments = new Map<string, Attachment>([
      ['png1', { bytes: PNG_1x1, mime: 'image/png' }]
    ])
    return { overlays, attachments }
  }

  it('bakes overlays onto the targeted page only, and stays a valid multi-page PDF', async () => {
    const src = await makeSourcePdf(2)
    const pages = [
      { bytes: src, sourceKey: 'a', pageIndex: 0 },
      { bytes: src, sourceKey: 'a', pageIndex: 1 }
    ]
    const out = await buildPdf(pages, editLayer())
    const reloaded = await PDFDocument.load(out)

    expect(reloaded.getPageCount()).toBe(2)
    // The image overlay was on page 0 only.
    expect(pageImageXObjectCount(reloaded, 0)).toBeGreaterThan(0)
    expect(pageImageXObjectCount(reloaded, 1)).toBe(0)
  })

  it('produces a larger file with overlays than without (content was actually baked)', async () => {
    const src = await makeSourcePdf(2)
    const pages = [
      { bytes: src, sourceKey: 'a', pageIndex: 0 },
      { bytes: src, sourceKey: 'a', pageIndex: 1 }
    ]
    const plain = await buildPdf(pages)
    const withEdits = await buildPdf(pages, editLayer())
    expect(withEdits.length).toBeGreaterThan(plain.length)
  })

  it('applies per-page rotation from the edit layer on export', async () => {
    const src = await makeSourcePdf(2)
    const pages = [
      { bytes: src, sourceKey: 'a', pageIndex: 0 },
      { bytes: src, sourceKey: 'a', pageIndex: 1 }
    ]
    const rotations = new Map([[makePageKey('a', 0), 90]])
    const out = await buildPdf(pages, { overlays: new Map(), attachments: new Map(), rotations })
    const reloaded = await PDFDocument.load(out)
    expect(reloaded.getPage(0).getRotation().angle).toBe(90)
    expect(reloaded.getPage(1).getRotation().angle).toBe(0)
  })

  it('export without an edit layer is unchanged (no overlays, no throw)', async () => {
    const src = await makeSourcePdf(1)
    const out = await buildPdf([{ bytes: src, sourceKey: 'a', pageIndex: 0 }])
    const reloaded = await PDFDocument.load(out)
    expect(reloaded.getPageCount()).toBe(1)
    expect(pageImageXObjectCount(reloaded, 0)).toBe(0)
  })
})
