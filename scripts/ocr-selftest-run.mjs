// `node scripts/ocr-selftest-run.mjs <results-dir> <mode>`: run the PACKAGED app's OCR self-test
// (`pdfx --ocr-selftest <out.json>`, DESIGN.md §3.9.3 tier 1c) from electron-builder's unpacked
// output in dist/, and fail unless it passed:
//   exit code 0; the clean300 page matches the recorded replay exactly (digest and text); every
//   tripwire counter 0 and every stub intact; 0 bytes on the utility process's stdout/stderr; the
//   crash phase detected the crashed child and respawned it; the Ctrl/Cmd+Shift+R check (REQUIRED on
//   every OS: Cmd+Shift+R on macOS, Ctrl+Shift+R elsewhere) passed with exactly one 'recognize-text'
//   send on pdfx:menu.
//
// Modes:
//   direct   run the executable (Windows, macOS)
//   xvfb     xvfb-run -a (Linux)
//   unshare  Linux with NO network at all, the recipe exactly as PR0b ran it (§3.9.3 1c): a
//            root-created network namespace, back to the runner user with HOME, PATH and
//            PDFX_USER_DATA passed explicitly (sudo resets the environment), Xvfb started inside
//            the namespace (no DISPLAY passed). `ip -o link` runs inside that same namespace just
//            before the app is exec'd in it, and the run fails unless it lists only `lo`. Needs
//            xvfb, xauth, iproute2 and the setuid chrome-sandbox (root:root 4755), as the deb's
//            after-install sets it.
//
// The command and every check are src/main/ocr/ci/selftest-verdict.ts (erasable TypeScript: Node 24
// runs it as is; node-tested in selftest-verdict.node.test.ts). This file is the fs/spawn wrapper.
//
// Every run gets a fresh PDFX_USER_DATA directory. Writes <results-dir>/selftest-<mode>.json (the
// app's report) and selftest-<mode>.run.json (this script's verdict, command, timings and, on
// Linux, /proc/sys/kernel/core_pattern for R23), and a line to $GITHUB_STEP_SUMMARY.

import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  SELFTEST_MODES,
  selftestCommand,
  selftestProblems
} from '../src/main/ocr/ci/selftest-verdict.ts'

const [resultsArg, mode = 'direct'] = process.argv.slice(2)
if (!resultsArg || !SELFTEST_MODES.includes(mode)) {
  console.error(`usage: ocr-selftest-run.mjs <results-dir> <${SELFTEST_MODES.join('|')}>`)
  process.exit(2)
}
const results = resolve(resultsArg)
mkdirSync(results, { recursive: true })
const dist = resolve('dist')

function findExe() {
  if (process.platform === 'win32') return join(dist, 'win-unpacked', 'pdfx.exe')
  if (process.platform === 'darwin') {
    const d = readdirSync(dist).find((x) => x.startsWith('mac') && !x.includes('.'))
    if (!d) throw new Error('no dist/mac*/ directory')
    const app = readdirSync(join(dist, d)).find((x) => x.endsWith('.app'))
    const macos = join(dist, d, app, 'Contents', 'MacOS')
    return join(macos, readdirSync(macos)[0])
  }
  return join(dist, 'linux-unpacked', 'pdfx')
}

const exe = findExe()
if (!existsSync(exe)) {
  console.error(`packaged app not found: ${exe}`)
  process.exit(2)
}
const userData = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), `pdfx-selftest-${mode}-`))
const out = join(results, `selftest-${mode}.json`)
const netnsFile = join(results, `selftest-${mode}.netns.txt`)
const run = { mode, platform: process.platform, exe, userData }

const { cmd, args } = selftestCommand(mode, {
  exe,
  out,
  user: process.env.USER || 'runner',
  home: process.env.HOME,
  path: process.env.PATH,
  userData,
  netnsFile
})
if (process.platform === 'linux') {
  try {
    run.corePattern = readFileSync('/proc/sys/kernel/core_pattern', 'utf8').trim()
  } catch (e) {
    run.corePattern = `unreadable: ${e}`
  }
}
run.command = [cmd, ...args].join(' ')

const env = { ...process.env, PDFX_USER_DATA: userData }
delete env.ELECTRON_ENABLE_LOGGING // it would put Chromium's own logging on the pipes we count
const t0 = Date.now()
const r = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: 420_000, maxBuffer: 64 * 2 ** 20 })
run.wallMs = Date.now() - t0
run.exitStatus = r.status
run.signal = r.signal
run.spawnError = r.error ? String(r.error) : null
run.stdoutTail = (r.stdout ?? '').slice(-4000)
run.stderrTail = (r.stderr ?? '').slice(-6000)
if (mode === 'unshare') {
  // Written by the probe inside the app's own namespace (selftest-verdict.ts NETNS_PROBE).
  run.netnsLinks = existsSync(netnsFile) ? readFileSync(netnsFile, 'utf8').trim() : null
}

const report = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null
const problems = selftestProblems(report, {
  mode,
  exitStatus: r.status,
  signal: r.signal,
  netnsLinks: run.netnsLinks
})

run.ok = problems.length === 0
run.problems = problems
run.summary = report && {
  timingsMs: report.timingsMs,
  totalMs: report.totalMs,
  words: report.page?.words,
  digestMatches: report.page?.digestMatches,
  textMatches: report.page?.textMatches,
  tripwire: report.heartbeat?.tripwire,
  stdio: report.child?.stdio,
  shortcut: report.shortcut && {
    status: report.shortcut.status,
    message: report.shortcut.message,
    sends: report.shortcut.sends,
    wrongModifierSends: report.shortcut.wrongModifierSends,
    keyDowns: report.shortcut.keyDowns,
    menuItem: report.shortcut.menuItem
  },
  crashPhase: report.crashPhase && {
    ok: report.crashPhase.ok,
    firstExit: report.crashPhase.firstExit,
    detectMs: report.crashPhase.detectMs,
    totalMs: report.crashPhase.totalMs
  },
  app: report.app
}
writeFileSync(join(results, `selftest-${mode}.run.json`), JSON.stringify(run, null, 2) + '\n')

const s = run.summary
const line =
  `- **OCR self-test (${process.platform}, ${mode})**: ${run.ok ? 'pass' : 'FAIL'} in ${run.wallMs} ms` +
  (s
    ? ` · replay ${s.digestMatches && s.textMatches ? 'exact' : 'DIFFERS'} (${s.words} words)` +
      ` · tripwire ${JSON.stringify(s.tripwire)} · stdio ${s.stdio?.bytes ?? '?'} B` +
      ` · crash phase ${s.crashPhase?.ok ? `ok (${s.crashPhase.firstExit?.reason}, detected in ${s.crashPhase.detectMs} ms)` : 'FAIL'}` +
      ` · shortcut ${s.shortcut?.status} (${s.shortcut?.sends ?? '?'} send(s)): ${s.shortcut?.message}`
    : '') +
  (mode === 'unshare' ? ` · app namespace links \`${run.netnsLinks ?? '(none recorded)'}\`` : '') +
  (run.corePattern ? ` · core_pattern \`${run.corePattern}\`` : '') +
  (problems.length ? `\n  - ${problems.join('\n  - ')}` : '')
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n')
console.log(line)
if (!run.ok) {
  console.log('--- app stdout (tail) ---\n' + run.stdoutTail)
  console.log('--- app stderr (tail) ---\n' + run.stderrTail)
}
process.exit(run.ok ? 0 : 1)
