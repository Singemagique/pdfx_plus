import { describe, expect, it } from 'vitest'
import { clampPan, fitInto, fullViewBox, zoomAbout } from './page-display'
import { pageFrame } from '../../page-geometry'

const PAGE = { width: 612, height: 792 }
const CROP = { x: 100, y: 200, w: 300, h: 400 } // window {x: 100, y: 192, w: 300, h: 400}
const VP = { w: 1200, h: 900 }

describe('fullViewBox', () => {
  it('fits an uncropped page as before', () => {
    const b = fullViewBox(pageFrame(PAGE), VP)
    expect(b.dfit).toEqual(fitInto(612, 792, VP))
    expect(b.box).toEqual(b.dfit)
    expect(b.inner.left).toBeCloseTo(0, 9)
    expect(b.inner.top).toBeCloseTo(0, 9)
    expect(b.inner.width).toBeCloseTo(b.box.w, 9)
  })

  it('fits a cropped page by its crop and offsets the full page inside the window', () => {
    const b = fullViewBox(pageFrame(PAGE, 0, CROP), VP)
    expect(b.dfit).toEqual(fitInto(300, 400, VP)) // 675 × 900
    expect(b.box).toEqual(b.dfit)
    const s = 900 / 400
    expect(b.inner.scale).toBeCloseTo(s, 9)
    expect(b.inner.left).toBeCloseTo(-100 * s, 9)
    expect(b.inner.top).toBeCloseTo(-192 * s, 9)
    expect(b.inner.width).toBeCloseTo(612 * s, 9)
  })

  it.each([90, 270])('fits a %i°-rotated crop by its rotated size, box kept upright', (rot) => {
    const b = fullViewBox(pageFrame(PAGE, rot, CROP), VP)
    expect(b.dfit).toEqual(fitInto(400, 300, VP)) // 1200 × 900
    expect(b.box).toEqual({ w: b.dfit.h, h: b.dfit.w })
    expect(b.inner.scale).toBeCloseTo(3, 9)
  })

  it('fits a rotated uncropped page by its rotated size (was fitted unrotated)', () => {
    const b = fullViewBox(pageFrame(PAGE, 90), VP)
    expect(b.dfit).toEqual(fitInto(792, 612, VP))
  })

  it('is the whole-page fit in crop-edit mode (the crop ignored)', () => {
    // FullView / FullViewPage pass the frame without its crop while the crop tool is on.
    expect(fullViewBox(pageFrame(PAGE, 0, null), VP)).toEqual(fullViewBox(pageFrame(PAGE), VP))
  })
})

describe('zoom / pan clamp against the displayed fit', () => {
  const cropped = fullViewBox(pageFrame(PAGE, 0, CROP), VP).dfit // 675 × 900
  const full = fitInto(612, 792, VP) // ≈ 695 × 900

  it('clamps a pan to the cropped fit, not the full page', () => {
    const v = { zoom: 2, x: 0, y: 0 }
    const p = clampPan(v, 10_000, -10_000, cropped, VP)
    expect(p.x).toBeCloseTo((cropped.w * 2 - VP.w) / 2, 9) // 75
    expect(p.y).toBeCloseTo(-(cropped.h * 2 - VP.h) / 2, 9) // -450
    expect(clampPan(v, 10_000, 0, full, VP).x).toBeGreaterThan(p.x)
  })

  it('keeps the focal point fixed and clamps the result', () => {
    const v = { zoom: 1, x: 0, y: 0 }
    // Zooming about the centre keeps the pan at 0.
    expect(zoomAbout(v, 2, cropped, VP)).toEqual({ zoom: 2, x: 0, y: 0 })
    // Zooming about a point right of centre pans left, within the cropped bound.
    const z = zoomAbout(v, 4, cropped, VP, { x: 700, y: 450 })
    expect(z.x).toBeCloseTo(-100 * 3, 9)
    const far = zoomAbout(v, 1.2, cropped, VP, { x: 1200, y: 450 })
    expect(far.x).toBeCloseTo(-Math.max(0, (cropped.w * 1.2 - VP.w) / 2), 9)
  })
})
