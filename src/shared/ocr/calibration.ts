// Confidence calibration (DESIGN.md §3.4.6): raw engine confidence → P(word correct), a 21-point
// monotone piecewise-linear map, so every UI threshold means the same thing whatever the engine.
//
// PR6 fits it offline: `scripts/ocr-calibrate.mjs` runs the synthetic sweep (seeds × presets ×
// fonts) through the real engine and pipeline, labels each recognised word correct or not against
// the ground truth, fits an isotonic regression of correctness on raw confidence and writes the
// 21 points to `calibration/tess-simd.json`. The maintainers' real corpus (§3.9.1) does not
// exist yet; the script takes it as a second input when it does (see the script's header).
//
// The thresholds are expressed in P(correct) (`CAL_THRESHOLDS`), read off the fitted curve at the
// raw anchors the design names (retry ≈ raw 70, page flag ≈ raw 60, word underline ≈ raw 50). A
// future engine ships its own table and keeps the same P thresholds, so the UI means the same.

import fitted from './calibration/tess-simd.json'
import { ENGINE_ID } from './engine/tess-core'
import type { CalibrationTable } from './engine/types'

/** The uncalibrated stand-in (p = raw / 100), kept for tests and as the shape reference. */
export const TESS_CALIBRATION_PLACEHOLDER: CalibrationTable = {
  engineId: ENGINE_ID,
  placeholder: true,
  points: Array.from({ length: 21 }, (_, i) => [i * 5, i / 20] as const)
}

/** Raw-confidence anchors of the UI thresholds (§3.4.5, §3.4.6). */
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

/** The committed fit for tess-core 7 simd (scripts/ocr-calibrate.mjs). */
export interface CalibrationFile {
  engineId: string
  placeholder: boolean
  points: [number, number][]
  /** What the fit was made from, for the record (counts only, never text). */
  fit?: Record<string, unknown>
}

function load(f: CalibrationFile): CalibrationTable {
  const t: CalibrationTable = {
    engineId: f.engineId,
    placeholder: f.placeholder,
    points: f.points.map(([r, p]) => [r, p] as const)
  }
  if (t.engineId !== ENGINE_ID) throw new Error('calibration table is for another engine')
  assertCalibrationTable(t)
  return t
}

/** The table every OcrPage's `confCal` comes from. */
export const TESS_CALIBRATION: CalibrationTable = load(fitted as unknown as CalibrationFile)

/** The UI thresholds in P(correct), re-derived from a table at the raw anchors (2 decimals). */
export function thresholdsFor(t: CalibrationTable): {
  retry: number
  flag: number
  underline: number
} {
  const at = (raw: number): number => Math.round((calibrate(t, raw) ?? 0) * 100) / 100
  return {
    retry: at(RAW_THRESHOLDS.retry),
    flag: at(RAW_THRESHOLDS.flag),
    underline: at(RAW_THRESHOLDS.underline)
  }
}

/**
 * The thresholds the pipeline and the UI compare `confCal` against: below `retry` the page gets
 * Retry A, below `flag` it is reported Low confidence, below `underline` a word is underlined.
 */
export const CAL_THRESHOLDS = thresholdsFor(TESS_CALIBRATION)
