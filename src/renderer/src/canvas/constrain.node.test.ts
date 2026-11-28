import { describe, expect, it } from 'vitest'
import { zoomIdentity, type ZoomTransform } from 'd3-zoom'
import {
  boundTransform,
  boundToViewport,
  panConstrain,
  PAN_BOUNDS,
  type Extent,
  type PanBounds
} from './constrain'
import { computeFitTransform } from './fit-transform'
import { computeRevealTransform } from './reveal-transform'
import {
  MAX_SCALE,
  MIN_SCALE,
  PAN_BOTTOM_MARGIN,
  PAN_SIDE_MARGIN,
  PAN_TOP_MARGIN
} from './zoom-constants'

const W = 1400
const H = 900
const VIEW: Extent = [
  [0, 0],
  [W, H]
]
const box = (w: number, h: number): Extent => [
  [0, 0],
  [w, h]
]
const at = (x: number, y: number, k: number): ZoomTransform => zoomIdentity.translate(x, y).scale(k)

/** The content's on-screen edges under `t`. */
const edges = (t: ZoomTransform, c: Extent) => ({
  left: t.applyX(c[0][0]),
  right: t.applyX(c[1][0]),
  top: t.applyY(c[0][1]),
  bottom: t.applyY(c[1][1])
})

/** True when `t` satisfies the bounds for content box `c` in the 1400×900 view. */
function inBounds(t: ZoomTransform, c: Extent, eps = 1e-6): boolean {
  const e = edges(t, c)
  const x0 = PAN_SIDE_MARGIN
  const x1 = W - PAN_SIDE_MARGIN
  const y0 = PAN_TOP_MARGIN
  const y1 = H - PAN_BOTTOM_MARGIN
  const okX =
    e.right - e.left >= x1 - x0
      ? e.left <= x0 + eps && e.right >= x1 - eps
      : e.left >= x0 - eps && e.right <= x1 + eps
  const okY =
    e.bottom - e.top >= y1 - y0
      ? e.top <= y0 + eps && e.bottom >= y1 - eps
      : e.top >= y0 - eps && e.bottom <= y1 + eps
  return okX && okY
}

const TALL = box(1200, 6000)
const SHORT = box(800, 300)
const WIDE = box(9000, 346)
const SCALES = [MIN_SCALE, 0.1, 0.5, 1, 2, 7, MAX_SCALE]

describe('boundTransform', () => {
  it('uses the toolbar, bottom and side margins as its padding', () => {
    expect(PAN_BOUNDS).toEqual({ top: 72, bottom: 24, side: 24, topReach: 72, overhang: 0 })
  })

  it('leaves an in-bounds transform untouched (the same object)', () => {
    const t = at(100, -1000, 1)
    expect(boundTransform(t, VIEW, TALL)).toBe(t)
  })

  it('stops tall content with its top at the top margin and its end at the bottom margin', () => {
    const top = boundTransform(at(100, 5000, 1), VIEW, TALL)
    expect(top.y).toBe(PAN_TOP_MARGIN)
    const end = boundTransform(at(100, -50000, 1), VIEW, TALL)
    expect(end.y).toBe(H - PAN_BOTTOM_MARGIN - 6000)
  })

  it('keeps content shorter than the window inside it without centring it', () => {
    // Anywhere inside is fine and is kept as is…
    const inside = at(300, 400, 1)
    expect(boundTransform(inside, VIEW, SHORT)).toBe(inside)
    // …but it can't be pushed past either end of the window.
    expect(boundTransform(at(300, -5000, 1), VIEW, SHORT).y).toBe(PAN_TOP_MARGIN)
    expect(boundTransform(at(300, 5000, 1), VIEW, SHORT).y).toBe(H - PAN_BOTTOM_MARGIN - 300)
    expect(boundTransform(at(-5000, 400, 1), VIEW, SHORT).x).toBe(PAN_SIDE_MARGIN)
    expect(boundTransform(at(5000, 400, 1), VIEW, SHORT).x).toBe(W - PAN_SIDE_MARGIN - 800)
  })

  it('pans wider content until an edge reaches the side padding', () => {
    expect(boundTransform(at(5000, 300, 1), VIEW, WIDE).x).toBe(PAN_SIDE_MARGIN)
    expect(boundTransform(at(-50000, 300, 1), VIEW, WIDE).x).toBe(W - PAN_SIDE_MARGIN - 9000)
    // Its single short row stays inside vertically.
    expect(inBounds(boundTransform(at(-50000, -9000, 1), VIEW, WIDE), WIDE)).toBe(true)
  })

  it.each(SCALES)('pulls extreme transforms back into bounds at k=%f, keeping the scale', (k) => {
    for (const c of [TALL, SHORT, WIDE]) {
      for (const x of [-1e7, -3000, 0, 500, 1e7]) {
        for (const y of [-1e7, -3000, 0, 500, 1e7]) {
          const b = boundTransform(at(x, y, k), VIEW, c)
          expect(b.k).toBe(k)
          expect(inBounds(b, c)).toBe(true)
        }
      }
    }
  })

  it.each(SCALES)('moves to the NEAREST valid transform at k=%f (per axis clamp)', (k) => {
    for (const c of [TALL, SHORT, WIDE]) {
      const b = boundTransform(at(1e6, -1e6, k), VIEW, c)
      // Nudging the result further toward the original is out of bounds on both axes…
      expect(inBounds(at(b.x + 1, b.y, k), c)).toBe(false)
      expect(inBounds(at(b.x, b.y - 1, k), c)).toBe(false)
      // …so it sits on the bound closest to where it was asked to go.
      expect(inBounds(b, c)).toBe(true)
    }
  })

  it('is idempotent', () => {
    for (const k of SCALES) {
      for (const c of [TALL, SHORT, WIDE]) {
        const once = boundTransform(at(12345, -67890, k), VIEW, c)
        expect(boundTransform(once, VIEW, c)).toBe(once)
      }
    }
  })

  it('is continuous in the scale across the content-fits-the-window threshold', () => {
    // TALL is exactly the window's height at k* = (H - top - bottom) / 6000.
    const kStar = (H - PAN_TOP_MARGIN - PAN_BOTTOM_MARGIN) / 6000
    let prev: ZoomTransform | null = null
    for (let i = -200; i <= 200; i++) {
      const k = kStar * (1 + i / 2000)
      const b = boundTransform(at(0, 1e6, k), VIEW, TALL)
      if (prev) expect(Math.abs(b.y - prev.y)).toBeLessThan(1)
      prev = b
    }
  })

  it('is continuous in the requested translate (a small move never jumps)', () => {
    let prev = boundTransform(at(0, -8000, 1), VIEW, TALL)
    for (let y = -8000; y <= 2000; y += 7) {
      const b = boundTransform(at(0, y, 1), VIEW, TALL)
      expect(Math.abs(b.y - prev.y)).toBeLessThanOrEqual(7 + 1e-9)
      prev = b
    }
  })

  it('leaves an axis free when the content box is unbounded (d3 default extent)', () => {
    const free: Extent = [
      [-Infinity, -Infinity],
      [Infinity, Infinity]
    ]
    const t = at(-1e9, 1e9, 3)
    expect(boundTransform(t, VIEW, free)).toBe(t)
  })

  it('leaves the transform as it is, never NaN, for a NaN content box', () => {
    const bad: Extent = [
      [0, 0],
      [NaN, NaN]
    ]
    const t = at(-1e9, 1e9, 3)
    expect(boundTransform(t, VIEW, bad)).toBe(t)
  })
})

