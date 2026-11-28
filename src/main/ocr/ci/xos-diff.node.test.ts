import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { diffXos, summaryMarkdown, testStatuses, type XosRun } from './xos-diff'

const rec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  text: 'Hello world\nsecond line',
  boxes: [
    [10, 20, 30, 12, 0],
    [45, 20, 40, 12, 0]
  ],
  engine: ['<hocr/>'],
  inputs: ['abc'],
  meta: { orientation: 0 },
  ...over
})

const run = (cases: Record<string, Record<string, unknown>>, tests = { t: 'passed' }): XosRun => ({
  cases,
  tests
})

describe('the cross-OS OCR diff (tier 1b)', () => {
  it('passes when every OS produced the same records and statuses', () => {
    const r = diffXos({
      ubuntu: run({ 'engine/clean300': rec() }),
      windows: run({ 'engine/clean300': rec() }),
      macos: run({ 'engine/clean300': rec() })
    })
    expect(r.ok).toBe(true)
    expect(r.differences).toEqual([])
    expect(r.oses).toEqual(['macos', 'ubuntu', 'windows'])
  })

  it('names a text difference by its first differing line', () => {
    const r = diffXos({
      a: run({ 'engine/x': rec() }),
      b: run({ 'engine/x': rec({ text: 'Hello world\nsecond 1ine' }) })
    })
    expect(r.ok).toBe(false)
    expect(r.differences).toEqual([
      {
        kind: 'text',
        key: 'engine/x',
        byOs: { a: 'line 2: second line', b: 'line 2: second 1ine' }
      }
    ])
  })

  it('reports a box difference at the first differing word, down to the last bit', () => {
    const r = diffXos({
      a: run({ 'pipeline/x': rec() }),
      b: run({
        'pipeline/x': rec({
          boxes: [
            [10, 20, 30, 12, 0],
            [45, 20, 40.00000000000001, 12, 0]
          ]
        })
      })
    })
    expect(r.differences).toHaveLength(1)
    expect(r.differences[0]).toMatchObject({ kind: 'boxes', key: 'pipeline/x', at: 1 })
  })

  it('fails on engine, input and meta differences too', () => {
    const r = diffXos({
      a: run({ 'p/x': rec() }),
      b: run({
        'p/x': rec({ engine: ['<hocr />'], inputs: ['abd'], meta: { orientation: 90 } })
      })
    })
    expect(r.differences.map((d) => d.kind).sort()).toEqual(['engine', 'inputs', 'meta'])
  })

  it('fails on a case one OS lacks, and on an OS with no records at all', () => {
    const r = diffXos({
      a: run({ 'p/x': rec(), 'p/y': rec() }),
      b: run({ 'p/x': rec() }),
      c: run({})
    })
    expect(r.ok).toBe(false)
    expect(r.differences.filter((d) => d.kind === 'no-output').map((d) => d.key)).toEqual(['c'])
    expect(r.differences.find((d) => d.kind === 'missing-case' && d.key === 'p/y')?.byOs).toEqual({
      a: 'present',
      b: 'missing',
      c: 'missing'
    })
  })

  it('fails when a test passed on one OS and failed (or was absent) on another', () => {
    const r = diffXos({
      a: run({ 'p/x': rec() }, { t: 'passed' }),
      b: run({ 'p/x': rec() }, { t: 'failed' })
    })
    expect(r.differences).toEqual([
      { kind: 'test-status', key: 't', byOs: { a: 'passed', b: 'failed' } }
    ])
    expect(summaryMarkdown(r)).toContain('| test-status | t | passed | failed |')
  })

  it('a single OS is never "identical"', () => {
    expect(diffXos({ a: run({ 'p/x': rec() }) }).ok).toBe(false)
  })

  it("reads vitest's JSON report keyed by the path below src/", () => {
    const s = testStatuses({
      testResults: [
        {
          name: 'D:\\a\\pdfx_plus\\pdfx_plus\\src\\main\\ocr\\selftest.ocr.test.ts',
          assertionResults: [{ fullName: 'suite works', status: 'passed' }]
        },
        {
          name: '/home/runner/work/pdfx_plus/pdfx_plus/src/main/ocr/selftest.ocr.test.ts',
          assertionResults: [{ fullName: 'suite other', status: 'skipped' }]
        }
      ]
    })
    expect(s).toEqual({
      'src/main/ocr/selftest.ocr.test.ts > suite works': 'passed',
      'src/main/ocr/selftest.ocr.test.ts > suite other': 'skipped'
    })
  })

  it('the CLI reads the artifact layout and exits 1 on a difference or a missing OS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdfx-xos-'))
    try {
      const put = (os: string, text: string): void => {
        mkdirSync(join(dir, `ocr-xos-${os}`, 'out', 'engine'), { recursive: true })
        writeFileSync(
          join(dir, `ocr-xos-${os}`, 'out', 'engine', 'clean300.json'),
          JSON.stringify(rec({ text }))
        )
        writeFileSync(
          join(dir, `ocr-xos-${os}`, 'vitest.json'),
          JSON.stringify({
            testResults: [
              {
                name: '/x/src/a.ocr.test.ts',
                assertionResults: [{ fullName: 'a', status: 'passed' }]
              }
            ]
          })
        )
      }
      const script = fileURLToPath(new URL('../../../../scripts/ocr-xos-diff.mjs', import.meta.url))
      const cli = (...extra: string[]): { status: number | null; report: { ok: boolean } } => {
        const out = join(dir, 'report.json')
        const r = spawnSync(process.execPath, [script, dir, out, ...extra], {
          encoding: 'utf8',
          env: { ...process.env, GITHUB_STEP_SUMMARY: '' }
        })
        return { status: r.status, report: JSON.parse(readFileSync(out, 'utf8')) }
      }
      put('ubuntu-latest', 'same')
      put('windows-latest', 'same')
      expect(cli('--expect', 'ubuntu-latest,windows-latest')).toMatchObject({
        status: 0,
        report: { ok: true }
      })
      expect(cli('--expect', 'ubuntu-latest,windows-latest,macos-latest')).toMatchObject({
        status: 1,
        report: { ok: false, problems: ['macos-latest: no ocr-xos-macos-latest artifact'] }
      })
      put('macos-latest', 'differs')
      expect(cli('--expect', 'ubuntu-latest,windows-latest,macos-latest').status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
