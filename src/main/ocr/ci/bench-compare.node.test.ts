// The tier-2 ratchet (scripts/ocr-bench-compare.mjs → bench-compare.ts): each metric's tolerance at
// its edge, missing entries and metrics, and the CLI with and without a baseline.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { compareScores, currentScores, type BenchScores } from './bench-compare'

const base = { cer: 0.01, wer: 0.05, recall: 0.99, hitOnTarget: 0.98, hmean: 0.9 }
const scores = (over: Record<string, number | undefined> = {}): BenchScores => ({
  presets: { clean300: { ...base, ...over } },
  real: {}
})
const baseline: BenchScores = { presets: { clean300: base }, real: {} }

describe('the OCR bench comparator', () => {
  it('reads plain numbers and { mean } from the sweep', () => {
    expect(
      currentScores({
        presets: { a: { cer: { mean: 0.1 }, recall: 0.9, wer: 'x' } },
        real: { pages: { p1: { hmean: { mean: 0.5 } } } }
      })
    ).toEqual({
      presets: {
        a: { cer: 0.1, wer: undefined, recall: 0.9, hitOnTarget: undefined, hmean: undefined }
      },
      real: {
        p1: {
          cer: undefined,
          wer: undefined,
          recall: undefined,
          hitOnTarget: undefined,
          hmean: 0.5
        }
      }
    })
  })

  it('accepts a run at every tolerance edge', () => {
    expect(compareScores(scores(), baseline)).toEqual([])
    expect(
      compareScores(
        scores({
          cer: 0.01 * 1.15 + 0.002,
          wer: 0.05 * 1.15 + 0.002,
          recall: 0.97,
          hitOnTarget: 0.96,
          hmean: 0.88
        }),
        baseline
      )
    ).toEqual([])
  })

  it.each([
    ['cer', 0.01 * 1.15 + 0.0021],
    ['wer', 0.05 * 1.15 + 0.0021],
    ['recall', 0.9699],
    ['hitOnTarget', 0.9599],
    ['hmean', 0.8799]
  ])('flags %s just past its tolerance', (metric, value) => {
    const r = compareScores(scores({ [metric]: value }), baseline)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatch(new RegExp(`^presets/clean300 ${metric} `))
  })

  it('a missing entry or a missing metric is a regression; extra entries are not', () => {
    expect(compareScores({ presets: {}, real: {} }, baseline)).toEqual([
      'presets/clean300: in the baseline, not in this run'
    ])
    expect(compareScores(scores({ recall: undefined, cer: undefined }), baseline)).toHaveLength(2)
    const extra = scores()
    extra.presets.photoLike = { recall: 0 }
    expect(compareScores(extra, baseline)).toEqual([])
    expect(
      compareScores({ presets: {}, real: { p: { recall: 0.5 } } }, { real: { p: { recall: 0.9 } } })
    ).toHaveLength(1)
  })

  it('the CLI writes a candidate without a baseline, and exits 1 on a regression', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdfx-bench-'))
    try {
      const script = fileURLToPath(
        new URL('../../../../scripts/ocr-bench-compare.mjs', import.meta.url)
      )
      const sweep = join(dir, 'sweep.json')
      const bl = join(dir, 'baseline.json')
      const cli = (baselinePath: string): number | null =>
        spawnSync(process.execPath, [script, sweep, join(dir, 'out')], {
          encoding: 'utf8',
          env: { ...process.env, GITHUB_STEP_SUMMARY: '', PDFX_OCR_REAL_BASELINE: baselinePath }
        }).status
      writeFileSync(sweep, JSON.stringify({ seeds: [1], fonts: ['helvetica'], ...scores() }))
      expect(cli(join(dir, 'absent.json'))).toBe(0)
      expect(existsSync(join(dir, 'out', 'ocr-real-baseline.candidate.json'))).toBe(true)
      writeFileSync(bl, JSON.stringify(baseline))
      expect(cli(bl)).toBe(0)
      writeFileSync(sweep, JSON.stringify(scores({ recall: 0.5, cer: 0.5, hmean: 0.1 })))
      expect(cli(bl)).toBe(1)
      const report = JSON.parse(readFileSync(join(dir, 'out', 'compare.json'), 'utf8'))
      expect(report.ok).toBe(false)
      expect(report.lines[0]).toContain('3 regression(s)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
