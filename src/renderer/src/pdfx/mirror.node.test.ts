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

  it('returns null when there are no edits', () => {
    const docs: ExportDocument[] = [
      { name: 'A', pages: [{ bytes: new Uint8Array(), sourceKey: 's1', pageIndex: 0 }] }
    ]
    expect(
      serializeMirror(docs, { overlays: new Map(), attachments: new Map(), rotations: new Map() })
    ).toBeNull()
  })
})