describe('boundTransform: the edge add-page overhang', () => {
  // One wide row of cards, with a round "Add page" button's outer half (16 world px) past its edge.
  const ROW = box(1300, 6000)
  const withOverhang: PanBounds = { ...PAN_BOUNDS, overhang: 16 }
  const x0 = PAN_SIDE_MARGIN
  const x1 = W - PAN_SIDE_MARGIN

  it('lets the whole button be brought into view at an ordinary zoom', () => {
    for (const k of [2, 7, 20]) {
      const b = boundTransform(at(-1e7, 0, k), VIEW, ROW, withOverhang)
      expect(b.applyX(1300 + 16)).toBeCloseTo(x1)
    }
  })

  it('never lets the view be panned to an empty screen, however far it is zoomed in', () => {
    // At MAX_SCALE the overhang alone is 16 × 90 = 1440 px, wider than the window: uncapped, the
    // cards' right edge would end up left of the screen.
    expect(16 * MAX_SCALE).toBeGreaterThan(x1 - x0)
    for (const k of [20, 41, 42, 60, MAX_SCALE]) {
      const b = boundTransform(at(-1e9, -1e9, k), VIEW, ROW, withOverhang)
      const right = b.applyX(1300)
      // The cards still reach at least halfway across the window…
      expect(right).toBeGreaterThanOrEqual((x0 + x1) / 2 - 1e-6)
      // …and they intersect it.
      expect(right).toBeGreaterThan(0)
      expect(b.applyX(0)).toBeLessThan(W)
    }
  })

  it('is continuous in the scale where the cap takes over', () => {
    const kCap = (x1 - x0) / (2 * 16)
    let prev: number | null = null
    for (let i = -200; i <= 200; i++) {
      const k = kCap * (1 + i / 4000)
      const right = boundTransform(at(-1e9, 0, k), VIEW, ROW, withOverhang).applyX(1300)
      if (prev !== null) expect(Math.abs(right - prev)).toBeLessThan(1)
      prev = right
    }
  })

  it('changes nothing without an overhang', () => {
    const b = boundTransform(at(-1e9, 0, MAX_SCALE), VIEW, ROW, { ...PAN_BOUNDS, overhang: 0 })
    expect(b.applyX(1300)).toBeCloseTo(x1)
  })
})

