// The packaged self-test's CI verdict (scripts/ocr-selftest-run.mjs → selftest-verdict.ts): every
// check fails on its own, and the no-network run probes the namespace the app itself runs in.

import { describe, expect, it } from 'vitest'

import {
  NETNS_PROBE,
  netnsOnlyLoopback,
  selftestCommand,
  selftestProblems,
  type SelftestRunFacts
} from './selftest-verdict'

/** The shape the app writes (host.ts); optional so a case can delete a field. */
interface Fixture {
  ok: boolean
  failures: string[]
  page: { words: number; digestMatches: boolean; textMatches: boolean }
  heartbeat: {
    tripwire?: { process: number; raster: number; recognize: number }
    tripwireIntact: boolean
  }
  app: { isPackaged: boolean; ocrEngineInAsar: boolean }
  child: { stdio?: { bytes: number; lines: number } }
  crashPhase?: { ok: boolean; failures: string[] }
  shortcut?: { status: string; message: string }
}

/** A passing report. */
const passing = (): Fixture => ({
  ok: true,
  failures: [],
  page: { words: 116, digestMatches: true, textMatches: true },
  heartbeat: { tripwire: { process: 0, raster: 0, recognize: 0 }, tripwireIntact: true },
  app: { isPackaged: true, ocrEngineInAsar: false },
  child: { stdio: { bytes: 0, lines: 0 } },
  crashPhase: { ok: true, failures: [] },
  shortcut: { status: 'skipped', message: 'no handler on this branch' }
})
const LO = '1: lo: <LOOPBACK> mtu 65536 qdisc noop state DOWN mode DEFAULT group default qlen 1000'
const ok = (over: Partial<SelftestRunFacts> = {}): SelftestRunFacts => ({
  mode: 'direct',
  exitStatus: 0,
  signal: null,
  ...over
})

describe('the packaged OCR self-test verdict', () => {
  it('passes a clean report (shortcut passed or skipped), in every mode', () => {
    expect(selftestProblems(passing(), ok())).toEqual([])
    const sc = passing()
    sc.shortcut = { status: 'pass', message: 'reached the renderer once' }
    expect(selftestProblems(sc, ok({ mode: 'xvfb' }))).toEqual([])
    expect(selftestProblems(passing(), ok({ mode: 'unshare', netnsLinks: LO }))).toEqual([])
  })

  // One mutation per check: each must fail on its own, with its own message.
  const cases: Array<[string, (r: Fixture) => void, RegExp]> = [
    ['report not ok', (r) => ((r.ok = false), (r.failures = ['x'])), /^report not ok: x$/],
    ['not packaged', (r) => (r.app.isPackaged = false), /^not a packaged build$/],
    ['digest differs', (r) => (r.page.digestMatches = false), /recorded replay exactly/],
    ['text differs', (r) => (r.page.textMatches = false), /recorded replay exactly/],
    ['process wire', (r) => (r.heartbeat.tripwire!.process = 1), /^tripwire /],
    ['raster wire', (r) => (r.heartbeat.tripwire!.raster = 1), /^tripwire /],
    ['recognize wire', (r) => (r.heartbeat.tripwire!.recognize = 2), /^tripwire /],
    ['no tripwire', (r) => delete r.heartbeat.tripwire, /^tripwire null$/],
    ['stub replaced', (r) => (r.heartbeat.tripwireIntact = false), /stub was replaced/],
    ['stdio bytes', (r) => (r.child.stdio!.bytes = 1), /^utility stdout\/stderr /],
    ['stdio missing', (r) => delete r.child.stdio, /^utility stdout\/stderr null$/],
    ['engine in asar', (r) => (r.app.ocrEngineInAsar = true), /inside the asar/],
    [
      'crash phase',
      (r) => (r.crashPhase = { ok: false, failures: ['a', 'b'] }),
      /^crash phase: a; b$/
    ],
    ['no crash phase', (r) => delete r.crashPhase, /^crash phase: no report$/],
    [
      'shortcut fail',
      (r) => (r.shortcut = { status: 'fail', message: 'sent twice' }),
      /^shortcut: sent twice$/
    ],
    ['no shortcut', (r) => delete r.shortcut, /^shortcut: no report$/]
  ]
  it.each(cases)('fails on: %s', (_name, mutate, message) => {
    const r = passing()
    mutate(r)
    const p = selftestProblems(r, ok())
    expect(p).toHaveLength(1)
    expect(p[0]).toMatch(message)
  })

  it('fails on a missing report, a non-zero exit and a signal', () => {
    expect(selftestProblems(null, ok({ exitStatus: 1 }))).toEqual([
      'the app wrote no report',
      'exit status 1'
    ])
    expect(selftestProblems(passing(), ok({ exitStatus: null, signal: 'SIGKILL' }))).toEqual([
      'exit status null (signal SIGKILL)'
    ])
  })

  it('the no-network run fails unless the app namespace listed only lo', () => {
    const un = (links: string | null): string[] =>
      selftestProblems(passing(), ok({ mode: 'unshare', netnsLinks: links }))
    expect(un(LO)).toEqual([])
    expect(un(`${LO}\n`)).toEqual([])
    for (const bad of [
      null, // the probe wrote nothing: not the recipe that ran
      '',
      `${LO}\n2: eth0: <BROADCAST,MULTICAST,UP> mtu 1500 state UP`,
      '2: eth0: <BROADCAST> mtu 1500',
      `${LO}\nip failed: 127`,
      'ip failed: 1'
    ])
      expect(un(bad)).toEqual([
        `the app's network namespace is not loopback-only: ${JSON.stringify(bad)}`
      ])
    // Only the unshare mode looks at it.
    expect(selftestProblems(passing(), ok({ mode: 'xvfb', netnsLinks: null }))).toEqual([])
    expect(netnsOnlyLoopback(undefined)).toBe(false)
  })
})

