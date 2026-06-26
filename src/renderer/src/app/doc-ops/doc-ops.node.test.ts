import { describe, expect, it } from 'vitest'

import { dedupeNames, uniqueDocName } from '../names'
import { renameDoc, reorderDoc, spliceDocsAfter } from './docs'
import { movePageInto } from './move'
import type { DocEntry, PageEntry } from '../../types'
import type { PageRef } from '../types'

// PageEntry.source holds a pdfjs PDFDocumentProxy, which these structural reducers
// never touch — they only move PageEntry objects by reference and id. A cast keeps
// the fixtures minimal.
function page(id: string): PageEntry {
  return { id, source: {} as PageEntry['source'], pageIndex: 0, width: 100, height: 100 }
}

function doc(id: string, name: string, pageIds: string[]): DocEntry {
  return { id, name, pages: pageIds.map(page) }
}

describe('uniqueDocName', () => {
  it('returns the desired name when free', () => {
    expect(uniqueDocName('Doc', new Set())).toBe('Doc')
  })

  it('suffixes with an incrementing counter when taken', () => {
    expect(uniqueDocName('Doc', new Set(['Doc']))).toBe('Doc (2)')
    expect(uniqueDocName('Doc', new Set(['Doc', 'Doc (2)']))).toBe('Doc (3)')
  })
})

describe('dedupeNames', () => {
  it('renames only colliding incoming docs and preserves non-colliding ones by reference', () => {
    const existing = [doc('d1', 'A', ['p1'])]
    const a = doc('d2', 'A', ['p2'])
    const b = doc('d3', 'B', ['p3'])
    const result = dedupeNames(existing, [a, b])
    expect(result[0].name).toBe('A (2)')
    expect(result[1]).toBe(b) // untouched -> same reference
  })
})

describe('renameDoc', () => {
  it('renames a doc, avoiding collisions with other docs', () => {
    const docs = [doc('d1', 'A', ['p1']), doc('d2', 'B', ['p2'])]
    expect(renameDoc(docs, 'd2', 'A').find((d) => d.id === 'd2')!.name).toBe('A (2)')
  })
})

describe('reorderDoc', () => {
  it('swaps a doc with its neighbor in the given direction', () => {
    const docs = [doc('d1', 'A', ['p1']), doc('d2', 'B', ['p2'])]
    expect(reorderDoc(docs, 'd1', 1).map((d) => d.id)).toEqual(['d2', 'd1'])
  })

  it('is a no-op (same reference) at the boundary', () => {
    const docs = [doc('d1', 'A', ['p1']), doc('d2', 'B', ['p2'])]
    expect(reorderDoc(docs, 'd1', -1)).toBe(docs)
  })
})

describe('spliceDocsAfter', () => {
  it('inserts after the anchor doc and dedupes incoming names', () => {
    const docs = [doc('d1', 'A', ['p1']), doc('d2', 'B', ['p2'])]
    const result = spliceDocsAfter(docs, 'd1', [doc('d3', 'A', ['p3'])])
    expect(result.map((d) => d.id)).toEqual(['d1', 'd3', 'd2'])
    expect(result[1].name).toBe('A (2)')
  })

  it('inserts at the front when the anchor is null', () => {
    const docs = [doc('d1', 'A', ['p1'])]
    const result = spliceDocsAfter(docs, null, [doc('d2', 'B', ['p2'])])
    expect(result.map((d) => d.id)).toEqual(['d2', 'd1'])
  })
})

describe('movePageInto', () => {
  it('reorders a page within the same document', () => {
    const docs = [doc('d1', 'A', ['p1', 'p2', 'p3'])]
    const source: PageRef = { docId: 'd1', pageId: 'p3' }
    const result = movePageInto(docs, source, 'd1', 0)
    expect(result[0].pages.map((p) => p.id)).toEqual(['p3', 'p1', 'p2'])
  })

  it('moves a page across documents and drops a doc left empty', () => {
    const docs = [doc('d1', 'A', ['p1']), doc('d2', 'B', ['p2', 'p3'])]
    const source: PageRef = { docId: 'd1', pageId: 'p1' }
    const result = movePageInto(docs, source, 'd2', 1)
    expect(result.map((d) => d.id)).toEqual(['d2'])
    expect(result[0].pages.map((p) => p.id)).toEqual(['p2', 'p1', 'p3'])
  })
})
