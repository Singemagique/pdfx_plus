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

describe('serializeMirror drops overlays a redaction covers', () => {
  const key = makePageKey('s1', 0)
  const exportDocs: ExportDocument[] = [
    { name: 'A', pages: [{ bytes: new Uint8Array(), sourceKey: 's1', pageIndex: 0 }] }
  ]
  const base = { id: 'x', pageKey: key, z: 0, createdAt: 0 }
  const geom = (x: number, y: number, w: number, h: number): Overlay['geom'] => ({
    x,
    y,
    w,
    h,
    rotation: 0,
    opacity: 1
  })
  const redaction = (z: number, g = geom(0, 0, 100, 100)): Overlay => ({
    ...base,
    id: `red-${z}`,
    z,
    createdAt: z,
    geom: g,
    type: 'redaction',
    fill: { r: 0, g: 0, b: 0 }
  })
  const textAt = (z: number, text: string, g: Overlay['geom']): Overlay => ({
    ...base,
    id: `t-${z}`,
    z,
    createdAt: z,
    geom: g,
    type: 'text',
    text,
    fontSize: 12,
    color: { r: 0, g: 0, b: 0 },
    font: 'Helvetica',
    align: 'left'
  })
  const image = (z: number, attachmentId: string, g: Overlay['geom']): Overlay => ({
    ...base,
    id: `i-${z}`,
    z,
    createdAt: z,
    geom: g,
    type: 'image',
    attachmentId,
    mime: 'image/png'
  })
  const layer = (overlays: Overlay[], attachments = new Map()): EditLayer => ({
    overlays: new Map([[key, overlays]]),
    attachments,
    rotations: new Map(),
    crops: new Map()
  })

  it('never writes a covered overlay into the plaintext manifest, but keeps ones drawn above', () => {
    const mirror = serializeMirror(
      exportDocs,
      layer([
        textAt(0, 'SECRET-9X42', geom(10, 10, 50, 20)), // under the box
        redaction(1),
        textAt(2, 'VISIBLE-ON-TOP', geom(10, 10, 50, 20)) // painted over the box
      ])
    )
    const json = JSON.stringify(mirror)
    expect(json).not.toContain('SECRET-9X42') // would leak verbatim into pdfx-manifest.json
    expect(json).toContain('VISIBLE-ON-TOP') // WYSIWYG parity with flatten's z-order
    expect(mirror!.edits[0].overlays).toHaveLength(1)
  })

  it('drops an overlay the redaction only partially overlaps (fail-safe)', () => {
    const mirror = serializeMirror(
      exportDocs,
      layer([
        textAt(0, 'SECRET-9X42', geom(90, 90, 200, 200)), // one corner under the box
        redaction(1)
      ])
    )
    expect(JSON.stringify(mirror)).not.toContain('SECRET-9X42')
  })

  it('keeps an overlay that no redaction touches', () => {
    const mirror = serializeMirror(
      exportDocs,
      layer([textAt(0, 'ELSEWHERE', geom(300, 300, 50, 20)), redaction(1)])
    )
    expect(JSON.stringify(mirror)).toContain('ELSEWHERE')
  })

  it('does not embed the attachment of a redacted image overlay', () => {
    const attachments = new Map([
      ['hidden', { bytes: new Uint8Array([1, 2, 3, 4]), mime: 'image/png' }],
      ['kept', { bytes: new Uint8Array([5, 6, 7, 8]), mime: 'image/png' }]
    ])
    const mirror = serializeMirror(
      exportDocs,
      layer(
        [
          image(0, 'hidden', geom(10, 10, 50, 50)), // under the box
          redaction(1),
          image(2, 'kept', geom(10, 10, 50, 50)) // above it
        ],
        attachments
      )
    )
    expect(Object.keys(mirror!.attachments)).toEqual(['kept'])
    const json = JSON.stringify(mirror)
    expect(json).not.toContain('hidden')
    expect(json).not.toContain(toBase64(new Uint8Array([1, 2, 3, 4]))) // no redacted image bytes
  })

  it('treats an exact z + createdAt tie as covered (the draw order is a coin flip)', () => {
    // `z` is handed out as pageOverlays.length, so a delete makes the next overlay reuse a value —
    // an exact tie is reachable, and the sort leaves the two in an arbitrary order.
    const tied = serializeMirror(
      exportDocs,
      layer([{ ...textAt(1, 'SECRET-9X42', geom(10, 10, 50, 20)), createdAt: 5 }, { ...redaction(1), createdAt: 5 }]) // prettier-ignore
    )
    expect(JSON.stringify(tied)).not.toContain('SECRET-9X42')

    // But a redaction that is unambiguously EARLIER at the same z still leaves the overlay alone.
    const earlier = serializeMirror(
      exportDocs,
      layer([{ ...textAt(1, 'ON-TOP', geom(10, 10, 50, 20)), createdAt: 5 }, { ...redaction(1), createdAt: 4 }]) // prettier-ignore
    )
    expect(JSON.stringify(earlier)).toContain('ON-TOP')
  })

  it('uses the ROTATED footprint of a redaction, not just its unrotated box', () => {
    // A 200×20 bar rotated 90° about its (100,100) origin sweeps up to (80..100, 100..300) —
    // nowhere near the (100..300, 100..120) its unrotated box claims. Only a hand-edited .pdfx can
    // carry a rotated redaction, so this is the crafted-input path.
    const rotated = redaction(1, { ...geom(100, 100, 200, 20), rotation: 90 })
    const covered = textAt(0, 'SECRET-9X42', geom(85, 200, 10, 10)) // inside the swept area only

    expect(JSON.stringify(serializeMirror(exportDocs, layer([covered, rotated])))).not.toContain(
      'SECRET-9X42'
    )
    // Control: with rotation 0 the same box misses the overlay entirely, so it is kept.
    const unrotated = redaction(1, geom(100, 100, 200, 20))
    expect(JSON.stringify(serializeMirror(exportDocs, layer([covered, unrotated])))).toContain(
      'SECRET-9X42'
    )
  })

  it('uses the ROTATED footprint of the covered overlay too', () => {
    // A tall box at x=150 that is rotated flat across the page and into the redaction at (0,0).
    const swung = textAt(0, 'SECRET-9X42', { ...geom(150, 50, 10, 200), rotation: 90 })
    expect(JSON.stringify(serializeMirror(exportDocs, layer([swung, redaction(1)])))).not.toContain(
      'SECRET-9X42'
    )
    // Control: unrotated, that box is far to the right of the redaction and survives.
    const upright = textAt(0, 'SECRET-9X42', geom(150, 50, 10, 200))
    expect(JSON.stringify(serializeMirror(exportDocs, layer([upright, redaction(1)])))).toContain(
      'SECRET-9X42'
    )
  })

  it('does not mirror the redaction overlays themselves', () => {
    const mirror = serializeMirror(exportDocs, layer([textAt(2, 'TOP', geom(10, 10, 5, 5)), redaction(1)])) // prettier-ignore
    expect(mirror!.edits[0].overlays!.every((o) => o.type !== 'redaction')).toBe(true)
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

// A hostile manifest must never take down the whole document load — pages included.
describe('mirror import hardening (hostile manifest shapes)', () => {
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
  const manifest = (m: object): PdfxManifest =>
    ({ pdfx: '1.1', documents: [{ name: 'A', pages: 1 }], ...m }) as unknown as PdfxManifest

  it('treats a truthy non-array `edits` as absent instead of throwing', () => {
    for (const edits of [5, true, { length: 2 }, 'edits']) {
      expect(() => deserializeMirror(manifest({ edits }), freshPage())).not.toThrow()
      expect(deserializeMirror(manifest({ edits }), freshPage())).toBeNull()
    }
  })

  it('ignores a non-array `overlays` on an edit entry', () => {
    const m = manifest({ edits: [{ doc: 0, page: 0, rotation: 90, overlays: { length: 1 } }] })
    const imported = deserializeMirror(m, freshPage())!
    expect(imported.overlays).toEqual([])
    expect(imported.rotations).toEqual([[makePageKey('newsrc', 0), 90]]) // the rest still loads
  })

  it('skips malformed attachments instead of failing the load', () => {
    const m = manifest({
      edits: [{ doc: 0, page: 0, rotation: 90 }],
      attachments: {
        notBase64: { mime: 'image/png', data: '!!!' },
        noData: { mime: 'image/png' },
        nonStringData: { mime: 'image/png', data: 42 },
        noMime: { data: toBase64(new Uint8Array([1])) },
        nul: null,
        ok: { mime: 'image/png', data: toBase64(new Uint8Array([1, 2, 3])) }
      }
    })
    expect(() => deserializeMirror(m, freshPage())).not.toThrow()
    const imported = deserializeMirror(m, freshPage())!
    expect(imported.attachments.map(([id]) => id)).toEqual(['ok'])
    expect(Array.from(imported.attachments[0][1].bytes)).toEqual([1, 2, 3])
  })

  it('tolerates a non-object attachments container', () => {
    for (const attachments of ['nope', 7, true]) {
      const m = manifest({ edits: [{ doc: 0, page: 0, rotation: 90 }], attachments })
      expect(deserializeMirror(m, freshPage())!.attachments).toEqual([])
    }
  })
})

// Geometry alone isn't enough: a malformed per-type payload imports fine and then throws inside
// pdf-lib on EVERY export, so the document can never be exported again.
describe('mirror import validation (per-type payloads)', () => {
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
  const G = { x: 10, y: 20, w: 30, h: 40, rotation: 0, opacity: 1 }
  const importOverlays = (overlays: object[], attachments: object = {}): Overlay[] =>
    deserializeMirror(
      {
        pdfx: '1.1',
        documents: [{ name: 'A', pages: 1 }],
        edits: [{ doc: 0, page: 0, overlays }],
        attachments
      } as unknown as PdfxManifest,
      freshPage()
    )!.overlays
  const base = { id: 'x', pageKey: 'k', z: 0, createdAt: 0, geom: G }
  const PNG = { mime: 'image/png', data: toBase64(new Uint8Array([1, 2, 3])) }

  const valid: Record<string, object> = {
    highlight: { ...base, type: 'highlight', color: { r: 1, g: 1, b: 0 } },
    ink: {
      ...base,
      type: 'ink',
      paths: [[0, 0, 1, 1]],
      strokeWidth: 2,
      color: { r: 0, g: 0, b: 0 }
    },
    text: { ...base, type: 'text', text: 'hi', fontSize: 12, color: { r: 0, g: 0, b: 0 }, font: 'Helvetica', align: 'left' }, // prettier-ignore
    shape: { ...base, type: 'shape', shape: 'rect', strokeWidth: 1, color: { r: 0, g: 0, b: 0 } },
    image: { ...base, type: 'image', attachmentId: 'a1', mime: 'image/png' },
    signatureVisual: { ...base, type: 'signatureVisual', paths: [[0, 0, 1, 1]] },
    formValue: { ...base, type: 'formValue', field: 'name', value: 'Ada' }
  }

  it('keeps a well-formed overlay of every drawable type', () => {
    const imported = importOverlays(Object.values(valid), { a1: PNG })
    expect(imported.map((o) => o.type).sort()).toEqual(Object.keys(valid).sort())
  })

  it('drops a highlight whose color is not an RGB object', () => {
    expect(importOverlays([{ ...valid.highlight, color: null }])).toHaveLength(0)
    expect(importOverlays([{ ...valid.highlight, color: { r: 1, g: NaN, b: 0 } }])).toHaveLength(0)
  })

  it('drops ink without usable paths or stroke width', () => {
    expect(importOverlays([{ ...valid.ink, paths: undefined }])).toHaveLength(0)
    expect(importOverlays([{ ...valid.ink, paths: [['a']] }])).toHaveLength(0)
    expect(importOverlays([{ ...valid.ink, strokeWidth: 'thick' }])).toHaveLength(0)
  })

  it('drops text with a bad font, align, size or body', () => {
    expect(importOverlays([{ ...valid.text, font: 'Comic' }])).toHaveLength(0)
    expect(importOverlays([{ ...valid.text, align: 'justify' }])).toHaveLength(0)
    expect(importOverlays([{ ...valid.text, fontSize: null }])).toHaveLength(0)
    expect(importOverlays([{ ...valid.text, text: 42 }])).toHaveLength(0)
  })

  it('drops a shape of unknown kind or with non-finite stroke width', () => {
    expect(importOverlays([{ ...valid.shape, shape: 'spiral' }])).toHaveLength(0)
    expect(importOverlays([{ ...valid.shape, strokeWidth: Infinity }])).toHaveLength(0)
  })

  it('drops an image overlay whose attachment is missing or failed to decode', () => {
    expect(importOverlays([valid.image], {})).toHaveLength(0) // no such attachment
    expect(importOverlays([valid.image], { a1: { mime: 'image/png', data: '!!!' } })).toHaveLength(
      0
    )
    expect(importOverlays([{ ...valid.image, attachmentId: 7 }], { a1: PNG })).toHaveLength(0)
    expect(importOverlays([valid.image], { a1: PNG })).toHaveLength(1) // resolvable → kept
  })

  it('drops a signatureVisual with neither a resolvable attachment nor valid paths', () => {
    expect(importOverlays([{ ...base, type: 'signatureVisual' }])).toHaveLength(0)
    expect(
      importOverlays([{ ...base, type: 'signatureVisual', attachmentId: 'missing' }], { a1: PNG })
    ).toHaveLength(0)
    expect(
      importOverlays([{ ...base, type: 'signatureVisual', attachmentId: 'a1' }], { a1: PNG })
    ).toHaveLength(1)
  })

  it('drops a formValue with a non-string field or a non-primitive value', () => {
    expect(importOverlays([{ ...valid.formValue, field: null }])).toHaveLength(0)
    expect(importOverlays([{ ...valid.formValue, value: { a: 1 } }])).toHaveLength(0)
    expect(importOverlays([{ ...valid.formValue, value: true }])).toHaveLength(1) // checkbox
  })
})
