// `node scripts/ocr-nsis-size.mjs`: the NSIS size gate (DESIGN.md §3.9.3 1c, §3.9.4): the Windows
// installer electron-builder just wrote to dist/ may grow by at most 15 MB over the v1.1.3
// installer. Prints the numbers (and adds them to $GITHUB_STEP_SUMMARY); exits 1 over the gate.
// The rule is src/main/ocr/ci/nsis-size.ts (node-tested in nsis-size.node.test.ts); this file only
// lists dist/.

import { appendFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { sizeVerdict } from '../src/main/ocr/ci/nsis-size.ts'

const installers = (existsSync('dist') ? readdirSync('dist') : [])
  .filter((f) => f.endsWith('-setup.exe'))
  .map((name) => ({ name, bytes: statSync(join('dist', name)).size }))
const { ok, line } = sizeVerdict(installers)
console.log(line)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n')
process.exit(ok ? 0 : 1)
