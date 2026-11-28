// `yarn ocr:record`: regenerate the OCR replay cache (src/shared/ocr/test-utils/ocr-cache/v1/),
// its CACHE_INFO.json and the packaged self-test's expected result by running the tier-1 `ocr`
// vitest project in record mode (DESIGN.md §3.9.3). Pass `--baseline` to also rewrite
// bench/ocr-baseline.json from this run's scores (the baseline is otherwise ratcheted by hand).
//
// Cross-platform on purpose (no shell env syntax): it only sets the variables and runs vitest.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const env = { ...process.env, PDFX_OCR_RECORD: '1' }
if (process.argv.includes('--baseline')) env.PDFX_OCR_WRITE_BASELINE = '1'
const r = spawnSync(process.execPath, [vitest, 'run', '--project', 'ocr'], {
  stdio: 'inherit',
  env
})
if (r.status !== 0) process.exit(r.status ?? 1)

// The recordings are JSON in the repo, so they must pass `prettier --check .` (CI's lint).
const prettier = fileURLToPath(
  new URL('../node_modules/prettier/bin/prettier.cjs', import.meta.url)
)
const p = spawnSync(
  process.execPath,
  [
    prettier,
    '--write',
    '--log-level',
    'warn',
    'src/shared/ocr/test-utils/ocr-cache/v1',
    'src/main/ocr/selftest-clean300.json',
    'bench/ocr-baseline.json'
  ],
  { stdio: 'inherit', cwd: fileURLToPath(new URL('..', import.meta.url)) }
)
process.exit(p.status ?? 1)
