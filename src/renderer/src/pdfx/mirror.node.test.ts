import { describe, expect, it } from 'vitest'

import { deserializeMirror, fromBase64, serializeMirror, toBase64 } from './mirror'
import { makePageKey, type Overlay } from '../edit/model'
import type { EditLayer } from './build'
import type { ExportDocument, PdfxManifest } from './format'
import type { DocEntry, PageEntry } from '../types'

const highlight = (pageKey: string): Overlay => ({
  id: 'o1',
  pageKey,
  z: 0,
  createdAt: 0,
  geom: { x: 10, y: 20, w: 30, h: 40, rotation: 0, opacity: 0.4 },
  type: 'highlight',
  color: { r: 1, g: 0.9, b: 0.2 }
})

describe('base64', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 137, 80, 78])
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes))
  })
})

describe('mirror round-trip', () => {
  it('serializes overlays + rotation by doc/page, then rebinds to freshly-loaded page keys', () => {
    const exportDocs: ExportDocument[] = [
      { name: 'A', pages: [{ bytes: new Uint8Array(), sourceKey: 's1', pageIndex: 0 }] }
    ]
    const editLayer: EditLayer = {
      overlays: new Map([[makePageKey('s1', 0), [highlight(makePageKey('s1', 0))]]]),
      attachments: new Map(),
      rotations: new Map([[makePageKey('s1', 0), 90]]),
      crops: new Map([[makePageKey('s1', 0), { x: 5, y: 6, w: 70, h: 80 }]])
    }

    const mirror = serializeMirror(exportDocs, editLayer)
    expect(mirror).not.toBeNull()
    expect(mirror!.edits).toEqual([
      expect.objectContaining({ doc: 0, page: 0, rotation: 90, crop: { x: 5, y: 6, w: 70, h: 80 } })
    ])

    // Rebuild the manifest as it would be embedded, then import into a fresh source.
    const manifest: PdfxManifest = {
      pdfx: '1.1',
      documents: [{ name: 'A', pages: 1 }],
      edits: mirror!.edits,
      attachments: mirror!.attachments
    }
    const page: PageEntry = {
      id: 'p1',
      source: { id: 'newsrc', bytes: new Uint8Array(), pdf: null as never },
      pageIndex: 0,
      width: 100,
      height: 200
    }
    const docs: DocEntry[] = [{ id: 'd1', name: 'A', pages: [page] }]

    const imported = deserializeMirror(manifest, docs)
    const newKey = makePageKey('newsrc', 0)
    expect(imported!.overlays).toHaveLength(1)
    expect(imported!.overlays[0].pageKey).toBe(newKey) // rebound to the new page identity
    expect(imported!.overlays[0].type).toBe('highlight')
    expect(imported!.rotations).toEqual([[newKey, 90]])
    expect(imported!.crops).toEqual([[newKey, { x: 5, y: 6, w: 70, h: 80 }]]) // crop rebinds too
  })

  it('round-trips a filled radio form value (value + control + chosen-option geom)', () => {
    const key = makePageKey('s1', 0)
    const radio: Overlay = {
      id: 'r1',
      pageKey: key,
      z: 0,
      createdAt: 0,
      geom: { x: 200, y: 620, w: 16, h: 16, rotation: 0, opacity: 1 },
      type: 'formValue',
      field: 'plan',
      value: '1',
      control: 'radio'
    }
    const editLayer: EditLayer = {
      overlays: new Map([[key, [radio]]]),
      attachments: new Map(),
      rotations: new Map(),
      crops: new Map()
    }
    const mirror = serializeMirror(
      [{ name: 'A', pages: [{ bytes: new Uint8Array(), sourceKey: 's1', pageIndex: 0 }] }],
      editLayer
    )
    const manifest: PdfxManifest = {
      pdfx: '1.1',
      documents: [{ name: 'A', pages: 1 }],
      edits: mirror!.edits,
      attachments: mirror!.attachments
    }
    const page: PageEntry = {
      id: 'p1',
      source: { id: 'newsrc', bytes: new Uint8Array(), pdf: null as never },
      pageIndex: 0,
      width: 612,
      height: 792
    }
    const imported = deserializeMirror(manifest, [{ id: 'd1', name: 'A', pages: [page] }])
    const o = imported!.overlays[0]
    expect(o.type).toBe('formValue')
    expect(o).toMatchObject({ field: 'plan', value: '1', control: 'radio' })
    expect(o.geom).toMatchObject({ x: 200, y: 620, w: 16, h: 16 })
  })

  it('returns null when there are no edits', () => {
    const docs: ExportDocument[] = [
      { name: 'A', pages: [{ bytes: new Uint8Array(), sourceKey: 's1', pageIndex: 0 }] }
    ]
    expect(
      serializeMirror(docs, { overlays: new Map(), attachments: new Map(), rotations: new Map() })
    ).toBeNull()
  })
})

