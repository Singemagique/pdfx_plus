import { describe, expect, it } from 'vitest'
import {
  BASE_RASTER,
  detailCapFactor,
  detailDpr,
  MAX_DETAIL,
  MAX_DETAIL_PIXELS,
  normalizeRotation,
  planDetail,
  type DetailInput,
  type ScreenRect
} from './detail-geometry'

// US Letter, laid out upright at 300 CSS px wide, displayed at 2× (e.g. full-view zoom).
const W = 612
const H = 792
const LAYOUT_W = 300
const LAYOUT_H = (LAYOUT_W * H) / W
const ZOOM = 2
const UW = LAYOUT_W * ZOOM // upright width on screen
const UH = LAYOUT_H * ZOOM // upright height on screen

type Rot = 0 | 90 | 180 | 270

/** Screen bounding box of the upright box rotated by `rot`, with its top-left at (left, top). */
function bbox(rot: Rot, left: number, top: number): ScreenRect {
  const quarter = rot === 90 || rot === 270
  return { left, top, width: quarter ? UH : UW, height: quarter ? UW : UH }
}

function input(rot: Rot, rect: ScreenRect, over: Partial<DetailInput> = {}): DetailInput {
  return {
    rect,
    layoutW: LAYOUT_W,
    rotation: rot,
    viewportW: 4000,
    viewportH: 4000,
    naturalWidth: W,
    naturalHeight: H,
    dpr: 2,
    ...over
  }
}

/** Forward CSS rotate() map: upright point (u, v) (screen-scaled) → bounding-box point. */
function forward(rot: Rot, u: number, v: number): [number, number] {
  switch (rot) {
    case 90:
      return [UH - v, u]
    case 180:
      return [UW - u, UH - v]
    case 270:
      return [v, UW - u]
    default:
      return [u, v]
  }
}

/** The pre-fix planner, verbatim in behaviour: geometry taken straight from the bounding box. */
function legacyPlan(i: DetailInput): {
  renderScale: number
  fx: number
  fy: number
  backingW: number
  backingH: number
  css: { left: number; top: number; width: number; height: number }
} | null {
  const { rect, layoutW, viewportW, viewportH, naturalWidth, naturalHeight, dpr: d } = i
  const visLeft = Math.max(0, rect.left)
  const visTop = Math.max(0, rect.top)
  const visW = Math.min(viewportW, rect.left + rect.width) - visLeft
  const visH = Math.min(viewportH, rect.top + rect.height) - visTop
  const baseDevicePx = (BASE_RASTER / Math.max(naturalWidth, naturalHeight)) * naturalWidth
  if (visW <= 0 || visH <= 0 || rect.width * d <= baseDevicePx * 1.05) return null
  const effScale = rect.width / layoutW || 1
  return {
    renderScale: (rect.width / naturalWidth) * d,
    fx: (visLeft - rect.left) / rect.width,
    fy: (visTop - rect.top) / rect.height,
    backingW: Math.max(1, Math.round(visW * d)),
    backingH: Math.max(1, Math.round(visH * d)),
    css: {
      left: (visLeft - rect.left) / effScale,
      top: (visTop - rect.top) / effScale,
      width: visW / effScale,
      height: visH / effScale
    }
  }
}

function expectSamePlan(
  plan: ReturnType<typeof planDetail>,
  legacy: ReturnType<typeof legacyPlan>
): void {
  expect(plan).not.toBeNull()
  expect(legacy).not.toBeNull()
  expect(plan!.renderScale).toBeCloseTo(legacy!.renderScale, 9)
  expect(plan!.fx).toBeCloseTo(legacy!.fx, 9)
  expect(plan!.fy).toBeCloseTo(legacy!.fy, 9)
  expect(plan!.backingW).toBe(legacy!.backingW)
  expect(plan!.backingH).toBe(legacy!.backingH)
  for (const k of ['left', 'top', 'width', 'height'] as const) {
    expect(plan!.css[k]).toBeCloseTo(legacy!.css[k], 9)
  }
}

