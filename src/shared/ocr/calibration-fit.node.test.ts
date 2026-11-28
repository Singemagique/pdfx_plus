// Tier 0 (DESIGN.md §3.9.3 "calibration monotonicity", §3.4.6): the isotonic fit, its 21-point
// table, and the committed table for tess-core 7 simd with the thresholds read off it.

import { describe, expect, it } from 'vitest'

import {
  CAL_THRESHOLDS,
  RAW_THRESHOLDS,
  TESS_CORE7,
  assertCalibrationTable,
  calibrate,
  thresholdsFor
} from './calibration'
import fitted from './calibration/tess-core7-simd.json'
import {
  CALIBRATION_RAW,
  expectedCalibrationError,
  fitCalibration,
  isotonicBlocks,
  tableFromBlocks
} from './calibration-fit'
import { ENGINE_ID } from './engine/tess-core'

describe('isotonic fit (pool-adjacent-violators)', () => {
  it('pools violators into their weighted mean', () => {
    const b = isotonicBlocks([
      { conf: 10, correct: true },
      { conf: 20, correct: false },
      { conf: 30, correct: true },
      { conf: 40, correct: true }
    ])
    // 10 (1) and 20 (0) violate: pooled at x 15, p 0.5; then 30 and 40 at 1.
    expect(b).toEqual([
      { x: 15, p: 0.5, w: 2 },
      { x: 30, p: 1, w: 1 },
      { x: 40, p: 1, w: 1 }
    ])
  })

  it('pools equal confidences and honours weights', () => {
    const b = isotonicBlocks([
      { conf: 50, correct: false },
      { conf: 50, correct: true, weight: 3 }
    ])
    expect(b).toEqual([{ x: 50, p: 0.75, w: 4 }])
  })

  it('gives a monotone 21-point table at 0, 5, …, 100', () => {
    let seed = 3
    const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647
    const samples = Array.from({ length: 4000 }, () => {
      const conf = Math.floor(rnd() * 101)
      return { conf, correct: rnd() < conf / 100 }
    })
    const t = fitCalibration(samples)
    expect(t.map(([r]) => r)).toEqual(CALIBRATION_RAW)
    for (let i = 1; i < t.length; i++) expect(t[i][1]).toBeGreaterThanOrEqual(t[i - 1][1])
    // It recovers p ≈ raw / 100, with a small calibration error, where a confident constant is off.
    expect(Math.abs(t[10][1] - 0.5)).toBeLessThan(0.1)
    const table = { engineId: 'x', placeholder: false, points: t }
    expect(expectedCalibrationError(samples, (r) => calibrate(table, r)!)).toBeLessThan(0.03)
    expect(expectedCalibrationError(samples, () => 0.95)).toBeGreaterThan(0.4)
    expect(tableFromBlocks([])).toEqual(CALIBRATION_RAW.map((r) => [r, r / 100]))
  })
})

describe('the committed table (scripts/ocr-calibrate.mjs)', () => {
  it('is a real fit for this engine: 21 monotone points, not the placeholder', () => {
    expect(TESS_CORE7.engineId).toBe(ENGINE_ID)
    expect(TESS_CORE7.placeholder).toBe(false)
    expect(TESS_CORE7.points.map(([r]) => r)).toEqual(CALIBRATION_RAW)
    expect(() => assertCalibrationTable(TESS_CORE7)).not.toThrow()
    expect(fitted.fit.words).toBeGreaterThan(10_000)
    // The real corpus is not committed yet: the fit says so.
    expect(fitted.fit.real).toMatch(/^absent/)
  })

  it('re-derives the UI thresholds from the curve at the raw anchors', () => {
    expect(CAL_THRESHOLDS).toEqual(thresholdsFor(TESS_CORE7))
    expect(CAL_THRESHOLDS.retry).toBeCloseTo(calibrate(TESS_CORE7, RAW_THRESHOLDS.retry)!, 2)
    expect(CAL_THRESHOLDS.flag).toBeCloseTo(calibrate(TESS_CORE7, RAW_THRESHOLDS.flag)!, 2)
    expect(CAL_THRESHOLDS.underline).toBeCloseTo(
      calibrate(TESS_CORE7, RAW_THRESHOLDS.underline)!,
      2
    )
    expect(CAL_THRESHOLDS.underline).toBeLessThanOrEqual(CAL_THRESHOLDS.flag)
    expect(CAL_THRESHOLDS.flag).toBeLessThanOrEqual(CAL_THRESHOLDS.retry)
    expect(fitted.fit.thresholds).toEqual(CAL_THRESHOLDS)
  })
})
