// The packaged OCR self-test's CI verdict (DESIGN.md §3.9.3 tier 1c): the command
// scripts/ocr-selftest-run.mjs runs for each mode, and the checks it applies to the app's report.
// The script is the fs/spawn wrapper; the decisions are here so node tests can feed them failing
// reports (selftest-verdict.node.test.ts).
//
// Pure (no fs, no Electron) and erasable TypeScript only, so Node 24 runs it directly.

export type SelftestMode = 'direct' | 'xvfb' | 'unshare'
export const SELFTEST_MODES: readonly SelftestMode[] = ['direct', 'xvfb', 'unshare']

export interface SelftestCommandOptions {
  /** The packaged executable. */
  exe: string
  /** Where the app writes its report (`--ocr-selftest <out>`). */
  out: string
  /** unshare only: the runner user, its HOME and PATH (sudo resets the environment). */
  user?: string
  home?: string
  path?: string
  /** unshare only: the fresh PDFX_USER_DATA directory. */
  userData?: string
  /** unshare only: where the in-namespace `ip -o link` listing goes. */
  netnsFile?: string
}

/**
 * Inside the new namespace, as root: list the links into "$1", then exec the rest of the arguments
 * (the app's command) in that same namespace. The listing is therefore of the namespace the app
 * runs in, not a sibling one. `ip` failing leaves a line that is not a link, which fails the check.
 */
export const NETNS_PROBE =
  'ip -o link > "$1" 2>&1 || echo "ip failed: $?" >> "$1"; shift; exec "$@"'

/**
 * The command for one mode:
 * - direct: the executable (Windows, macOS);
 * - xvfb: `xvfb-run -a` (Linux);
 * - unshare: Linux with NO network, the PR0b recipe (§3.9.3 1c): a root-created network
 *   namespace, the link probe run in it, then back to the runner user with HOME, PATH and
 *   PDFX_USER_DATA passed explicitly, Xvfb started inside the namespace (no DISPLAY passed):
 *   `sudo unshare --net -- sh -c '<probe>; exec "$@"' sh <netns> sudo -u <user> env … xvfb-run -a <exe> …`.
 */
export function selftestCommand(
  mode: SelftestMode,
  o: SelftestCommandOptions
): { cmd: string; args: string[] } {
  const app = [o.exe, '--ocr-selftest', o.out]
  if (mode === 'direct') return { cmd: o.exe, args: app.slice(1) }
  if (mode === 'xvfb') return { cmd: 'xvfb-run', args: ['-a', ...app] }
  for (const k of ['user', 'home', 'path', 'userData', 'netnsFile'] as const)
    if (!o[k]) throw new Error(`unshare mode needs ${k}`)
  return {
    cmd: 'sudo',
    args: [
      'unshare',
      '--net',
      '--',
      'sh',
      '-c',
      NETNS_PROBE,
      'sh',
      o.netnsFile!,
      'sudo',
      '-u',
      o.user!,
      'env',
      `HOME=${o.home}`,
      `PATH=${o.path}`,
      `PDFX_USER_DATA=${o.userData}`,
      'xvfb-run',
      '-a',
      ...app
    ]
  }
}

/** A fresh network namespace has exactly one link, `lo` (and it is DOWN). */
export function netnsOnlyLoopback(links: string | null | undefined): boolean {
  if (typeof links !== 'string') return false
  const lines = links
    .trim()
    .split('\n')
    .filter((l) => l.trim() !== '')
  return lines.length === 1 && /^\d+: lo:/.test(lines[0])
}

/** What the script saw of the run (not the app's report). */
export interface SelftestRunFacts {
  mode: SelftestMode
  exitStatus: number | null
  signal?: string | null
  /** unshare only: the in-namespace link listing, or null when the probe wrote nothing. */
  netnsLinks?: string | null
}

const get = (o: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (v, k) => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined),
    o
  )

/**
 * Every reason the run fails ([] = pass). `report` is the app's parsed JSON (null when it wrote
 * none). The checks: exit status 0; report ok; a packaged build; the clean300 page matches its
 * recorded replay exactly (digest and text); every tripwire counter exactly 0 and every stub
 * intact; exactly 0 bytes on the utility process's stdout/stderr; the engine not loaded from the
 * asar; the crash phase ok; the shortcut check passed with exactly one send (required, no skip);
 * and in unshare mode, the app's own namespace had only `lo`.
 */
export function selftestProblems(report: unknown, run: SelftestRunFacts): string[] {
  const problems: string[] = []
  if (report === null || report === undefined) problems.push('the app wrote no report')
  if (run.exitStatus !== 0)
    problems.push(`exit status ${run.exitStatus}${run.signal ? ` (signal ${run.signal})` : ''}`)
  if (report !== null && report !== undefined) {
    if (get(report, 'ok') !== true) {
      const f = get(report, 'failures')
      problems.push(`report not ok: ${Array.isArray(f) ? f.join('; ') : ''}`)
    }
    if (get(report, 'app', 'isPackaged') !== true) problems.push('not a packaged build')
    if (
      get(report, 'page', 'digestMatches') !== true ||
      get(report, 'page', 'textMatches') !== true
    )
      problems.push('the clean300 page does not match the recorded replay exactly')
    const tw = get(report, 'heartbeat', 'tripwire')
    if (get(tw, 'process') !== 0 || get(tw, 'raster') !== 0 || get(tw, 'recognize') !== 0)
      problems.push(`tripwire ${JSON.stringify(tw ?? null)}`)
    if (get(report, 'heartbeat', 'tripwireIntact') !== true)
      problems.push('a tripwire stub was replaced')
    if (get(report, 'child', 'stdio', 'bytes') !== 0)
      problems.push(
        `utility stdout/stderr ${JSON.stringify(get(report, 'child', 'stdio') ?? null)}`
      )
    if (get(report, 'app', 'ocrEngineInAsar') !== false)
      problems.push('the OCR engine was loaded from inside the asar (or not reported)')
    if (get(report, 'crashPhase', 'ok') !== true) {
      const f = get(report, 'crashPhase', 'failures')
      problems.push(`crash phase: ${(Array.isArray(f) ? f : ['no report']).join('; ')}`)
    }
    // Required on every OS: a pass with exactly one 'recognize-text' send (no skip).
    const sc = get(report, 'shortcut', 'status')
    if (sc !== 'pass')
      problems.push(`shortcut: ${String(get(report, 'shortcut', 'message') ?? 'no report')}`)
    else if (get(report, 'shortcut', 'sends') !== 1)
      problems.push(`shortcut: ${String(get(report, 'shortcut', 'sends'))} sends, expected 1`)
  }
  if (run.mode === 'unshare' && !netnsOnlyLoopback(run.netnsLinks))
    problems.push(
      `the app's network namespace is not loopback-only: ${JSON.stringify(run.netnsLinks ?? null)}`
    )
  return problems
}
