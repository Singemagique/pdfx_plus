// The NSIS size gate (scripts/ocr-nsis-size.mjs → nsis-size.ts): the rule at its edge, and the CLI
// on a fake dist/ in a temp directory.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { MAX_GROWTH_BYTES, V113_INSTALLER_BYTES, sizeVerdict } from './nsis-size'

const at = (growth: number): { name: string; bytes: number }[] => [
  { name: 'pdfx-1.1.4-setup.exe', bytes: V113_INSTALLER_BYTES + growth }
]

describe('the NSIS size gate', () => {
  it('passes up to exactly +15 MB and fails one byte over', () => {
    expect(MAX_GROWTH_BYTES).toBe(15_000_000)
    expect(sizeVerdict(at(8_175_360)).ok).toBe(true)
    expect(sizeVerdict(at(-1_000)).ok).toBe(true)
    expect(sizeVerdict(at(MAX_GROWTH_BYTES)).ok).toBe(true)
    const over = sizeVerdict(at(MAX_GROWTH_BYTES + 1))
    expect(over.ok).toBe(false)
    expect(over.line).toBe(
      '- **NSIS size gate**: FAIL: pdfx-1.1.4-setup.exe is 118,070,740 B, +15,000,001 B ' +
        "(+15.00 MB) over v1.1.3's 103,070,739 B; the gate is +15.00 MB"
    )
    expect(sizeVerdict(at(-1_000)).line).toContain('-1,000 B (-0.00 MB)')
  })

  it('fails unless there is exactly one installer', () => {
    expect(sizeVerdict([]).ok).toBe(false)
    expect(sizeVerdict([...at(0), { name: 'old-setup.exe', bytes: 1 }]).ok).toBe(false)
    expect(sizeVerdict([]).line).toContain('expected exactly one dist/*-setup.exe, found []')
  })

  it('the CLI exits 1 over the gate and 0 within it (fake dist/)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdfx-nsis-'))
    try {
      mkdirSync(join(dir, 'dist'))
      const exe = join(dir, 'dist', 'pdfx-1.1.4-setup.exe')
      const script = fileURLToPath(
        new URL('../../../../scripts/ocr-nsis-size.mjs', import.meta.url)
      )
      const cli = (): { status: number | null; stdout: string } =>
        spawnSync(process.execPath, [script], {
          cwd: dir,
          encoding: 'utf8',
          env: { ...process.env, GITHUB_STEP_SUMMARY: '' }
        })
      writeFileSync(exe, '')
      truncateSync(exe, V113_INSTALLER_BYTES + MAX_GROWTH_BYTES + 1) // zeros, no data written
      const over = cli()
      expect(over.status).toBe(1)
      expect(over.stdout).toContain('FAIL')
      truncateSync(exe, V113_INSTALLER_BYTES + MAX_GROWTH_BYTES)
      expect(cli().status).toBe(0)
      rmSync(exe)
      expect(cli().status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
