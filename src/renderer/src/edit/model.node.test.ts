import { describe, expect, it } from 'vitest'

import {
  groupByPage,
  isDrawable,
  makePageKey,
  newOverlayId,
  overlaysForPage,
  parsePageKey,
  remapDuplicatedPage,
  type Overlay
} from './model'

function img(pageKey: string, z = 0, createdAt = 0): Overlay {
  return {
    id: newOverlayId(),
    pageKey,
    z,
    createdAt,
    geom: { x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 },
    type: 'image',
    attachmentId: 'a',
    mime: 'image/png'
  }
}

describe('page keys', () => {
  it('round-trips sourceKey + pageIndex, even when the source key contains separators', () => {
    const key = makePageKey('doc#weird:key', 4)
    expect(parsePageKey(key)).toEqual({ sourceKey: 'doc#weird:key', pageIndex: 4 })
  })
})

describe('newOverlayId', () => {
  it('returns distinct ids', () => {
    expect(newOverlayId()).not.toBe(newOverlayId())
  })
})

describe('overlaysForPage', () => {
  it('filters to the page and sorts by z then createdAt', () => {
    const overlays = [
      img('k1', 2, 0),
      img('k2', 0, 0),
      img('k1', 1, 0),
      img('k1', 1, 5) // same z as the previous k1 entry, later createdAt
    ]
    const k1 = overlaysForPage(overlays, 'k1')
    expect(k1.map((o) => [o.z, o.createdAt])).toEqual([
      [1, 0],
      [1, 5],
      [2, 0]
    ])
  })
})

describe('groupByPage', () => {
  it('buckets overlays by page key, each list in draw order', () => {
    const grouped = groupByPage([img('k1', 3), img('k2', 0), img('k1', 1)])
    expect([...grouped.keys()].sort()).toEqual(['k1', 'k2'])
    expect(grouped.get('k1')!.map((o) => o.z)).toEqual([1, 3])
    expect(grouped.get('k2')!.length).toBe(1)
  })
})

describe('remapDuplicatedPage', () => {
  it('copies a page’s overlays onto a new key with fresh ids and no shared references', () => {
    const original = [img('src', 0), img('src', 1), img('other', 0)]
    const copies = remapDuplicatedPage(original, 'src', 'dup')
    expect(copies).toHaveLength(2)
    expect(copies.every((o) => o.pageKey === 'dup')).toBe(true)
    // Fresh ids — editing the copy can never alias the original.
    const originalIds = new Set(original.map((o) => o.id))
    expect(copies.some((o) => originalIds.has(o.id))).toBe(false)
  })
})

describe('isDrawable', () => {
  it('marks draw-pass types but excludes redaction and form values', () => {
    expect(isDrawable(img('k'))).toBe(true)
    const redaction: Overlay = {
      id: newOverlayId(),
      pageKey: 'k',
      z: 0,
      createdAt: 0,
      geom: { x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1 },
      type: 'redaction',
      fill: { r: 0, g: 0, b: 0 }
    }
    expect(isDrawable(redaction)).toBe(false)
  })
})
