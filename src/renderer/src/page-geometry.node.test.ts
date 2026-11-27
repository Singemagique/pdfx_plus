import { describe, expect, it } from 'vitest'
import {
  cropWindow,
  displayToPage,
  effectiveSize,
  frameOf,
  fullPageInWindow,
  normalizeRotation,
  pageFrame,
  pageToDisplay,
  visibleBox,
  windowFractions,
  type QuarterTurn
} from './page-geometry'
import { makePageKey } from './edit/model'
import type { PageEntry } from './types'

const LETTER = { width: 612, height: 792 }
const CROP = { x: 100, y: 200, w: 300, h: 400 }
const ROTS: QuarterTurn[] = [0, 90, 180, 270]

describe('cropWindow', () => {
  it('flips the bottom-left crop to a top-left window', () => {
    expect(cropWindow(LETTER, CROP)).toEqual({ x: 100, y: 192, w: 300, h: 400 })
  })

  it('clamps a crop that runs past the page', () => {
    expect(cropWindow(LETTER, { x: -50, y: 700, w: 200, h: 300 })).toEqual({
      x: 0,
      y: 0,
      w: 150,
      h: 92
    })
  })

  it('is null when absent, empty, non-finite or entirely off the page', () => {
    expect(cropWindow(LETTER, undefined)).toBeNull()
    expect(cropWindow(LETTER, null)).toBeNull()
    expect(cropWindow(LETTER, { x: 10, y: 10, w: 0, h: 50 })).toBeNull()
    expect(cropWindow(LETTER, { x: 10, y: 10, w: NaN, h: 50 })).toBeNull()
    expect(cropWindow(LETTER, { x: 10, y: 10, w: Infinity, h: 50 })).toBeNull()
    expect(cropWindow(LETTER, { x: 700, y: 10, w: 50, h: 50 })).toBeNull()
  })
})

describe('pageFrame', () => {
  it.each(ROTS)('uncropped at %i° shows the whole page, swapped for quarter turns', (rot) => {
    const f = pageFrame(LETTER, rot)
    expect(f.cropped).toBe(false)
    expect(f.window).toEqual({ x: 0, y: 0, w: 612, h: 792 })
    expect(f.uprightW).toBe(612)
    expect(f.uprightH).toBe(792)
    const q = rot === 90 || rot === 270
    expect([f.w, f.h]).toEqual(q ? [792, 612] : [612, 792])
  })

  it.each(ROTS)('cropped at %i° takes the crop size, rotated on top', (rot) => {
    const f = pageFrame(LETTER, rot, CROP)
    expect(f.cropped).toBe(true)
    expect(f.rotation).toBe(rot)
    expect([f.uprightW, f.uprightH]).toEqual([300, 400])
    const q = rot === 90 || rot === 270
    expect([f.w, f.h]).toEqual(q ? [400, 300] : [300, 400])
    expect(effectiveSize(LETTER, rot, CROP)).toEqual({ w: f.w, h: f.h })
  })

  it('normalises the rotation', () => {
    expect(pageFrame(LETTER, -90).rotation).toBe(270)
    expect(pageFrame(LETTER, 450).rotation).toBe(90)
    expect(normalizeRotation(-180)).toBe(180)
  })
})

describe('frameOf', () => {
  const page = {
    id: 'p',
    source: { id: 's' },
    pageIndex: 2,
    width: 612,
    height: 792
  } as unknown as PageEntry
  const key = makePageKey('s', 2)

  it('reads the page rotation and crop from the edit maps', () => {
    const f = frameOf(page, { rotations: new Map([[key, 90]]), crops: new Map([[key, CROP]]) })
    expect(f.rotation).toBe(90)
    expect(f.window).toEqual({ x: 100, y: 192, w: 300, h: 400 })
  })

  it('ignores the crop in crop-edit mode, keeping the rotation', () => {
    const f = frameOf(
      page,
      { rotations: new Map([[key, 180]]), crops: new Map([[key, CROP]]) },
      { ignoreCrop: true }
    )
    expect(f.cropped).toBe(false)
    expect(f.rotation).toBe(180)
  })

  it('is the plain page without edits', () => {
    expect(frameOf(page, {})).toEqual(pageFrame(LETTER))
  })
})

