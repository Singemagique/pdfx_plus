// Tier 1b (DESIGN.md §3.9.3, §3.9.5): compare the three OSes' tier-1 outputs. The `ocr-diff` CI job
// runs this through scripts/ocr-xos-diff.mjs on the artifacts the build matrix uploads: the
// per-case records test-utils/xos-dump.ts writes, and vitest's JSON report of the same run. Any
// difference fails: text, boxes, the engine's hOCR, the input pixels, anything else in a record, a
// case one OS has and another lacks, a test that passed on one OS and not on another, or fewer
// cases than the caller's floor (`minCases`: the same records lost on every OS). The gate
// stays strict (R11): a divergence is a bug to root-cause, never a tolerance to add.
//
// Pure (no fs, no Electron) and erasable TypeScript only, so Node 24 runs it directly.

/** One case's record, as xos-dump.ts writes it (parsed JSON). */
export type XosCase = Record<string, unknown>

/** One OS's outputs: `suite/id` → record, and vitest's per-test statuses. */
export interface XosRun {
  cases: Record<string, XosCase>
  /** Test full name → status ('passed', 'failed', 'skipped', …), from vitest's JSON reporter. */
  tests: Record<string, string>
}

export type XosDiffKind =
  | 'text'
  | 'boxes'
  | 'engine'
  | 'inputs'
  | 'meta'
  | 'missing-case'
  | 'test-status'
  | 'no-output'
  | 'too-few-cases'

export interface XosDifference {
  kind: XosDiffKind
  /** `suite/id` for a case, the test's full name for a status. */
  key: string
  /** What each OS had there (a short excerpt for long values). */
  byOs: Record<string, string>
  /** For boxes: the first differing word row. */
  at?: number
}

export interface XosDiffReport {
  ok: boolean
  oses: string[]
  cases: number
  tests: number
  /** Cases each OS produced (a run that produced none fails as `no-output`). */
  casesByOs: Record<string, number>
  differences: XosDifference[]
}

const KNOWN = new Set(['text', 'boxes', 'engine', 'inputs'])

function excerpt(v: unknown, max = 160): string {
  const s = v === undefined ? '(absent)' : typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s
}

/** The first index where two arrays (compared by their JSON) differ, or -1. */
function firstDiff(a: unknown, b: unknown): number {
  const x = Array.isArray(a) ? a : []
  const y = Array.isArray(b) ? b : []
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) if (JSON.stringify(x[i]) !== JSON.stringify(y[i])) return i
  return -1
}

/** For a string field, the first differing line of the first OS that disagrees with the first. */
function firstLineDiff(values: Record<string, unknown>): Record<string, string> {
  const oses = Object.keys(values)
  const lines = oses.map((o) => String(values[o] ?? '').split('\n'))
  const n = Math.max(...lines.map((l) => l.length))
  for (let i = 0; i < n; i++) {
    const row = lines.map((l) => l[i])
    if (row.some((r) => r !== row[0]))
      return Object.fromEntries(oses.map((o, k) => [o, `line ${i + 1}: ${excerpt(row[k])}`]))
  }
  return Object.fromEntries(oses.map((o) => [o, excerpt(values[o])]))
}

export interface XosDiffOptions {
  /**
   * The fewest cases each OS must have produced. Without a floor, records lost the same way on
   * every OS (a dump that stopped writing, a suite that stopped running) would compare as
   * identical; CI passes today's count, lowered only by the change that removes cases.
   */
  minCases?: number
}

/**
 * Compare every OS's run against every other's. `runs` is keyed by OS (e.g. the artifact name's
 * suffix); the report lists every difference, grouped by kind.
 */
