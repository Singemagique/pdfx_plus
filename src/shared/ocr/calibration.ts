// Confidence calibration (DESIGN.md §3.4.6): raw engine confidence → P(word correct), a 21-point
// monotone piecewise-linear map, so every UI threshold means the same thing whatever the engine.
//
// PR5 ships a PLACEHOLDER (identity: p = raw / 100) marked `placeholder: true`. PR6 replaces it
// with the isotonic fit of the tier-2 synthetic sweep plus the committed real corpus
// (`scripts/ocr-calibrate.mjs` → `calibration/tess-core7-simd.json`) and re-derives the thresholds
// below from the fitted curve. Until then the thresholds are the raw values the design names.

import { ENGINE_ID } from './engine/tess-core'
import type { CalibrationTable } from './engine/types'

/** The uncalibrated stand-in for tess-core 7 simd: 21 points on p = raw / 100. */
export const TESS_CORE7_PLACEHOLDER: CalibrationTable = {
  engineId: ENGINE_ID,
  placeholder: true,
  points: Array.from({ length: 21 }, (_, i) => [i * 5, i / 20] as const)
}

/** Raw-confidence anchors of the UI thresholds (§3.4.5, §3.4.6); compare against `calibrate`d. */
export const RAW_THRESHOLDS = { retry: 70, flag: 60, underline: 50 } as const

/** Throws unless `t` is a valid table: ≥ 2 points, raw strictly ascending in 0..100, p monotone 0..1. */
export function assertCalibrationTable(t: CalibrationTable): void {
  const pts = t.points
  if (pts.length < 2) throw new RangeError('calibration needs at least 2 points')
  for (let i = 0; i < pts.length; i++) {
    const [raw, p] = pts[i]
    if (!(raw >= 0 && raw <= 100 && p >= 0 && p <= 1)) throw new RangeError('point out of range')
    if (i > 0 && !(raw > pts[i - 1][0] && p >= pts[i - 1][1]))
      throw new RangeError('calibration must be monotone')
  }
}

/** P(correct) for a raw confidence (clamped to the table's ends); null stays null. */
export function calibrate(t: CalibrationTable, raw: number | null): number | null {
  if (raw === null || Number.isNaN(raw)) return null
  const pts = t.points
  if (raw <= pts[0][0]) return pts[0][1]
  for (let i = 1; i < pts.length; i++) {
    const [r1, p1] = pts[i]
    if (raw <= r1) {
      const [r0, p0] = pts[i - 1]
      return p0 + ((raw - r0) / (r1 - r0)) * (p1 - p0)
    }
  }
  return pts[pts.length - 1][1]
}
