// `node scripts/ocr-nsis-size.mjs`: the NSIS size gate (DESIGN.md §3.9.3 1c, §3.9.4): the Windows
// installer electron-builder just wrote to dist/ may grow by at most 15 MB (15,000,000 bytes) over
// the v1.1.3 installer, 103,070,739 bytes. PR0b measured +7,938,494 B with the four bundled
// languages. Prints the numbers (and adds them to $GITHUB_STEP_SUMMARY); exits 1 over the gate.

import { appendFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const V113_INSTALLER_BYTES = 103_070_739
export const MAX_GROWTH_BYTES = 15_000_000

const installers = readdirSync('dist').filter((f) => f.endsWith('-setup.exe'))
if (installers.length !== 1) {
  console.error(`expected exactly one dist/*-setup.exe, found ${JSON.stringify(installers)}`)
  process.exit(1)
}
const bytes = statSync(join('dist', installers[0])).size
const growth = bytes - V113_INSTALLER_BYTES
const ok = growth <= MAX_GROWTH_BYTES
const mb = (b) => (b / 1e6).toFixed(2)
const line =
  `- **NSIS size gate**: ${ok ? 'pass' : 'FAIL'}: ${installers[0]} is ${bytes.toLocaleString('en-US')} B, ` +
  `${growth >= 0 ? '+' : ''}${growth.toLocaleString('en-US')} B (${growth >= 0 ? '+' : ''}${mb(growth)} MB) ` +
  `over v1.1.3's ${V113_INSTALLER_BYTES.toLocaleString('en-US')} B; the gate is +${mb(MAX_GROWTH_BYTES)} MB`
console.log(line)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n')
process.exit(ok ? 0 : 1)