describe('the self-test command', () => {
  const o = {
    exe: '/w/dist/linux-unpacked/pdfx',
    out: '/t/selftest-unshare.json',
    user: 'runner',
    home: '/home/runner',
    path: '/usr/bin:/bin',
    userData: '/t/ud',
    netnsFile: '/t/selftest-unshare.netns.txt'
  }

  it('direct and xvfb run the app as is', () => {
    expect(selftestCommand('direct', o)).toEqual({
      cmd: o.exe,
      args: ['--ocr-selftest', o.out]
    })
    expect(selftestCommand('xvfb', o)).toEqual({
      cmd: 'xvfb-run',
      args: ['-a', o.exe, '--ocr-selftest', o.out]
    })
  })

  it('unshare probes the links and execs the app inside ONE network namespace', () => {
    const { cmd, args } = selftestCommand('unshare', o)
    expect(cmd).toBe('sudo')
    expect(args).toEqual([
      'unshare',
      '--net',
      '--',
      'sh',
      '-c',
      NETNS_PROBE,
      'sh',
      o.netnsFile,
      'sudo',
      '-u',
      'runner',
      'env',
      'HOME=/home/runner',
      'PATH=/usr/bin:/bin',
      'PDFX_USER_DATA=/t/ud',
      'xvfb-run',
      '-a',
      o.exe,
      '--ocr-selftest',
      o.out
    ])
    // A single unshare, and the app is exec'd by the probe's shell (same namespace), last.
    expect(args.filter((a) => a === 'unshare')).toHaveLength(1)
    expect(NETNS_PROBE).toMatch(/^ip -o link > "\$1" .*; shift; exec "\$@"$/)
    expect(args.indexOf(o.exe)).toBeGreaterThan(args.indexOf(NETNS_PROBE))
  })

  it('unshare refuses to build a command without the pieces sudo would drop', () => {
    expect(() => selftestCommand('unshare', { ...o, netnsFile: undefined })).toThrow(/netnsFile/)
    expect(() => selftestCommand('unshare', { ...o, home: undefined })).toThrow(/home/)
  })
})