export function diffXos(runs: Record<string, XosRun>, opts: XosDiffOptions = {}): XosDiffReport {
  const oses = Object.keys(runs).sort()
  const differences: XosDifference[] = []
  const casesByOs = Object.fromEntries(oses.map((o) => [o, Object.keys(runs[o].cases).length]))
  const minCases = opts.minCases ?? 0
  for (const o of oses)
    if (casesByOs[o] === 0)
      differences.push({ kind: 'no-output', key: o, byOs: { [o]: 'no tier-1 records' } })
    else if (casesByOs[o] < minCases)
      differences.push({
        kind: 'too-few-cases',
        key: o,
        byOs: { [o]: `${casesByOs[o]} case(s), expected at least ${minCases}` }
      })

  const keys = [...new Set(oses.flatMap((o) => Object.keys(runs[o].cases)))].sort()
  for (const key of keys) {
    const present = oses.filter((o) => runs[o].cases[key] !== undefined)
    if (present.length !== oses.length) {
      differences.push({
        kind: 'missing-case',
        key,
        byOs: Object.fromEntries(oses.map((o) => [o, present.includes(o) ? 'present' : 'missing']))
      })
      continue
    }
    const recs = Object.fromEntries(oses.map((o) => [o, runs[o].cases[key]]))
    const fields = [...new Set(oses.flatMap((o) => Object.keys(recs[o])))].sort()
    const metaDiffs: string[] = []
    for (const f of fields) {
      const vals = Object.fromEntries(oses.map((o) => [o, recs[o][f]]))
      const json = oses.map((o) => JSON.stringify(vals[o]))
      if (json.every((j) => j === json[0])) continue
      if (f === 'text') differences.push({ kind: 'text', key, byOs: firstLineDiff(vals) })
      else if (f === 'boxes' || f === 'engine' || f === 'inputs') {
        const at = oses.slice(1).reduce((m, o) => {
          const i = firstDiff(vals[oses[0]], vals[o])
          return i >= 0 && (m < 0 || i < m) ? i : m
        }, -1)
        differences.push({
          kind: f,
          key,
          at,
          byOs: Object.fromEntries(
            oses.map((o) => [
              o,
              excerpt(Array.isArray(vals[o]) ? (vals[o] as unknown[])[at] : vals[o])
            ])
          )
        })
      } else if (!KNOWN.has(f)) metaDiffs.push(f)
    }
    if (metaDiffs.length > 0) {
      const f = metaDiffs[0]
      differences.push({
        kind: 'meta',
        key: `${key} (${metaDiffs.join(', ')})`,
        byOs: Object.fromEntries(oses.map((o) => [o, excerpt(recs[o][f])]))
      })
    }
  }

  const tests = [...new Set(oses.flatMap((o) => Object.keys(runs[o].tests)))].sort()
  for (const t of tests) {
    const st = oses.map((o) => runs[o].tests[t] ?? 'absent')
    if (st.some((s) => s !== st[0]))
      differences.push({
        kind: 'test-status',
        key: t,
        byOs: Object.fromEntries(oses.map((o, i) => [o, st[i]]))
      })
  }
  return {
    ok: differences.length === 0 && oses.length > 1,
    oses,
    cases: keys.length,
    tests: tests.length,
    casesByOs,
    differences
  }
}

/** Test full name → status, from vitest's `--reporter=json` output (Jest-compatible shape). */
export function testStatuses(report: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  const files = (report as { testResults?: unknown[] } | null)?.testResults ?? []
  for (const f of files as { name?: string; assertionResults?: unknown[] }[]) {
    // The file path is the runner's, so key by the path below src/ (the same on every OS).
    const file = String(f.name ?? '')
      .replace(/\\/g, '/')
      .replace(/^.*?\/src\//, 'src/')
    for (const a of (f.assertionResults ?? []) as { fullName?: string; status?: string }[])
      out[`${file} > ${a.fullName ?? '?'}`] = String(a.status ?? '?')
  }
  return out
}

/** The report as Markdown, for $GITHUB_STEP_SUMMARY. */
export function summaryMarkdown(r: XosDiffReport): string {
  const lines = [
    `### OCR cross-OS diff: ${r.ok ? 'identical' : `${r.differences.length} difference(s)`}`,
    '',
    `${r.cases} case(s), ${r.tests} test(s) across ${r.oses.join(', ')}.`,
    '',
    `| OS | cases |`,
    `|---|---|`,
    ...r.oses.map((o) => `| ${o} | ${r.casesByOs[o]} |`)
  ]
  if (r.differences.length > 0) {
    lines.push(
      '',
      '| kind | case | ' + r.oses.join(' | ') + ' |',
      '|---|---|' + r.oses.map(() => '---|').join('')
    )
    for (const d of r.differences.slice(0, 50))
      lines.push(
        `| ${d.kind} | ${d.key}${d.at !== undefined && d.at >= 0 ? ` @${d.at}` : ''} | ` +
          r.oses
            .map((o) => (d.byOs[o] ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' '))
            .join(' | ') +
          ' |'
      )
    if (r.differences.length > 50) lines.push('', `…and ${r.differences.length - 50} more.`)
  }
  return lines.join('\n') + '\n'
}
