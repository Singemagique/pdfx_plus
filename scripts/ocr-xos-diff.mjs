// `node scripts/ocr-xos-diff.mjs <artifacts-dir> <report.json> --expect a,b,c`: the CI `ocr-diff`
// job (DESIGN.md §3.9.3 tier 1b). <artifacts-dir> holds one `ocr-xos-<os>` folder per build-matrix
// OS (actions/download-artifact with a pattern), each with `out/<suite>/<id>.json` (the tier-1
// records, src/main/ocr/test-utils/xos-dump.ts) and `vitest.json` (the run's JSON report). Exits 1
// on any difference, or when an expected OS has no artifact. The comparison itself is
// src/main/ocr/ci/xos-diff.ts (erasable TypeScript: Node 24 runs it as is).

import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, relative } from 'node:path'

import { diffXos, summaryMarkdown, testStatuses } from '../src/main/ocr/ci/xos-diff.ts'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args.splice(i, 2)[1] : undefined
}
const expect = (flag('expect') ?? '').split(',').filter(Boolean)
const [root, out] = args
if (!root || !out) {
  console.error('usage: ocr-xos-diff.mjs <artifacts-dir> <report.json> [--expect a,b,c]')
  process.exit(2)
}

function walk(dir) {
  const files = []
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) files.push(...walk(p))
    else if (f.endsWith('.json')) files.push(p)
  }
  return files
}

const runs = {}
const problems = []
for (const d of existsSync(root) ? readdirSync(root) : []) {
  if (!d.startsWith('ocr-xos-')) continue
  const os = d.slice('ocr-xos-'.length)
  const base = join(root, d)
  const cases = {}
  const outDir = join(base, 'out')
  if (existsSync(outDir))
    for (const f of walk(outDir))
      cases[
        relative(outDir, f)
          .replace(/\\/g, '/')
          .replace(/\.json$/, '')
      ] = JSON.parse(readFileSync(f, 'utf8'))
  const vitest = join(base, 'vitest.json')
  const tests = existsSync(vitest) ? testStatuses(JSON.parse(readFileSync(vitest, 'utf8'))) : {}
  if (!existsSync(vitest)) problems.push(`${os}: no vitest.json`)
  runs[os] = { cases, tests }
}
for (const os of expect) if (!runs[os]) problems.push(`${os}: no ocr-xos-${os} artifact`)

const report = { ...diffXos(runs), problems }
report.ok =
  report.ok && problems.length === 0 && (expect.length === 0 || expect.every((o) => runs[o]))
writeFileSync(out, JSON.stringify(report, null, 2) + '\n')

let md = summaryMarkdown(report)
if (problems.length > 0) md += '\n' + problems.map((p) => `- **${p}**`).join('\n') + '\n'
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md)
console.log(md)
process.exit(report.ok ? 0 : 1)
