import { beforeEach, describe, expect, it, vi } from 'vitest'

import { applyExternalDrop } from './external-drop'
import { importIntoDocs } from '../pdfx/source'
import type { ImportedMirror } from '../pdfx/mirror'
import type { DocEntry, PageEntry } from '../types'
import type { IncomingFile } from './types'

vi.mock('../pdfx/source', () => ({
  importIntoDocs: vi.fn(),
  loadSource: vi.fn(),
  pagesFromSource: vi.fn()
}))
vi.mock('../pdfx/convert', () => ({ findConverter: vi.fn(() => null) }))

const page = (id: string): PageEntry => ({
  id,
  source: { id: `src-${id}`, bytes: new Uint8Array(), pdf: null as never },
  pageIndex: 0,
  width: 100,
  height: 100
})
const docEntry = (id: string): DocEntry => ({ id, name: id, pages: [page(id)] })
const mirror = (): ImportedMirror => ({
  overlays: [],
  rotations: [['k', 90]],
  crops: [],
  attachments: []
})
const file = (name: string): IncomingFile => ({ name, data: new Uint8Array([1]) })

// vi.fn() (Mock) is assignable to ExternalDropDeps' function fields; keep the inferred type so the
// mocks stay callable AND expose the matcher methods (.toHaveBeenCalledWith).
function makeDeps(existing: DocEntry[]) {
  return {
    docs: existing,
    addFiles: vi.fn(async () => {}),
    insertPagesIntoDoc: vi.fn(),
    spliceDocsAfter: vi.fn()
  }
}

beforeEach(() => vi.clearAllMocks())

describe('applyExternalDrop threads the .pdfx mirror instead of discarding it', () => {
  it('single .pdfx dropped INTO an existing doc inserts its pages AND returns the mirror', async () => {
    const m = mirror()
    vi.mocked(importIntoDocs).mockResolvedValue({
      docs: [docEntry('imported')],
      mirror: m,
      integrity: { tampered: false, changedPages: [] }
    })
    const deps = makeDeps([docEntry('existing')])
    const target = { kind: 'into', docId: 'existing', index: 0 } as const

    const result = await applyExternalDrop([file('saved.pdfx')], target, deps)

    expect(deps.insertPagesIntoDoc).toHaveBeenCalledWith('existing', 0, [
      expect.objectContaining({ id: 'imported' })
    ])
    expect(result).toEqual([{ mirror: m, integrity: { tampered: false, changedPages: [] } }])
  })

  it('a multi-doc .pdfx dropped INTO splices its docs and still returns the mirror', async () => {
    const m = mirror()
    vi.mocked(importIntoDocs).mockResolvedValue({
      docs: [docEntry('a'), docEntry('b')],
      mirror: m,
      integrity: { tampered: true, changedPages: [2] }
    })
    const deps = makeDeps([docEntry('existing')])
    const target = { kind: 'into', docId: 'existing', index: 0 } as const

    const result = await applyExternalDrop([file('saved.pdfx')], target, deps)

    expect(deps.spliceDocsAfter).toHaveBeenCalledWith('existing', [
      expect.objectContaining({ id: 'a' }),
      expect.objectContaining({ id: 'b' })
    ])
    expect(result[0].mirror).toBe(m)
    expect(result[0].integrity).toEqual({ tampered: true, changedPages: [2] })
  })

  it('dropping files as new docs returns one mirror entry per file', async () => {
    vi.mocked(importIntoDocs)
      .mockResolvedValueOnce({
        docs: [docEntry('a')],
        mirror: mirror(),
        integrity: { tampered: false, changedPages: [] }
      })
      .mockResolvedValueOnce({
        docs: [docEntry('b')],
        mirror: null,
        integrity: { tampered: false, changedPages: [] }
      })
    const deps = makeDeps([docEntry('existing')])
    const target = { kind: 'between', docIndex: 1 } as const

    const result = await applyExternalDrop([file('one.pdfx'), file('two.pdf')], target, deps)

    expect(deps.spliceDocsAfter).toHaveBeenCalledWith('existing', [
      expect.objectContaining({ id: 'a' }),
      expect.objectContaining({ id: 'b' })
    ])
    expect(result).toHaveLength(2)
    expect(result[0].mirror).not.toBeNull()
    expect(result[1].mirror).toBeNull()
  })
})