describe('planDetail', () => {
  const ROTS: Rot[] = [0, 90, 180, 270]

  it.each(ROTS)('renders at the upright display scale when rotated %i°', (rot) => {
    const plan = planDetail(input(rot, bbox(rot, 10, 10)))!
    // One PDF point ↦ ZOOM CSS px ↦ ZOOM·dpr device px — regardless of the CSS rotation.
    expect(plan.renderScale).toBeCloseTo((UW / W) * 2, 9)
  })

  it.each(ROTS)('covers the whole upright page when fully visible at %i°', (rot) => {
    const plan = planDetail(input(rot, bbox(rot, 10, 10)))!
    expect(plan.fx).toBeCloseTo(0, 9)
    expect(plan.fy).toBeCloseTo(0, 9)
    expect(plan.css.left).toBeCloseTo(0, 9)
    expect(plan.css.top).toBeCloseTo(0, 9)
    expect(plan.css.width).toBeCloseTo(LAYOUT_W, 9)
    expect(plan.css.height).toBeCloseTo(LAYOUT_H, 9)
    expect(plan.backingW).toBe(Math.round(UW * 2))
    expect(plan.backingH).toBe(Math.round(UH * 2))
  })

  it.each(ROTS)('maps a partially visible region back through a %i° rotation', (rot) => {
    // Bounding box hangs off the top-left; the window clips it on every side.
    const rect = bbox(rot, -137, -61)
    const viewportW = 420
    const viewportH = 330
    const plan = planDetail(input(rot, rect, { viewportW, viewportH }))!
    expect(plan).not.toBeNull()

    // The planned upright region, rotated forward, must be exactly the on-screen region.
    const u0 = plan.css.left * ZOOM
    const v0 = plan.css.top * ZOOM
    const u1 = u0 + plan.css.width * ZOOM
    const v1 = v0 + plan.css.height * ZOOM
    const pts = [forward(rot, u0, v0), forward(rot, u1, v1)]
    const xs = pts.map(([x]) => x + rect.left).sort((a, b) => a - b)
    const ys = pts.map(([, y]) => y + rect.top).sort((a, b) => a - b)
    expect(xs[0]).toBeCloseTo(0, 9)
    expect(ys[0]).toBeCloseTo(0, 9)
    expect(xs[1]).toBeCloseTo(viewportW, 9)
    expect(ys[1]).toBeCloseTo(viewportH, 9)

    // The render offset is the same region, as a fraction of the upright page.
    expect(plan.fx).toBeCloseTo(plan.css.left / LAYOUT_W, 9)
    expect(plan.fy).toBeCloseTo(plan.css.top / LAYOUT_H, 9)
    // Backing store is the visible upright region at device resolution.
    expect(plan.backingW).toBe(Math.round(plan.css.width * ZOOM * 2))
    expect(plan.backingH).toBe(Math.round(plan.css.height * ZOOM * 2))
  })

  it('maps a 90° region to concrete upright coordinates', () => {
    // Visible bbox-relative region: x ∈ [137, 557], y ∈ [61, 391].
    const plan = planDetail(input(90, bbox(90, -137, -61), { viewportW: 420, viewportH: 330 }))!
    // u = y, v = UH - x.
    expect(plan.css.left).toBeCloseTo(61 / ZOOM, 9)
    expect(plan.css.top).toBeCloseTo((UH - 557) / ZOOM, 9)
    expect(plan.css.width).toBeCloseTo(330 / ZOOM, 9)
    expect(plan.css.height).toBeCloseTo(420 / ZOOM, 9)
  })

  it('regression: a 90° page is not over-scaled by H/W nor left 40% uncovered', () => {
    const i = input(90, bbox(90, 10, 10))
    const legacy = legacyPlan(i)!
    const plan = planDetail(i)!
    // The bug: bounding-box width is the upright HEIGHT, so the old scale overshot by H/W …
    expect(legacy.renderScale / plan.renderScale).toBeCloseTo(H / W, 9)
    // … and the canvas covered only (W/H)² of the upright page height.
    expect(legacy.css.height / LAYOUT_H).toBeCloseTo((W / H) ** 2, 9)
    expect(plan.css.height / LAYOUT_H).toBeCloseTo(1, 9)
  })

  it.each([
    ['fully visible', 25, 40, 4000, 4000],
    ['clipped top-left', -137, -61, 420, 330],
    ['clipped bottom-right', 200, 150, 500, 600]
  ])('is unchanged from the legacy planner at 0° (%s)', (_label, left, top, vw, vh) => {
    const i = input(0, bbox(0, left, top), { viewportW: vw, viewportH: vh })
    expectSamePlan(planDetail(i), legacyPlan(i))
  })

  it('is unchanged from the legacy planner at 180° when the page is fully visible', () => {
    const i = input(180, bbox(180, 25, 40))
    expectSamePlan(planDetail(i), legacyPlan(i))
  })

  it('renders the mirrored (actually visible) region at 180° when clipped', () => {
    // Only the screen's left part of the box is visible — that is the upright page's RIGHT part.
    const plan = planDetail(input(180, bbox(180, 0, 0), { viewportW: UW / 4 }))!
    expect(plan.css.left).toBeCloseTo((3 * LAYOUT_W) / 4, 9)
    expect(plan.css.width).toBeCloseTo(LAYOUT_W / 4, 9)
    expect(plan.fx).toBeCloseTo(0.75, 9)
  })

  it('skips the detail canvas when the page is off screen', () => {
    expect(planDetail(input(90, bbox(90, 5000, 10)))).toBeNull()
    expect(planDetail(input(0, bbox(0, 10, -UH - 1)))).toBeNull()
  })

  it('skips the detail canvas when the base raster already suffices (upright width)', () => {
    const baseDevicePx = (BASE_RASTER / H) * W // ≈ 850 device px
    // 90°: bounding-box width is the upright height. Pick an upright width just under the
    // threshold whose height is over it — the decision must follow the upright width.
    const uw = (baseDevicePx * 1.05) / 2 - 1
    const uh = (uw * H) / W
    const rect = { left: 0, top: 0, width: uh, height: uw }
    expect(uh * 2).toBeGreaterThan(baseDevicePx * 1.05)
    expect(planDetail(input(90, rect, { layoutW: uw }))).toBeNull()
    expect(planDetail(input(90, { ...rect, height: uw + 4, width: uh + 6 }))).not.toBeNull()
  })
})