describe('boundTransform: the top reach (the find bar open)', () => {
  const findOpen: PanBounds = { ...PAN_BOUNDS, topReach: 124 }

  it('lets the top of tall content come down to the reach, and no further', () => {
    expect(boundTransform(at(0, 5000, 1), VIEW, TALL, findOpen).y).toBe(124)
    // Its end is still held at the bottom margin.
    expect(boundTransform(at(0, -1e6, 1), VIEW, TALL, findOpen).y).toBe(
      H - PAN_BOTTOM_MARGIN - 6000
    )
  })

  it('keeps short content inside the usual window: raising the reach moves nothing', () => {
    const inside = at(300, PAN_TOP_MARGIN, 1)
    expect(boundTransform(inside, VIEW, SHORT, findOpen)).toBe(inside)
    expect(boundTransform(at(300, -5000, 1), VIEW, SHORT, findOpen).y).toBe(PAN_TOP_MARGIN)
  })

  it('only widens the bounds: whatever was in bounds without it still is', () => {
    for (const k of SCALES) {
      for (const c of [TALL, SHORT, WIDE]) {
        for (const y of [-1e7, -3000, 0, 500, 1e7]) {
          const b = boundTransform(at(0, y, k), VIEW, c)
          expect(boundTransform(b, VIEW, c, findOpen)).toBe(b)
        }
      }
    }
  })

  it('is continuous in the scale across the content-fits-the-window threshold', () => {
    const kStar = (H - PAN_TOP_MARGIN - PAN_BOTTOM_MARGIN) / 6000
    for (const y of [1e6, -1e6]) {
      let prev: ZoomTransform | null = null
      for (let i = -200; i <= 200; i++) {
        const k = kStar * (1 + i / 2000)
        const b = boundTransform(at(0, y, k), VIEW, TALL, findOpen)
        if (prev) expect(Math.abs(b.y - prev.y)).toBeLessThan(1)
        prev = b
      }
    }
  })
})

describe('panConstrain (the d3 constrain)', () => {
  it('bounds by the translate extent, ignoring nothing else', () => {
    const t = at(0, 1e6, 0.5)
    expect(panConstrain(t, VIEW, TALL)).toEqual(boundTransform(t, VIEW, TALL))
  })
})

describe('bounded programmatic targets', () => {
  const zoomWith = (c: Extent) =>
    ({ translateExtent: () => c }) as unknown as Parameters<typeof boundToViewport>[1]
  const vp = { clientWidth: W, clientHeight: H }

  it('leaves a fit (top, middle or end of the content) as it is', () => {
    for (const [cw, ch] of [
      [1200, 6000],
      [800, 300],
      [1200, 1318]
    ]) {
      for (const focusY of [0, ch / 2, ch]) {
        const fit = computeFitTransform(vp, { contentWidth: cw, contentHeight: ch }, focusY)
        expect(boundToViewport(vp, zoomWith(box(cw, ch)), fit)).toBe(fit)
      }
    }
  })

  it("pulls Find's reveal of the first page down to no lower than the top bound", () => {
    // The reveal keeps its rect below the find bar (124 px), but the content's top can only go to
    // 72: the bounded target stops there, with the page still on screen.
    const t = at(100, -2000, 0.6)
    const rect = { x: 22, y: 52, w: 216, h: 280 }
    const raw = computeRevealTransform(
      t,
      { w: W, h: H },
      rect,
      { top: 124, bottom: 24, side: 24 },
      6000
    )!
    const b = boundToViewport(vp, zoomWith(TALL), raw)
    expect(b.y).toBe(PAN_TOP_MARGIN)
    expect(b.applyY(rect.y)).toBeGreaterThan(PAN_TOP_MARGIN)
  })

  it("keeps Find's reveal of the last page at the end of the content", () => {
    const t = at(100, 0, 1)
    const rect = { x: 22, y: 6000 - 14 - 280, w: 216, h: 280 }
    const raw = computeRevealTransform(
      t,
      { w: W, h: H },
      rect,
      { top: 124, bottom: 24, side: 24 },
      6000
    )!
    const b = boundToViewport(vp, zoomWith(TALL), raw)
    expect(b.applyY(6000)).toBeCloseTo(H - PAN_BOTTOM_MARGIN)
    expect(inBounds(b, TALL)).toBe(true)
  })

  it('keeps a reveal centred on a page at the edge of zoomed-in content inside the side bounds', () => {
    // Zoomed in to 2: the 1300-wide column is 2600 px across, its left edge at the side margin, and
    // the target page at its far right is off screen.
    const c = box(1300, 6000)
    const t = at(PAN_SIDE_MARGIN, -100, 2)
    const rect = { x: 1300 - 22 - 216, y: 3000, w: 216, h: 280 }
    const raw = computeRevealTransform(
      t,
      { w: W, h: H },
      rect,
      { top: 124, bottom: 24, side: 24 },
      6000
    )!
    // Centring the page would leave the column's right edge short of the side margin…
    expect(edges(raw, c).right).toBeLessThan(W - PAN_SIDE_MARGIN)
    const b = boundToViewport(vp, zoomWith(c), raw)
    // …so the bounded reveal stops at the edge, with the page still fully in view.
    expect(edges(b, c).right).toBe(W - PAN_SIDE_MARGIN)
    expect(b.applyX(rect.x)).toBeGreaterThanOrEqual(PAN_SIDE_MARGIN)
    expect(b.applyX(rect.x + rect.w)).toBeLessThanOrEqual(W - PAN_SIDE_MARGIN)
  })
})
