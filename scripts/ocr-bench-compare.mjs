// `node scripts/ocr-bench-compare.mjs <sweep.json> <out-dir>`: compare the nightly sweep's scores
// (src/main/ocr/process/bench.ocr.test.ts, DESIGN.md §3.9.3 tier 2) with bench/ocr-real-baseline.json
// when that file exists. Scores only, never data. The rule (CER / WER ≤ baseline × 1.15 + 0.2 pp;
// recall, hit-on-target and hmean ≥ baseline − 2 pp; a missing entry or metric is a regression) is
// src/main/ocr/ci/bench-compare.ts, node-tested in bench-compare.node.test.ts. Exits 1 on any
// regression. Without a baseline it writes <out-dir>/ocr-real-baseline.candidate.json from this run
// (a maintainer reviews it and commits it as bench/ocr-real-baseline.json to start ratcheting) and
// exits 0. PDFX_OCR_REAL_BASELINE names another baseline file (the CLI test's fixture).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { compareScores, currentScores } from '../src/main/ocr/ci/bench-compare.ts'

const [sweepPath, outDir] = process.argv.slice(2)
if (!sweepPath || !outDir) {
  console.error('usage: ocr-bench-compare.mjs <sweep.json> <out-dir>')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })
const BASELINE = process.env.PDFX_OCR_REAL_BASELINE || 'bench/ocr-real-baseline.json'
const sweep = JSON.parse(readFileSync(sweepPath, 'utf8'))
const current = currentScores(sweep)

const lines = []
let ok = true
if (!existsSync(BASELINE)) {
  const candidate = {
    note:
      'Tier-2 OCR scores (DESIGN.md §3.9.3), means over the nightly sweep; scores only. ' +
      `Seeds ${JSON.stringify(sweep.seeds)}, fonts ${JSON.stringify(sweep.fonts)}. Ratchet by hand.`,
    ...current
  }
  writeFileSync(
    join(outDir, 'ocr-real-baseline.candidate.json'),
    JSON.stringify(candidate, null, 2) + '\n'
  )
  lines.push(
    `- **${BASELINE}** does not exist yet: nothing to compare. This run's scores are in the ` +
      '`ocr-real-baseline.candidate.json` artifact for a maintainer to review and commit.'
  )
} else {
  const regressions = compareScores(current, JSON.parse(readFileSync(BASELINE, 'utf8')))
  ok = regressions.length === 0
  lines.push(
    `- **vs ${BASELINE}**: ${ok ? 'no regression' : `${regressions.length} regression(s)`}`,
    ...regressions.map((r) => `  - ${r}`)
  )
}
writeFileSync(join(outDir, 'compare.json'), JSON.stringify({ ok, current, lines }, null, 2) + '\n')
const md = lines.join('\n') + '\n'
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md)
console.log(md)
process.exit(ok ? 0 : 1)
