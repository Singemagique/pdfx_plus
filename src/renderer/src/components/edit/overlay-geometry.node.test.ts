import { describe, expect, it } from 'vitest'
import { pageFrame } from '../../page-geometry'
import { fullViewBox } from '../full-view/page-display'

import {
  boundsOfPath,
  clientToPdf,
  clientToPdfRotated,
  geomToCss,
  movePath,
  pageScale,
  pointToCss,
  rectGeom,
  rectToVisual,
  resizeGeom,
  scalePath,
  type Pt
} from './overlay-geometry'

const page = { width: 200, height: 400 } // PDF points
const fit = { w: 100, h: 200 } // CSS px → scale 0.5

describe('pageScale', () => {
  it('is CSS px per PDF point', () => {
    expect(pageScale(page, fit)).toBe(0.5)
  })
})

describe('rectToVisual', () => {
  // Source page is unrotated 400x200 (landscape); pdf.js reports the visual page swapped per /Rotate.
  it('is a no-op for an unrotated page', () => {
    const r = { x: 10, y: 20, w: 100, h: 50 }
    expect(rectToVisual(r, 0, 200, 400)).toEqual(r)
  })
  it('maps an unrotated /Rect into 90° visual space (axes swap)', () => {
    // visual 200x400 ⇒ unrotated 400x200; rect {10,20,100,50} in unrotated space.
    expect(rectToVisual({ x: 10, y: 20, w: 100, h: 50 }, 90, 200, 400)).toEqual({
      x: 20,
      y: 290,
      w: 50,
      h: 100
    })
  })
  it('maps 180° (both axes flipped, dims preserved)', () => {
    expect(rectToVisual({ x: 10, y: 20, w: 100, h: 50 }, 180, 200, 400)).toEqual({
      x: 90,
      y: 330,
      w: 100,
      h: 50
    })
  })
  it('maps 270° visual space', () => {
    expect(rectToVisual({ x: 10, y: 20, w: 100, h: 50 }, 270, 200, 400)).toEqual({
      x: 130,
      y: 10,
      w: 50,
      h: 100
    })
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

describe('clientToPdfRotated', () => {
  const box = { w: 100, h: 200 } // upright CSS box, aspect matches page (200x400)
  const near = (p: { x: number; y: number }, x: number, y: number): void => {
    expect(p.x).toBeCloseTo(x, 6)
    expect(p.y).toBeCloseTo(y, 6)
  }
  it('matches clientToPdf when rotation is 0', () => {
    const bbox = { left: 0, top: 0, width: 100, height: 200 }
    expect(clientToPdfRotated(50, 100, bbox, box, page, 0)).toEqual(
      clientToPdf(50, 100, bbox, page)
    )
  })
  it('flips x and y at 180°', () => {
    const bbox = { left: 0, top: 0, width: 100, height: 200 }
    near(clientToPdfRotated(0, 0, bbox, box, page, 180), 200, 0) // top-left → bottom-right
    near(clientToPdfRotated(50, 100, bbox, box, page, 180), 100, 200) // centre stays centre
  })
  it('keeps the centre fixed at 90°', () => {
    // at 90° the on-screen bbox is swapped (200 wide, 100 tall); centre is invariant.
    const bbox = { left: 0, top: 0, width: 200, height: 100 }
    near(clientToPdfRotated(100, 50, bbox, box, page, 90), 100, 200)
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

describe('resizeGeom', () => {
  const start = { x: 100, y: 100, w: 50, h: 40, rotation: 0, opacity: 1 }
  it('drags the top-left CSS corner, keeping the PDF bottom-right (x+w, y) fixed', () => {
    // top-left CSS handle is PDF (x, y+h); its opposite is (x+w, y) = (150, 100).
    expect(resizeGeom(start, 'tl', { x: 120, y: 160 })).toMatchObject({
      x: 120,
      y: 100,
      w: 30,
      h: 60
    })
  })
  it('preserves rotation', () => {
    expect(resizeGeom({ ...start, rotation: 15 }, 'br', { x: 200, y: 50 }).rotation).toBe(15)
  })
})

describe('movePath', () => {
  it('translates only x at even indices and y at odd indices', () => {
    expect(movePath([10, 20, 30, 40], 5, -3)).toEqual([15, 17, 35, 37])
  })
})

describe('scalePath', () => {
  it('rescales points as the box doubles in width', () => {
    const from = { x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1 }
    const to = { x: 0, y: 0, w: 200, h: 100, rotation: 0, opacity: 1 }
    expect(scalePath([50, 50], from, to)).toEqual([100, 50])
  })
})

describe('clientToPdfRotated on a cropped page (full-page layer offset inside a clipping window)', () => {
  const PAGE = { width: 612, height: 792 }
  const CROP = { x: 100, y: 200, w: 300, h: 400 } // window {x: 100, y: 192, w: 300, h: 400}
  const VP = { w: 1200, h: 900 }
  const ZOOM = 1.7
  const CENTRE = { x: 630, y: 430 } // the window's centre on screen (fitted, then panned)

  /** Window-local upright point → screen, through `.full-page`'s scale + rotate about its centre. */
  const toScreen = (rot: number, bw: number, bh: number, x: number, y: number): Pt => {
    const a = (rot * Math.PI) / 180
    const dx = (x - bw / 2) * ZOOM
    const dy = (y - bh / 2) * ZOOM
    return {
      x: CENTRE.x + dx * Math.cos(a) - dy * Math.sin(a),
      y: CENTRE.y + dx * Math.sin(a) + dy * Math.cos(a)
    }
  }

  it.each([0, 90, 180, 270])('maps the window corners to the crop corners at %i°', (rot) => {
    const frame = pageFrame(PAGE, rot, CROP)
    const { box, inner } = fullViewBox(frame, VP)
    // The layer's on-screen bbox: the axis-aligned box of its four transformed corners.
    const corners = [
      [inner.left, inner.top],
      [inner.left + inner.width, inner.top],
      [inner.left + inner.width, inner.top + inner.height],
      [inner.left, inner.top + inner.height]
    ].map(([x, y]) => toScreen(rot, box.w, box.h, x, y))
    const xs = corners.map((p) => p.x)
    const ys = corners.map((p) => p.y)
    const bbox = {
      left: Math.min(...xs),
      top: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys)
    }
    const fit = { w: inner.width, h: inner.height }
    const expected: Array<[number, number, number, number]> = [
      [0, 0, 100, 600],
      [box.w, 0, 400, 600],
      [box.w, box.h, 400, 200],
      [0, box.h, 100, 200]
    ]
    for (const [wx, wy, px, py] of expected) {
      const s = toScreen(rot, box.w, box.h, wx, wy)
      const p = clientToPdfRotated(s.x, s.y, bbox, fit, PAGE, rot)
      expect(p.x).toBeCloseTo(px, 6)
      expect(p.y).toBeCloseTo(py, 6)
    }
  })
})
