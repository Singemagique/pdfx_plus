import { describe, expect, it } from 'vitest'

import {
  boundsOfPath,
  clientToPdf,
  geomToCss,
  pageScale,
  pointToCss,
  rectGeom
} from './overlay-geometry'

const page = { width: 200, height: 400 } // PDF points
const fit = { w: 100, h: 200 } // CSS px → scale 0.5

describe('pageScale', () => {
  it('is CSS px per PDF point', () => {
    expect(pageScale(page, fit)).toBe(0.5)
  })
})

describe('geomToCss', () => {
  it('maps a bottom-left PDF box to a top-left CSS rect (Y flipped, scaled)', () => {
    // A 40x40 box whose bottom-left is at (20, 20) in PDF space.
    const css = geomToCss({ x: 20, y: 20, w: 40, h: 40, rotation: 0, opacity: 1 }, page, fit)
    expect(css.left).toBe(10) // 20 * 0.5
    expect(css.width).toBe(20) // 40 * 0.5
    expect(css.height).toBe(20)
    // top = (pageH - y - h) * s = (400 - 20 - 40) * 0.5 = 170
    expect(css.top).toBe(170)
  })
})

describe('pointToCss', () => {
  it('flips Y about the page height', () => {
    expect(pointToCss(0, 400, page, fit)).toEqual({ x: 0, y: 0 }) // top-left
    expect(pointToCss(200, 0, page, fit)).toEqual({ x: 100, y: 200 }) // bottom-right
  })
})

describe('clientToPdf', () => {
  const rect = { left: 1000, top: 500, width: 100, height: 200 }
  it('inverts the on-screen rect back to PDF points (origin bottom-left)', () => {
    expect(clientToPdf(1000, 500, rect, page)).toEqual({ x: 0, y: 400 }) // top-left → PDF top
    expect(clientToPdf(1100, 700, rect, page)).toEqual({ x: 200, y: 0 }) // bottom-right → PDF origin
    expect(clientToPdf(1050, 600, rect, page)).toEqual({ x: 100, y: 200 }) // center
  })
})

describe('rectGeom', () => {
  it('normalizes two corner points into a positive-size geom', () => {
    expect(rectGeom({ x: 80, y: 300 }, { x: 20, y: 100 })).toMatchObject({
      x: 20,
      y: 100,
      w: 60,
      h: 200
    })
  })
})

describe('boundsOfPath', () => {
  it('computes the bounding box of a flat point list', () => {
    expect(boundsOfPath([10, 10, 50, 80, 30, 5])).toMatchObject({ x: 10, y: 5, w: 40, h: 75 })
  })
  it('returns a zero box for an empty path', () => {
    expect(boundsOfPath([])).toMatchObject({ x: 0, y: 0, w: 0, h: 0 })
  })
})
