import { describe, expect, it } from 'vitest'
import { freshPageCopy, insertPastedPage } from './pages'
import { makePageKey } from '../../edit/model'
import type { DocEntry, PageEntry } from '../../types'

function page(sourceId: string, pageIndex: number): PageEntry {
  return {
    id: `p-${sourceId}-${pageIndex}`,
    source: { id: sourceId, bytes: new Uint8Array([1, 2, 3]), pdf: {} },
    pageIndex,
    width: 100,
    height: 100
  } as unknown as PageEntry
}

describe('freshPageCopy', () => {
  it('gives the copy a fresh page id AND source id → an independent pageKey', () => {
    const orig = page('src-A', 2)
    const copy = freshPageCopy(orig)
    expect(copy.id).not.toBe(orig.id)
    expect(copy.source.id).not.toBe(orig.source.id)
    // The edit key must differ, or edits/redactions leak between the copy and the original.
    expect(makePageKey(copy.source.id, copy.pageIndex)).not.toBe(
      makePageKey(orig.source.id, orig.pageIndex)
    )
    // Content is preserved (same bytes, index, size).
    expect(copy.source.bytes).toBe(orig.source.bytes)
    expect(copy.pageIndex).toBe(orig.pageIndex)
    expect([copy.width, copy.height]).toEqual([orig.width, orig.height])
  })
})

describe('insertPastedPage', () => {
  it('inserts the pasted page right after the selected page', () => {
    const docs: DocEntry[] = [{ id: 'd1', name: 'A', pages: [page('s1', 0), page('s2', 0)] }]
    const pasted = page('s3', 0)
    const out = insertPastedPage(docs, { docId: 'd1', pageId: 'p-s1-0' }, pasted)
    expect(out[0].pages.map((p) => p.source.id)).toEqual(['s1', 's3', 's2'])
  })

  it('leaves docs unchanged when the target page is not found', () => {
    const docs: DocEntry[] = [{ id: 'd1', name: 'A', pages: [page('s1', 0)] }]
    const out = insertPastedPage(docs, { docId: 'd1', pageId: 'nope' }, page('s3', 0))
    expect(out[0].pages.map((p) => p.source.id)).toEqual(['s1'])
  })
})
