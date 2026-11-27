import { describe, expect, it } from 'vitest'
import { findImportedDoc } from './imported-doc'
import { movePageToNewDoc } from '../app/doc-ops/move'
import { doc } from './test-utils/layout-fixtures'

const a = doc('a', 3)
const b = doc('b', 2)
const c = doc('c', 1)

describe('findImportedDoc', () => {
  it('returns the first new document in collection order', () => {
    expect(findImportedDoc([a], [a, b, c])).toBe('b')
    expect(findImportedDoc([a], [c, a, b])).toBe('c')
    expect(findImportedDoc([], [a])).toBe('a')
  })

  it('ignores reorders, deletes, renames and page edits', () => {
    expect(findImportedDoc([a, b], [b, a])).toBeNull()
    expect(findImportedDoc([a, b], [a])).toBeNull()
    expect(findImportedDoc([a], [{ ...a, name: 'renamed.pdf' }])).toBeNull()
    expect(findImportedDoc([a], [{ ...a, pages: a.pages.slice(1) }])).toBeNull()
  })

  it('does not treat a page dragged out into a new document as an import', () => {
    const moved = movePageToNewDoc([a, b], { docId: 'a', pageId: 'a-p1' }, 1, 'fresh')
    expect(moved.map((d) => d.id)).toEqual(['a', 'fresh', 'b'])
    expect(findImportedDoc([a, b], moved)).toBeNull()
  })
})
