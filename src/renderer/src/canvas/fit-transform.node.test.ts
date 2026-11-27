import { describe, expect, it } from 'vitest'
import { computeFitTransform } from './fit-transform'
import { MIN_DOC_WIDTH, SINGLE_ROW_DOC_HEIGHT, wrapWidthForViewport } from './layout'
import {
  FIT_BOTTOM_MARGIN,
  FIT_MARGIN,
  FIT_TOP_MARGIN,
  MAX_FIT_SCALE,
  MIN_SCALE,
  TARGET_FIT_SCALE
} from './zoom-constants'

const vp = { clientWidth: 1600, clientHeight: 900 }

describe('computeFitTransform', () => {
  it('fits the content width and centres it horizontally', () => {
    const t = computeFitTransform(vp, { contentWidth: 1300, contentHeight: 4000 })
    expect(t.k).toBeCloseTo((1600 * FIT_MARGIN) / 1300)
    expect(t.x).toBeCloseTo((1600 - 1300 * t.k) / 2)
  })

  it('content wrapped to the viewport comes up at TARGET_FIT_SCALE', () => {
    const wrap = wrapWidthForViewport(vp.clientWidth)
    const t = computeFitTransform(vp, { contentWidth: wrap, contentHeight: 4000 })
    expect(t.k).toBeCloseTo(TARGET_FIT_SCALE, 2)
  })

  it('anchors the top of tall content just under the toolbar instead of centring it', () => {
    const t = computeFitTransform(vp, { contentWidth: 1300, contentHeight: 4000 })
    expect(t.y).toBe(FIT_TOP_MARGIN)
  })

  it('scrolls a focus y to the top margin', () => {
    const t = computeFitTransform(vp, { contentWidth: 1300, contentHeight: 4000 }, 1200)
    expect(t.invertY(FIT_TOP_MARGIN)).toBeCloseTo(1200)
  })

  it('never scrolls past the end of the content', () => {
    const dims = { contentWidth: 1300, contentHeight: 4000 }
    const t = computeFitTransform(vp, dims, 3990)
    expect(t.applyY(dims.contentHeight)).toBeCloseTo(vp.clientHeight - FIT_BOTTOM_MARGIN)
  })

  it('centres content that fits vertically, whatever the focus', () => {
    const dims = { contentWidth: 1300, contentHeight: 500 }
    const t = computeFitTransform(vp, dims, 300)
    expect(t.y).toBeCloseTo((vp.clientHeight - dims.contentHeight * t.k) / 2)
  })

  it('caps the fit for a small collection on a large screen', () => {
    const t = computeFitTransform(
      { clientWidth: 3800, clientHeight: 2000 },
      { contentWidth: MIN_DOC_WIDTH, contentHeight: 800 }
    )
    expect(t.k).toBe(MAX_FIT_SCALE)
  })

  it('keeps one row of pages within a short viewport', () => {
    const t = computeFitTransform(
      { clientWidth: 2400, clientHeight: 300 },
      { contentWidth: MIN_DOC_WIDTH, contentHeight: 800 }
    )
    expect(t.k).toBeCloseTo((300 * FIT_MARGIN) / SINGLE_ROW_DOC_HEIGHT)
  })

  it('clamps to MIN_SCALE', () => {
    const t = computeFitTransform(vp, { contentWidth: 1e9, contentHeight: 1e9 })
    expect(t.k).toBe(MIN_SCALE)
  })
})