describe('detail cap math', () => {
  it('honours the display DPR up to 3', () => {
    expect(detailDpr(1)).toBe(1)
    expect(detailDpr(1.5)).toBe(1.5)
    expect(detailDpr(2)).toBe(2)
    expect(detailDpr(3)).toBe(3)
    expect(detailDpr(4)).toBe(3)
    expect(detailDpr(0)).toBe(1)
    expect(detailDpr(Number.NaN)).toBe(1)
  })

  it('leaves backing stores within both caps untouched', () => {
    expect(detailCapFactor(5120, 2880)).toBe(1) // full 5K window at DPR 1
    expect(detailCapFactor(MAX_DETAIL, 4096)).toBe(1) // exactly 32 MP, exactly 8192 wide
    expect(detailCapFactor(0, 100)).toBe(1)
  })

  it('caps each side at MAX_DETAIL', () => {
    expect(MAX_DETAIL).toBe(8192)
    expect(detailCapFactor(16384, 100)).toBeCloseTo(0.5, 12)
    expect(detailCapFactor(100, 10000)).toBeCloseTo(8192 / 10000, 12)
  })

  it('caps total pixels at MAX_DETAIL_PIXELS', () => {
    expect(MAX_DETAIL_PIXELS).toBe(32 * 1024 * 1024)
    const f = detailCapFactor(8000, 8000) // 64 MP, sides under MAX_DETAIL
    expect(f).toBeCloseTo(Math.sqrt(MAX_DETAIL_PIXELS / 64e6), 12)
    expect(8000 * f * (8000 * f)).toBeCloseTo(MAX_DETAIL_PIXELS, 3)
  })

  it('renders a DPR-3 / 5K-class view at full resolution', () => {
    // 2560×1440 CSS window at DPR 3 → 7680×4320 ≈ 33.2 M px: under both the 8192 side cap and
    // the 32 MiB-pixel budget, so it renders at the true DPR (was ≤ 4096 wide at DPR 2).
    const big = { naturalWidth: 1000, naturalHeight: 1000, layoutW: 5000, dpr: 3 }
    const window = { viewportW: 2560, viewportH: 1440 }
    const rect = { left: -100, top: -100, width: 5000, height: 5000 }
    const plan = planDetail({ ...big, ...window, rect, rotation: 0 })!
    expect(plan.backingW).toBe(2560 * 3)
    expect(plan.backingH).toBe(1440 * 3)
    expect(plan.backingW * plan.backingH).toBeLessThanOrEqual(MAX_DETAIL_PIXELS)

    // A slightly larger window tips over the pixel budget and is scaled down to fit it.
    const over = planDetail({ ...big, viewportW: 2700, viewportH: 1440, rect, rotation: 0 })!
    expect(over.backingW).toBeLessThan(2700 * 3)
    expect(over.backingW * over.backingH).toBeLessThanOrEqual(MAX_DETAIL_PIXELS)

    // A 1920×1080 CSS window at DPR 3 fits entirely: rendered at the true DPR.
    const hd = planDetail({ ...big, viewportW: 1920, viewportH: 1080, rect, rotation: 0 })!
    expect(hd.backingW).toBe(1920 * 3)
    expect(hd.backingH).toBe(1080 * 3)
  })

  it.each([0, 90, 180, 270] as Rot[])('never exceeds the budget at %i°', (rot) => {
    const rect = bbox(rot, -50, -50)
    const scaled = { ...rect, width: rect.width * 20, height: rect.height * 20 }
    const plan = planDetail(
      input(rot, scaled, { layoutW: LAYOUT_W, viewportW: 9000, viewportH: 9000, dpr: 3 })
    )!
    expect(plan.backingW).toBeLessThanOrEqual(MAX_DETAIL)
    expect(plan.backingH).toBeLessThanOrEqual(MAX_DETAIL)
    expect(plan.backingW * plan.backingH).toBeLessThanOrEqual(MAX_DETAIL_PIXELS)
  })
})

describe('normalizeRotation', () => {
  it('folds any multiple of 90 into [0, 360)', () => {
    expect(normalizeRotation(0)).toBe(0)
    expect(normalizeRotation(450)).toBe(90)
    expect(normalizeRotation(-90)).toBe(270)
    expect(normalizeRotation(-180)).toBe(180)
    expect(normalizeRotation(720)).toBe(0)
  })
})
