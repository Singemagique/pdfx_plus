import { describe, expect, it } from 'vitest'
import { zoomIdentity } from 'd3-zoom'
import { computeRevealTransform } from './reveal-transform'

const VP = { w: 1000, h: 800 }
const M = { top: 120, bottom: 24, side: 24 }

describe('computeRevealTransform', () => {
  it('is null when the rect is already in view', () => {
    const t = zoomIdentity.translate(0, 0).scale(1)
    expect(computeRevealTransform(t, VP, { x: 100, y: 200, w: 200, h: 280 }, M)).toBeNull()
  })

  it('scrolls an off-screen rect to the middle of the visible area without panning sideways', () => {
    const t = zoomIdentity.translate(10, 20).scale(0.8)
    const rect = { x: 400, y: 3000, w: 216, h: 280 }
    const r = computeRevealTransform(t, VP, rect, M)!
    expect(r.k).toBeCloseTo(0.8)
    expect(r.x).toBe(t.x)
    expect(r.applyY(rect.y + rect.h / 2)).toBeCloseTo(M.top + (VP.h - M.top - M.bottom) / 2)
  })

  it('centres horizontally only when the rect is off to the side', () => {
    const t = zoomIdentity.translate(10, 20).scale(0.8)
    const rect = { x: 2000, y: 200, w: 216, h: 280 }
    const r = computeRevealTransform(t, VP, rect, M)!
    expect(r.y).toBe(t.y)
    expect(r.applyX(rect.x + rect.w / 2)).toBeCloseTo(VP.w / 2)
  })

  it('does not scroll past the top or the end of tall content', () => {
    // Scrolled down; the target is in the first row.
    const t = zoomIdentity.translate(0, -2000).scale(1)
    const top = computeRevealTransform(t, VP, { x: 0, y: 52, w: 216, h: 280 }, M, 5000)!
    expect(top.y).toBe(M.top)
    const end = computeRevealTransform(t, VP, { x: 0, y: 4700, w: 216, h: 280 }, M, 5000)!
    expect(end.y).toBeCloseTo(VP.h - M.bottom - 5000)
    // Without the content height, the page is simply centred.
    const free = computeRevealTransform(t, VP, { x: 0, y: 52, w: 216, h: 280 }, M)!
    expect(free.y).toBeGreaterThan(M.top)
  })

  it('treats a rect under the top margin as hidden', () => {
    const t = zoomIdentity
    expect(computeRevealTransform(t, VP, { x: 100, y: 50, w: 100, h: 100 }, M)).not.toBeNull()
  })

  it('zooms out — never in — when the rect is larger than the visible area', () => {
    const big = computeRevealTransform(
      zoomIdentity.scale(2),
      VP,
      { x: 0, y: 2000, w: 400, h: 1000 },
      M
    )!
    expect(big.k).toBeCloseTo((VP.h - M.top - M.bottom) / 1000)
    const small = computeRevealTransform(
      zoomIdentity.scale(0.3),
      VP,
      { x: 0, y: 9000, w: 216, h: 280 },
      M
    )!
    expect(small.k).toBeCloseTo(0.3)
  })
})
