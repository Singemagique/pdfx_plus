// Skew detection (DESIGN.md §3.4.5), Leptonica's sweep-and-search: on the 1/4-scale binary copy,
// shear the ink vertically by tan(a) and score the sharpness of the row profile (the sum of
// squared differences of adjacent row sums: text lines give tall, crisp peaks only when they lie
// flat). Sweep ±7° in 1° steps, then halve the step around the best angle down to 0.05°.
//
// The angle is the text lines' tilt counter-clockwise as seen on screen (y down): a line rising to
// the right is positive, so `rotateBilinear(img, −θ)` straightens it. Shears are integers (Q16
// tangents from the deterministic sin/cos), scores exact integers in doubles.

import { sinCosDeg } from './geometry'

export const SKEW_SWEEP_DEG = 7
export const SKEW_STEP_DEG = 1
export const SKEW_PRECISION_DEG = 0.05
/** Apply deskew only for 0.1° ≤ |θ| ≤ 7° and at least this score confidence (§3.4.5). */
export const SKEW_MIN_DEG = 0.1
export const SKEW_MIN_CONF = 3

export interface SkewResult {
  /** Counter-clockwise tilt of the text lines, degrees, rounded to 0.01. */
  deg: number
  /** max sweep score / min sweep score (0 when there is no ink). */
  conf: number
  /** The best row-profile sharpness found (at `deg`). */
  score: number
  /** Deskew should run: SKEW_MIN_DEG ≤ |deg| ≤ SKEW_SWEEP_DEG and conf ≥ SKEW_MIN_CONF. */
  apply: boolean
}

/** Ink pixel coordinates of a binary mask, as parallel arrays (the sweep only visits ink). */
function inkPoints(mask: Uint8Array, w: number): { xs: Int32Array; ys: Int32Array } {
  let n = 0
  for (let i = 0; i < mask.length; i++) n += mask[i]
  const xs = new Int32Array(n)
  const ys = new Int32Array(n)
  let k = 0
  for (let i = 0; i < mask.length; i++)
    if (mask[i]) {
      const y = (i / w) | 0
      xs[k] = i - y * w
      ys[k] = y
      k++
    }
  return { xs, ys }
}

/** Score of the row profile after shearing the ink by `deg`. */
function score(xs: Int32Array, ys: Int32Array, w: number, h: number, deg: number): number {
  const { sin, cos } = sinCosDeg(deg)
  const tq = Math.round((sin / cos) * 65536)
  // A line y = y0 − x·tan θ lies flat after y' = y + x·tan a when a = θ.
  const maxShift = Math.ceil((w * (tq < 0 ? -tq : tq)) / 65536) + 1
  const rows = new Float64Array(h + 2 * maxShift)
  for (let k = 0; k < xs.length; k++) {
    const dy = Math.floor((xs[k] * tq + 32768) / 65536)
    rows[ys[k] + dy + maxShift]++
  }
  let s = 0
  for (let i = 1; i < rows.length; i++) {
    const d = rows[i] - rows[i - 1]
    s += d * d
  }
  return s
}

/** Find the skew of the 1/4-scale binary mask `mask` (`w × h`, 1 = ink). */
export function findSkew(mask: Uint8Array, w: number, h: number): SkewResult {
  const { xs, ys } = inkPoints(mask, w)
  if (xs.length === 0) return { deg: 0, conf: 0, score: 0, apply: false }
  let best = 0
  let bestScore = -1
  let minScore = Infinity
  for (let a = -SKEW_SWEEP_DEG; a <= SKEW_SWEEP_DEG; a += SKEW_STEP_DEG) {
    const s = score(xs, ys, w, h, a)
    if (s > bestScore) {
      bestScore = s
      best = a
    }
    if (s < minScore) minScore = s
  }
  // Halving search around the sweep's best angle.
  let center = best
  let centerScore = bestScore
  // 0.5, 0.25, 0.125, 0.0625, 0.03125: the last step brings the error under 0.05°.
  for (let delta = SKEW_STEP_DEG / 2; delta > SKEW_PRECISION_DEG / 2; delta /= 2) {
    const lo = score(xs, ys, w, h, center - delta)
    const hi = score(xs, ys, w, h, center + delta)
    if (lo > centerScore && lo >= hi) {
      center -= delta
      centerScore = lo
    } else if (hi > centerScore) {
      center += delta
      centerScore = hi
    }
  }
  const deg = Math.round(center * 100) / 100
  const conf = minScore > 0 ? bestScore / minScore : 0
  const mag = deg < 0 ? -deg : deg
  return {
    deg,
    conf,
    score: centerScore,
    apply: mag >= SKEW_MIN_DEG && mag <= SKEW_SWEEP_DEG && conf >= SKEW_MIN_CONF
  }
}
