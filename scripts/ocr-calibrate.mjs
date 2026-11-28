// `node scripts/ocr-calibrate.mjs [--seeds 1,2,3] [--presets a,b] [--fonts helvetica,times]
// [--threads 4] [--report out.json]`: refit the confidence calibration (DESIGN.md §3.4.6).
//
// Runs src/main/ocr/process/calibrate.ocr.test.ts (the `ocr` vitest project, skipped unless
// PDFX_OCR_CALIBRATE=1): the synthetic sweep of seeds × presets × fonts through the real engine
// and the whole PR6 pipeline, an isotonic fit of P(word correct | raw conf), written as 21 points
// to src/shared/ocr/calibration/tess-simd.json with the fit's counts, its expected
// calibration error, the UI thresholds read off the curve and the font-size factor sweep.
//
// The maintainers' real corpus (§3.9.1) is picked up from bench/ocr-real/manifest.json when it
// exists (it does not yet): `[{ "pdf": "bench/ocr-real/x.pdf", "gt": "bench/ocr-real/x.gt.json",
// "kind": "scan" | "photo" }]`, gt in the synth gt.json shape; `--real-weight 5` sets the weight
// of its words against the synthetic ones.
//
// `--check` refits into a temporary file instead and exits 1 unless it is byte-identical to the
// committed table: the fit is deterministic (the sweep's own gates read a fixed table, never the
// one being refitted; calibrate.ocr.test.ts), so a reviewer can rerun it with the committed seeds,
// e.g. `node scripts/ocr-calibrate.mjs --seeds 1,2,3,4,5 --threads 4 --check`.
//
// Cross-platform on purpose (no shell env syntax): it only sets the variables and runs vitest.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const TABLE = 'src/shared/ocr/calibration/tess-simd.json'
const check = args.includes('--check')
const tmp = check ? mkdtempSync(join(tmpdir(), 'pdfx-ocr-cal-')) : null
const out = tmp ? join(tmp, 'tess-simd.json') : TABLE
const env = { ...process.env, PDFX_OCR_CALIBRATE: '1' }
if (tmp) env.PDFX_OCR_CAL_OUT = out
for (const [flag, name] of [
  ['seeds', 'PDFX_OCR_CAL_SEEDS'],
  ['presets', 'PDFX_OCR_CAL_PRESETS'],
  ['fonts', 'PDFX_OCR_CAL_FONTS'],
  ['threads', 'PDFX_OCR_CAL_THREADS'],
  ['real-weight', 'PDFX_OCR_CAL_REAL_WEIGHT'],
  ['report', 'PDFX_OCR_REPORT']
]) {
  const v = opt(flag)
  if (v !== undefined) env[name] = v
}

const root = fileURLToPath(new URL('..', import.meta.url))
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const r = spawnSync(
  process.execPath,
  [vitest, 'run', '--project', 'ocr', 'src/main/ocr/process/calibrate.ocr.test.ts'],
  { stdio: 'inherit', env, cwd: root }
)
if (r.status !== 0) process.exit(r.status ?? 1)

// The table is JSON in the repo, so it must pass `prettier --check .` (CI's lint). The temporary
// file is formatted with the repo's config too (prettier resolves it from the file's own path, so
// it is passed explicitly) so that --check compares like with like.
const prettier = fileURLToPath(
  new URL('../node_modules/prettier/bin/prettier.cjs', import.meta.url)
)
const p = spawnSync(
  process.execPath,
  [prettier, '--write', '--log-level', 'warn', '--config', join(root, '.prettierrc.yaml'), out],
  { stdio: 'inherit', cwd: root }
)
if (p.status !== 0 || !tmp) process.exit(p.status ?? 1)
const same = readFileSync(out).equals(readFileSync(join(root, TABLE)))
console.log(same ? `${TABLE}: the refit is byte-identical` : `${TABLE}: the refit DIFFERS (${out})`)
if (same) rmSync(tmp, { recursive: true, force: true })
process.exit(same ? 0 : 1)