describe('fullPageInWindow', () => {
  it('places the full page so the crop window fills the box', () => {
    const f = pageFrame(LETTER, 0, CROP)
    // Window 300×400 into a 150×200 box: scale 0.5.
    const r = fullPageInWindow(f, 150, 200)
    expect(r).toEqual({ left: -50, top: -96, width: 306, height: 396, scale: 0.5 })
  })

  it('contain-centres when the box aspect differs (a clamped cell)', () => {
    const f = pageFrame(LETTER, 0, CROP)
    // 300×400 window into 200×200: scale 0.5 by height, 50 px spare width split either side.
    const r = fullPageInWindow(f, 200, 200)
    expect(r.scale).toBe(0.5)
    expect(r.left).toBe(-50 + 25)
    expect(r.top).toBe(-96)
  })

  it('is the plain box for an uncropped page', () => {
    const r = fullPageInWindow(pageFrame(LETTER), 306, 396)
    expect(r).toEqual({ left: 0, top: 0, width: 306, height: 396, scale: 0.5 })
  })
})

describe('windowFractions / visibleBox', () => {
  it('gives the window as page fractions, or null uncropped', () => {
    expect(windowFractions(pageFrame(LETTER))).toBeNull()
    const c = windowFractions(pageFrame(LETTER, 90, CROP))!
    expect(c.x0).toBeCloseTo(100 / 612)
    expect(c.y0).toBeCloseTo(192 / 792)
    expect(c.x1).toBeCloseTo(400 / 612)
    expect(c.y1).toBeCloseTo(592 / 792)
  })

  it('gives the visible area in bottom-left PDF points', () => {
    expect(visibleBox(LETTER, CROP)).toEqual(CROP)
    expect(visibleBox(LETTER)).toEqual({ x: 0, y: 0, w: 612, h: 792 })
    expect(visibleBox(LETTER, { x: -10, y: 0, w: 110, h: 50 })).toEqual({
      x: 0,
      y: 0,
      w: 100,
      h: 50
    })
  })
})

describe('pageToDisplay / displayToPage', () => {
  it.each(ROTS)('round-trips and maps the crop corners to the display corners (%i°)', (rot) => {
    const f = pageFrame(LETTER, rot, CROP)
    for (const [x, y] of [
      [120, 230],
      [399, 591],
      [250, 400]
    ]) {
      const d = pageToDisplay(f, x, y)
      const back = displayToPage(f, d.x, d.y)
      expect(back.x).toBeCloseTo(x, 9)
      expect(back.y).toBeCloseTo(y, 9)
    }
    // Every crop corner lands on a corner of the displayed w×h box.
    const corners = [
      [100, 192],
      [400, 192],
      [400, 592],
      [100, 592]
    ].map(([x, y]) => pageToDisplay(f, x, y))
    for (const c of corners) {
      expect([0, f.w]).toContain(c.x)
      expect([0, f.h]).toContain(c.y)
    }
    // CSS rotate() is clockwise: the window's top-left goes to the displayed top-right at 90°.
    const tl = pageToDisplay(f, 100, 192)
    const expected = { 0: [0, 0], 90: [f.w, 0], 180: [f.w, f.h], 270: [0, f.h] }[rot]
    expect([tl.x, tl.y]).toEqual(expected)
  })

  it('does not depend on the view-box origin (pdf.js already removed it)', () => {
    // A page whose MediaBox starts at (50, 100) still reports a 0-based 612×792 visual frame, and
    // its crop is stored in that frame: nothing here ever adds the origin back.
    const shifted = pageFrame({ width: 612, height: 792 }, 0, CROP)
    expect(shifted.window).toEqual({ x: 100, y: 192, w: 300, h: 400 })
    expect(pageToDisplay(shifted, 100, 192)).toEqual({ x: 0, y: 0 })
  })
})
