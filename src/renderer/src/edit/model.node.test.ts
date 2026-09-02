import { describe, expect, it } from 'vitest'

import {
  cssColor,
  groupByPage,
  makePageKey,
  newOverlayId,
  nextZ,
  overlaysForPage,
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
  it('is injective in both components, so no two pages can share a key', () => {
    expect(makePageKey('doc', 4)).toBe('doc#4')
    expect(makePageKey('doc', 4)).not.toBe(makePageKey('doc', 40))
    expect(makePageKey('doc', 4)).not.toBe(makePageKey('other', 4))
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

describe('nextZ', () => {
  it('counts only the target page, so new content lands on top of that page alone', () => {
    const overlays = [img('k1', 0), img('k2', 0), img('k2', 1), img('k1', 1)]
    expect(nextZ(overlays, 'k1')).toBe(2)
    expect(nextZ(overlays, 'k2')).toBe(2)
    expect(nextZ(overlays, 'untouched')).toBe(0)
  })

  it('is strictly above every existing z on the page', () => {
    const overlays = [img('k1', 0), img('k1', 1), img('k1', 2)]
    const z = nextZ(overlays, 'k1')
    expect(overlays.every((o) => o.z < z)).toBe(true)
  })
})

describe('cssColor', () => {
  it('maps 0..1 channels onto rounded 0..255 rgb()', () => {
    expect(cssColor({ r: 0, g: 0, b: 0 })).toBe('rgb(0, 0, 0)')
    expect(cssColor({ r: 1, g: 1, b: 1 })).toBe('rgb(255, 255, 255)')
    expect(cssColor({ r: 0.85, g: 0.15, b: 0.18 })).toBe('rgb(217, 38, 46)')
  })
})
