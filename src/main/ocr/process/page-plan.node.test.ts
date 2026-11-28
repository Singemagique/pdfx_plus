// page-plan.ts (DESIGN.md §3.4.2, §3.4.3): the render flags rule, the adaptive re-render's DPI
// and caps, which result is kept, and the result's pixel → overlay affine.

import { describe, expect, it } from 'vitest'

import { applyAffine } from '../../../shared/ocr/preprocess/geometry'
import { PIXEL_CAPS } from '../../../shared/ocr/triage'
import { outcomeOf } from '../test-utils/fake-threads'
import {
  NO_SMOOTH_MAX_SCALE,
  adaptiveRender,
  keepAdaptive,
  overlayAffine,
  renderFlagsFor
} from './page-plan'
import { FPDF_RENDER_NO_SMOOTHIMAGE, RENDER_FLAGS } from './raster-core'
import type { RawOcr } from '../../../shared/ocr/engine/types'

const raw = (conf: number, n = 3): RawOcr => ({
  lines: [
    {
      kind: 'ocr_line',
      bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
      baseline: null,
      xHeight: 5,
      size: 10,
      words: Array.from({ length: n }, () => ({
        text: 'word',
        bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
        conf
      }))
    }
  ],
  meanConf: conf,
  confSource: 'word'
})

describe('renderFlagsFor (the NO_SMOOTHIMAGE rule, §3.4.2)', () => {
  it('adds the flag only for a 1-bit image at ≤ 1.5× native, and only when the rule is on', () => {
    const bit = (dEff: number) => ({ bitsPerPixel: 1, effectiveDpi: dEff })
    expect(renderFlagsFor(bit(300), 300, true)).toBe(FPDF_RENDER_NO_SMOOTHIMAGE)
    expect(renderFlagsFor(bit(200), 200 * NO_SMOOTH_MAX_SCALE, true)).toBe(
      FPDF_RENDER_NO_SMOOTHIMAGE
    )
    expect(renderFlagsFor(bit(200), 301, true)).toBe(RENDER_FLAGS)
    expect(renderFlagsFor({ bitsPerPixel: 8, effectiveDpi: 300 }, 300, true)).toBe(RENDER_FLAGS)
    expect(renderFlagsFor({ bitsPerPixel: 1, effectiveDpi: null }, 300, true)).toBe(RENDER_FLAGS)
    expect(renderFlagsFor(undefined, 300, true)).toBe(RENDER_FLAGS)
    expect(renderFlagsFor(bit(300), 300, false)).toBe(RENDER_FLAGS)
  })
})

describe('adaptiveRender (§3.4.3)', () => {
  const A4 = { width: 595, height: 842 }
  const req = (dpi: number) => ({ dpi, measured: 12, script: 'xheight' as const })

  it('renders at the requested DPI, capped at 600', () => {
    expect(adaptiveRender(req(462), 300, A4, undefined, PIXEL_CAPS)?.dpi).toBe(462)
    expect(
      adaptiveRender(req(900), 300, { width: 200, height: 200 }, undefined, PIXEL_CAPS)?.dpi
    ).toBe(600)
  })

  it('caps image-origin pages at 2 × native and every page at the pixel caps', () => {
    const t = { imageOrigin: true, effectiveDpi: 200 }
    expect(adaptiveRender(req(500), 300, { width: 200, height: 200 }, t, PIXEL_CAPS)?.dpi).toBe(400)
    // A3 at 600 DPI is 7017 × 9925 px: over the 7200 px long side.
    const big = adaptiveRender(req(600), 300, { width: 842, height: 1191 }, undefined, PIXEL_CAPS)!
    expect(Math.max(big.width, big.height)).toBeLessThanOrEqual(PIXEL_CAPS.maxLongSide)
    expect(big.width * big.height).toBeLessThanOrEqual(PIXEL_CAPS.maxPixels)
    expect(big.dpi).toBeLessThan(600)
  })

  it('returns null when the re-render would gain under 5%', () => {
    expect(adaptiveRender(req(310), 300, A4, undefined, PIXEL_CAPS)).toBeNull()
    expect(
      adaptiveRender(req(900), 590, { width: 200, height: 200 }, undefined, PIXEL_CAPS)
    ).toBeNull()
  })
})

describe('keepAdaptive and overlayAffine', () => {
  it('keeps the adaptive result only when it scores higher (Σ conf × chars)', () => {
    expect(keepAdaptive(outcomeOf(raw(80)), outcomeOf(raw(90)))).toBe(true)
    expect(keepAdaptive(outcomeOf(raw(90)), outcomeOf(raw(80)))).toBe(false)
    expect(keepAdaptive(outcomeOf(raw(90)), outcomeOf(raw(90)))).toBe(false)
  })

  it('composes the copy → raster map with raster px → overlay pt', () => {
    const m = overlayAffine(
      outcomeOf(raw(90), { toSource: [1, 0, 0, 1, -16, -16] }),
      { width: 72, height: 72 },
      { width: 300, height: 300 }
    )
    // Copy pixel (16, 16) is raster (0, 0): the page's top-left corner.
    expect(applyAffine(m, 16, 16)).toEqual([0, 72])
    expect(applyAffine(m, 316, 316)).toEqual([72, 0])
  })
})