describe('mirror import validation (crafted/corrupt .pdfx)', () => {
  const freshPage = (): DocEntry[] => [
    {
      id: 'd1',
      name: 'A',
      pages: [
        {
          id: 'p1',
          source: { id: 'newsrc', bytes: new Uint8Array(), pdf: null as never },
          pageIndex: 0,
          width: 612,
          height: 792
        }
      ]
    }
  ]
  const manifestWith = (edit: object): PdfxManifest =>
    ({
      pdfx: '1.1',
      documents: [{ name: 'A', pages: 1 }],
      edits: [{ doc: 0, page: 0, ...edit }],
      attachments: []
    }) as unknown as PdfxManifest

  it('drops overlays with non-finite geometry', () => {
    const bad = {
      id: 'x',
      pageKey: 'k',
      z: 0,
      createdAt: 0,
      type: 'highlight',
      color: { r: 1, g: 1, b: 0 },
      geom: { x: Infinity, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 }
    }
    const imported = deserializeMirror(manifestWith({ overlays: [bad] }), freshPage())
    expect(imported!.overlays).toHaveLength(0)
  })

  it('rejects injected redaction overlays (would destroy content on re-export)', () => {
    const redaction = {
      id: 'r',
      pageKey: 'k',
      z: 0,
      createdAt: 0,
      type: 'redaction',
      fill: { r: 0, g: 0, b: 0 },
      geom: { x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1 }
    }
    const imported = deserializeMirror(manifestWith({ overlays: [redaction] }), freshPage())
    expect(imported!.overlays).toHaveLength(0)
  })

  it('drops overlays of unknown type', () => {
    const evil = {
      id: 'e',
      pageKey: 'k',
      z: 0,
      createdAt: 0,
      type: 'exec',
      geom: { x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 }
    }
    const imported = deserializeMirror(manifestWith({ overlays: [evil] }), freshPage())
    expect(imported!.overlays).toHaveLength(0)
  })

  it('rejects non-quarter rotations and keeps 90/180/270', () => {
    expect(deserializeMirror(manifestWith({ rotation: 45 }), freshPage())!.rotations).toEqual([])
    expect(deserializeMirror(manifestWith({ rotation: Infinity }), freshPage())!.rotations).toEqual(
      []
    )
    const ok = deserializeMirror(manifestWith({ rotation: 180 }), freshPage())!
    expect(ok.rotations).toEqual([[makePageKey('newsrc', 0), 180]])
  })

  it('rejects crops with non-finite or non-positive dimensions', () => {
    expect(
      deserializeMirror(manifestWith({ crop: { x: 0, y: 0, w: Infinity, h: 10 } }), freshPage())!
        .crops
    ).toEqual([])
    expect(
      deserializeMirror(manifestWith({ crop: { x: 0, y: 0, w: 0, h: 10 } }), freshPage())!.crops
    ).toEqual([])
    const ok = deserializeMirror(
      manifestWith({ crop: { x: 1, y: 2, w: 30, h: 40 } }),
      freshPage()
    )!.crops
    expect(ok).toEqual([[makePageKey('newsrc', 0), { x: 1, y: 2, w: 30, h: 40 }]])
  })

  it('keeps valid overlays alongside rejected ones', () => {
    const good = {
      id: 'g',
      pageKey: 'k',
      z: 0,
      createdAt: 0,
      type: 'highlight',
      color: { r: 1, g: 1, b: 0 },
      geom: { x: 10, y: 20, w: 30, h: 40, rotation: 0, opacity: 0.4 }
    }
    const bad = { ...good, id: 'b', geom: { ...good.geom, w: NaN } }
    const imported = deserializeMirror(manifestWith({ overlays: [good, bad] }), freshPage())
    expect(imported!.overlays).toHaveLength(1)
    expect(imported!.overlays[0].type).toBe('highlight')
  })
})
