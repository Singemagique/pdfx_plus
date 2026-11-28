// The offline confidence-calibration fit (DESIGN.md §3.4.6), pure so tier 0 tests it and the
// calibration run (scripts/ocr-calibrate.mjs → calibrate.ocr.test.ts) uses exactly this code:
// isotonic regression of "word correct" (0/1) on raw confidence by pool-adjacent-violators, then
// the fitted step function read off at 21 raw points (0, 5, …, 100) with linear interpolation
// between block centres, so the committed table is monotone and piecewise linear.

export interface LabelledConf {
  /** Raw engine confidence, 0..100. */
  conf: number
  correct: boolean
  /** Sample weight (default 1): a real-corpus word may count more than a synthetic one. */
  weight?: number
}

interface Block {
  /** Weighted mean raw confidence of the block (its x position). */
  x: number
  /** Weighted mean correctness (the fitted p). */
  p: number
  w: number
}

/**
 * Pool-adjacent-violators over samples sorted by confidence: the least-squares non-decreasing
 * fit. Equal confidences are pooled first (a step function cannot split them).
 */
export function isotonicBlocks(samples: readonly LabelledConf[]): Block[] {
  const sorted = [...samples].filter((s) => Number.isFinite(s.conf)).sort((a, b) => a.conf - b.conf)
  const blocks: Block[] = []
  for (const s of sorted) {
    const w = s.weight ?? 1
    if (!(w > 0)) continue
    const v = s.correct ? 1 : 0
    const last = blocks[blocks.length - 1]
    if (last && last.x === s.conf) {
      last.p = (last.p * last.w + v * w) / (last.w + w)
      last.w += w
    } else blocks.push({ x: s.conf, p: v, w })
    // Merge backwards while the order is violated.
    while (blocks.length > 1 && blocks[blocks.length - 2].p > blocks[blocks.length - 1].p) {
      const b = blocks.pop()!
      const a = blocks.pop()!
      const w2 = a.w + b.w
      blocks.push({ x: (a.x * a.w + b.x * b.w) / w2, p: (a.p * a.w + b.p * b.w) / w2, w: w2 })
    }
  }
  return blocks
}

/** The 21 raw anchors of the committed table. */
export const CALIBRATION_RAW = Array.from({ length: 21 }, (_, i) => i * 5)

/**
 * The 21-point table from the isotonic blocks: p at each anchor by linear interpolation between
 * block centres (flat beyond the first and last), rounded to 4 decimals, forced non-decreasing.
 */
export function tableFromBlocks(blocks: readonly Block[]): [number, number][] {
  if (blocks.length === 0) return CALIBRATION_RAW.map((r) => [r, r / 100])
  const at = (x: number): number => {
    if (x <= blocks[0].x) return blocks[0].p
    for (let i = 1; i < blocks.length; i++)
      if (x <= blocks[i].x) {
        const a = blocks[i - 1]
        const b = blocks[i]
        return a.p + ((x - a.x) / (b.x - a.x)) * (b.p - a.p)
      }
    return blocks[blocks.length - 1].p
  }
  let prev = 0
  return CALIBRATION_RAW.map((r) => {
    const p = Math.max(prev, Math.round(at(r) * 10000) / 10000)
    prev = p
    return [r, Math.min(1, p)]
  })
}

/** Fit a table from labelled confidences. */
export function fitCalibration(samples: readonly LabelledConf[]): [number, number][] {
  return tableFromBlocks(isotonicBlocks(samples))
}

/** Expected calibration error of `predict` on samples (10 equal-width bins of predicted p). */
export function expectedCalibrationError(
  samples: readonly LabelledConf[],
  predict: (raw: number) => number
): number {
  const bins = Array.from({ length: 10 }, () => ({ p: 0, y: 0, w: 0 }))
  let total = 0
  for (const s of samples) {
    const p = predict(s.conf)
    const w = s.weight ?? 1
    const b = bins[Math.min(9, Math.floor(p * 10))]
    b.p += p * w
    b.y += (s.correct ? 1 : 0) * w
    b.w += w
    total += w
  }
  let e = 0
  for (const b of bins) if (b.w > 0) e += (b.w / total) * Math.abs(b.p / b.w - b.y / b.w)
  return e
}
