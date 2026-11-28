// The nightly OCR bench's ratchet (DESIGN.md §3.9.3 tier 2): compare a sweep's scores
// (src/main/ocr/process/bench.ocr.test.ts) with bench/ocr-real-baseline.json. Scores only, never
// data: the baseline holds per-preset (and per real-corpus page) means of recall, hit-on-target,
// box hmean, CER and WER. scripts/ocr-bench-compare.mjs reads the files and prints the verdict.
//
// Same rule as tier 1 (engine.ocr.test.ts): CER / WER ≤ baseline × 1.15 + 0.2 pp; recall,
// hit-on-target and hmean ≥ baseline − 2 pp. A baseline entry this run lacks, or a metric the
// baseline has and this run does not, is a regression too.
//
// Pure (no fs) and erasable TypeScript only, so Node 24 runs it directly.

export const LOWER_IS_BETTER = ['cer', 'wer'] as const
export const HIGHER_IS_BETTER = ['recall', 'hitOnTarget', 'hmean'] as const
/** CER / WER may grow to baseline × this + ABS. */
export const REL_TOLERANCE = 1.15
export const ABS_TOLERANCE = 0.002
/** Recall, hit-on-target and hmean may drop by this much (2 pp). */
export const DROP_TOLERANCE = 0.02
const EPS = 1e-9

export type Scores = Record<string, number | undefined>
export interface BenchScores {
  presets: Record<string, Scores>
  real: Record<string, Scores>
}

const METRICS = [...LOWER_IS_BETTER, ...HIGHER_IS_BETTER]

/** A metric as the sweep writes it: a number, or `{ mean }`. */
function scoresOf(p: Record<string, unknown>): Scores {
  return Object.fromEntries(
    METRICS.map((m) => {
      const v = p[m]
      const n =
        v !== null && typeof v === 'object' ? (v as { mean?: unknown }).mean : (v as unknown)
      return [m, typeof n === 'number' ? n : undefined]
    })
  )
}

/** The sweep's per-preset and per-real-page scores. */
export function currentScores(sweep: {
  presets?: Record<string, Record<string, unknown>>
  real?: { pages?: Record<string, Record<string, unknown>> }
}): BenchScores {
  const map = (o: Record<string, Record<string, unknown>> | undefined): Record<string, Scores> =>
    Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, scoresOf(v)]))
  return { presets: map(sweep.presets), real: map(sweep.real?.pages) }
}

/** Every regression of `current` against `baseline` ([] = none). */
export function compareScores(current: BenchScores, baseline: Partial<BenchScores>): string[] {
  const regressions: string[] = []
  for (const group of ['presets', 'real'] as const)
    for (const [key, b] of Object.entries(baseline[group] ?? {})) {
      const c = current[group][key]
      if (!c) {
        regressions.push(`${group}/${key}: in the baseline, not in this run`)
        continue
      }
      for (const m of LOWER_IS_BETTER) {
        const bm = b[m]
        const cm = c[m]
        if (typeof bm !== 'number') continue
        if (!(typeof cm === 'number' && cm <= bm * REL_TOLERANCE + ABS_TOLERANCE + EPS))
          regressions.push(
            `${group}/${key} ${m} ${cm} > ${bm} × ${REL_TOLERANCE} + ${ABS_TOLERANCE}`
          )
      }
      for (const m of HIGHER_IS_BETTER) {
        const bm = b[m]
        const cm = c[m]
        if (typeof bm !== 'number') continue
        if (!(typeof cm === 'number' && cm >= bm - DROP_TOLERANCE - EPS))
          regressions.push(`${group}/${key} ${m} ${cm} < ${bm} − ${DROP_TOLERANCE}`)
      }
    }
  return regressions
}
