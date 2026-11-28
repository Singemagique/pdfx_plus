// The supervisor state machine with a fake child (DESIGN.md §3.3.2, §3.9.3 tier 0): spawn laziness,
// the minimal env, the alive flag, both pipes drained (a 10 MB stderr flood must not block the
// child), the PR0 Windows exit matrix filtered on details.name, killRequested, respawn backoff with
// its 3-in-60-s cap, oom halving, launch-failed as fatal, the idle kill, the power blocker and
// progress bar during a batch, teardown on window close / render-process-gone / reload, and a
// fresh port per connect.

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OCR_HEARTBEAT_INTERVAL_MS } from '../../shared/ocr/protocol'
import {
  BACKOFF_MS,
  ByteRing,
  GONE_GRACE_MS,
  IDLE_KILL_MS,
  LATE_GONE_MS,
  LIVENESS_MS,
  MAX_RESPAWNS,
  OcrSupervisor,
  RING_BYTES,
  SERVICE_NAME,
  isV8FatalOom,
  signedExitCode,
  type ChildLike,
  type ForkOptions,
  type ProcessGoneDetails,
  type SupervisorDeps,
  type WebContentsLike
} from './supervisor'

/**
 * What kill() does. 'win32' (PR0): 'exit' 0 at once and no child-process-gone. 'linux' (PR0b): the
 * process is reaped ~2 s later and 'exit' reports 0 (a crashed or OOM child included); any
 * child-process-gone ('killed' 9/15, sometimes) is up to the test.
 */
type KillMode = 'win32' | 'linux'
const LINUX_REAP_MS = 2_100

class FakeChild extends EventEmitter implements ChildLike {
  pid: number | undefined
  readonly stdout = new PassThrough({ highWaterMark: 16 * 1024 })
  readonly stderr = new PassThrough({ highWaterMark: 16 * 1024 })
  readonly received: Array<{ msg: unknown; transfer?: unknown[] }> = []
  killed = false
  exited = false
  spawned = false
  /** kill() calls, effective or not. */
  killCalls = 0
  /** Posts that reached this child after it exited (the alive flag must keep this at 0). */
  postsAfterExit = 0
  /**
   * The coordinator heartbeats every OCR_HEARTBEAT_INTERVAL_MS from its first moment; a hung child
   * (PR0b Linux: state D after a crash or V8 OOM) says nothing at all.
   */
  responsive = true
  private beat: ReturnType<typeof setInterval> | null = null

  constructor(
    readonly modulePath: string,
    readonly options: ForkOptions,
    readonly killMode: KillMode = 'win32'
  ) {
    super()
  }

  /** The process launched: Electron fills in the pid and emits 'spawn'. */
  launch(): void {
    if (this.spawned) return
    this.spawned = true
    this.pid = 4242
    this.emit('spawn')
    if (this.exited) return
    this.beat = setInterval(() => {
      if (this.responsive && !this.exited) this.say(HB)
    }, OCR_HEARTBEAT_INTERVAL_MS)
    ;(this.beat as { unref?: () => void }).unref?.()
  }

  /** Stop answering, without exiting (the Linux hang). */
  hang(): void {
    this.responsive = false
  }

  postMessage(msg: unknown, transfer?: unknown[]): void {
    if (this.exited) {
      this.postsAfterExit++
      throw new Error('posted to an exited child (the alive flag failed)')
    }
    this.received.push({ msg, transfer })
  }

  kill(): boolean {
    this.killCalls++
    // Electron 38 UtilityProcessWrapper::Kill(): returns false and does nothing while pid_ is
    // still null, i.e. before the process launched ('spawn').
    if (!this.spawned || this.exited) return false
    if (this.killed) return true
    this.killed = true
    // Windows (PR0): our own kill() → 'exit' with code 0, and NO child-process-gone. Linux (PR0b):
    // the same 0, about 2 s later.
    if (this.killMode === 'win32') queueMicrotask(() => this.exit(0))
    else setTimeout(() => this.exit(0), LINUX_REAP_MS)
    return true
  }

  /** Still running and nobody killed it. */
  get orphanable(): boolean {
    return !this.exited && !this.killed
  }

  exit(code: number): void {
    if (this.exited) return
    this.exited = true
    if (this.beat) clearInterval(this.beat)
    this.beat = null
    this.emit('exit', code)
  }

  /** The child speaks. */
  say(msg: unknown): void {
    this.emit('message', msg)
  }

  messages(key: string): unknown[] {
    return this.received
      .map((r) => r.msg)
      .filter((m) => typeof m === 'object' && m !== null && key in m)
  }

  /**
   * Write `bytes` to stderr the way a real child does: respecting backpressure. A child whose pipe
   * nobody reads stalls here forever, exactly like PR0's undrained child.
   */
  async flood(bytes: number): Promise<number> {
    const chunk = Buffer.alloc(64 * 1024, 0x41)
    chunk[chunk.length - 1] = 0x0a
    let written = 0
    while (written < bytes) {
      if (!this.stderr.write(chunk)) await new Promise((r) => this.stderr.once('drain', r))
      written += chunk.length
    }
    return written
  }
}

class FakeWebContents extends EventEmitter implements WebContentsLike {
  static next = 1
  readonly id = FakeWebContents.next++
  destroyed = false
  readonly ports: unknown[][] = []
  readonly sends: Array<{ channel: string; args: unknown[] }> = []

  isDestroyed(): boolean {
    return this.destroyed
  }

  postMessage(channel: string, _message: unknown, transfer: unknown[] = []): void {
    expect(channel).toBe('ocr:port')
    this.ports.push(transfer)
  }

  send(channel: string, ...args: unknown[]): void {
    this.sends.push({ channel, args })
  }

  disconnects(): unknown[] {
    return this.sends.filter((s) => s.channel === 'ocr:disconnected').map((s) => s.args[0])
  }
}

interface Ctx {
  sup: OcrSupervisor
  children: FakeChild[]
  gone: (d: Partial<ProcessGoneDetails>) => void
  blockers: { started: number[]; stopped: number[] }
  progress: Array<{ wc: number; frac: number }>
  priorities: number[]
  logs: string[]
  closers: Map<WebContentsLike, () => void>
  channels: Array<{
    port1: { closed: boolean; close(): void }
    port2: { closed: boolean; close(): void }
  }>
  deps: SupervisorDeps
}

const SELF_CHECK = { checked: ['process._linkedBinding', 'process.binding'], failed: [] }
const READY = {
  ready: {
    tripwire: 0,
    electronNet: ['fetch', 'request', 'resolveHost', 'isOnline'],
    selfCheck: SELF_CHECK
  }
}
const HB = {
  heartbeat: {
    tripwire: { process: 0, raster: 0, recognize: 0 },
    tripwireIntact: true,
    rss: 1,
    threads: { raster: 0, recognize: 0 },
    pending: 0,
    concurrency: 1
  }
}

function setup(
  over: Partial<SupervisorDeps> = {},
  { manualLaunch = false, killMode = 'win32' }: { manualLaunch?: boolean; killMode?: KillMode } = {}
): Ctx {
  const children: FakeChild[] = []
  let goneListener: (d: ProcessGoneDetails) => void = () => {}
  const blockers = { started: [] as number[], stopped: [] as number[] }
  const progress: Array<{ wc: number; frac: number }> = []
  const priorities: number[] = []
  const logs: string[] = []
  const closers = new Map<WebContentsLike, () => void>()
  const channels: Ctx['channels'] = []
  let blockerSeq = 0
  const port = (): { closed: boolean; close(): void } => {
    const p = {
      closed: false,
      close() {
        p.closed = true
      }
    }
    return p
  }
  const deps: SupervisorDeps = {
    fork: (modulePath, _args, options) => {
      const c = new FakeChild(modulePath, options, killMode)
      children.push(c)
      if (!manualLaunch) queueMicrotask(() => c.launch())
      return c
    },
    modulePath: '/app.asar/out/main/chunks/index-ocr.js',
    onChildProcessGone: (l) => {
      goneListener = l
    },
    createChannel: () => {
      const ch = { port1: port(), port2: port() }
      channels.push(ch)
      return ch
    },
    powerSaveBlocker: {
      start: () => {
        const id = ++blockerSeq
        blockers.started.push(id)
        return id
      },
      stop: (id) => blockers.stopped.push(id)
    },
    setPriority: (pid) => priorities.push(pid),
    setProgress: (wc, frac) => progress.push({ wc: wc.id, frac }),
    onWindowClosed: (wc, l) => {
      closers.set(wc, l)
      return () => closers.delete(wc)
    },
    init: () => ({
      limits: { onBattery: false, thermal: 'nominal', speedLimit: 100, divisor: 1 },
      paths: {
        pdfiumWasm: '/app.asar/node_modules/@embedpdf/pdfium/dist/pdfium.wasm',
        ocrCore: '/resources/ocr',
        tessdata: { eng: '/resources/ocr/tessdata/eng.traineddata.gz' }
      }
    }),
    platform: 'win32',
    env: {
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\x',
      NODE_OPTIONS: '--inspect',
      HTTPS_PROXY: 'http://p'
    },
    isPackaged: true,
    log: (l) => logs.push(l),
    ...over
  }
  const sup = new OcrSupervisor(deps)
  return {
    sup,
    children,
    gone: (d) =>
      goneListener({
        type: 'Utility',
        reason: 'crashed',
        exitCode: 1,
        serviceName: 'node.mojom.NodeService',
        name: SERVICE_NAME,
        ...d
      }),
    blockers,
    progress,
    priorities,
    logs,
    closers,
    channels,
    deps
  }
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** connect(wc) and let the child come up. */
async function connected(
  ctx: Ctx,
  wc = new FakeWebContents()
): Promise<{ wc: FakeWebContents; child: FakeChild }> {
  ctx.sup.connect(wc)
  await tick()
  const child = ctx.children.at(-1)!
  child.say(READY)
  await tick()
  return { wc, child }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ByteRing', () => {
  it('keeps only the last 64 KB and counts every line and byte', () => {
    const r = new ByteRing()
    for (let i = 0; i < 100; i++) r.push(Buffer.alloc(4096, 0x61))
    r.push('tail line\n')
    expect(r.bytes).toBe(RING_BYTES)
    expect(r.total).toBe(100 * 4096 + 10)
    expect(r.lines).toBe(1)
    expect(r.text().endsWith('tail line\n')).toBe(true)
    r.push(Buffer.alloc(200_000, 0x0a))
    expect(r.bytes).toBe(RING_BYTES)
    expect(r.lines).toBe(200_001)
  })
})

describe('spawning', () => {
  it('is lazy: nothing forks until a renderer connects', async () => {
    const ctx = setup()
    await tick()
    expect(ctx.children).toHaveLength(0)
    expect(ctx.sup.state).toBe('stopped')
    await connected(ctx)
    expect(ctx.children).toHaveLength(1)
  })

  it('forks the ?modulePath entry as pdfx-ocr with piped stdio and only SystemRoot in env', async () => {
    const ctx = setup()
    const { child } = await connected(ctx)
    expect(child.modulePath).toBe(ctx.deps.modulePath)
    expect(child.options).toEqual({
      serviceName: 'pdfx-ocr',
      stdio: 'pipe',
      env: { SystemRoot: 'C:\\Windows' }
    })
    expect(ctx.priorities).toEqual([4242])
  })

  // What WE pass. The child's real environment is more on these OSes (Electron adds
  // DBUS_SESSION_BUS_ADDRESS on linux and __CF_USER_TEXT_ENCODING on darwin; PR0b), so these tests
  // assert the fork options only, and nothing in the child reads its env (ocr-source-bans).
  for (const [platform, extra] of [
    ['linux', { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }],
    ['darwin', { __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0' }]
  ] as const) {
    it(`passes no environment at all on ${platform}, not even what Electron adds itself`, async () => {
      const ctx = setup({
        platform,
        env: { HOME: '/home/u', http_proxy: 'x', SystemRoot: 'C:\\Windows', ...extra }
      })
      const { child } = await connected(ctx)
      expect(child.options.env).toEqual({})
      // A fresh object per fork: nothing the child (or Electron) does to one reaches the next.
      child.options.env.LEAK = '1'
      ctx.sup.teardown('test')
      await vi.advanceTimersByTimeAsync(LINUX_REAP_MS)
      await connected(ctx)
      expect(ctx.children[1].options.env).toEqual({})
    })
  }

  it('sends init on ready, then a port; never posts before ready', async () => {
    const ctx = setup()
    const wc = new FakeWebContents()
    ctx.sup.connect(wc)
    await tick()
    const child = ctx.children[0]
    expect(child.received).toEqual([])
    child.say(READY)
    await tick()
    expect(child.messages('init')).toEqual([
      {
        init: {
          limits: { onBattery: false, thermal: 'nominal', speedLimit: 100, divisor: 1 },
          paths: {
            pdfiumWasm: '/app.asar/node_modules/@embedpdf/pdfium/dist/pdfium.wasm',
            ocrCore: '/resources/ocr',
            tessdata: { eng: '/resources/ocr/tessdata/eng.traineddata.gz' }
          }
        }
      }
    ])
    const portMsg = child.received.find((r) => 'port' in (r.msg as object))!
    expect(portMsg.transfer).toEqual([ctx.channels[0].port2])
    expect(wc.ports).toEqual([[ctx.channels[0].port1]])
    expect(ctx.sup.state).toBe('running')
  })

  it('gives every connect a fresh channel and reuses the running process', async () => {
    const ctx = setup()
    const { wc } = await connected(ctx)
    ctx.sup.connect(wc)
    await tick()
    ctx.sup.connect(wc)
    await tick()
    expect(ctx.children).toHaveLength(1)
    expect(ctx.channels).toHaveLength(3)
    expect(new Set(wc.ports.map((p) => p[0])).size).toBe(3)
  })

  it('drops messages from the child that fail the schema', async () => {
    const ctx = setup()
    const { child } = await connected(ctx)
    child.say({ activity: { busy: true, done: 0, total: 1, text: 'page words' } })
    child.say({ stderr: 'x' })
    await tick()
    expect(ctx.blockers.started).toEqual([])
    expect(ctx.logs.filter((l) => l.includes('malformed'))).toHaveLength(2)
  })
})

describe('stdio', () => {
  it('drains a 10 MB stderr flood so the child never blocks, keeping 64 KB', async () => {
    vi.useRealTimers()
    const ctx = setup()
    const { child } = await connected(ctx)
    const t0 = Date.now()
    const written = await Promise.race([
      child.flood(10 * 1024 * 1024),
      new Promise<number>((r) => setTimeout(() => r(-1), 10_000))
    ])
    expect(written).toBe(10 * 1024 * 1024)
    expect(Date.now() - t0).toBeLessThan(10_000)
    // stdout is drained too.
    child.stdout.write('hello\n')
    await new Promise((r) => setImmediate(r))
    expect(ctx.sup.output).toEqual({
      lines: 160 + 1,
      bytes: 10 * 1024 * 1024 + 6,
      buffered: RING_BYTES
    })
    // The child still answers after the flood.
    const hb = ctx.sup.requestHeartbeat(1000)
    child.say(HB)
    await expect(hb).resolves.toEqual(HB.heartbeat)
  })

  it('control: an undrained pipe does block a child that respects backpressure', async () => {
    vi.useRealTimers()
    const stuck = new FakeChild('/x', { serviceName: 'x', stdio: 'pipe', env: {} })
    const r = await Promise.race([
      stuck.flood(10 * 1024 * 1024).then(() => 'done'),
      new Promise<string>((res) => setTimeout(() => res('blocked'), 300))
    ])
    expect(r).toBe('blocked')
  })

  it('logs only the exit reason, code and line count in packaged builds', async () => {
    const ctx = setup({ isPackaged: true })
    const { child } = await connected(ctx)
    child.stderr.write('Secret Page Text\n')
    await tick()
    child.exit(2)
    ctx.gone({ reason: 'crashed', exitCode: 2 })
    await tick()
    expect(ctx.logs.join('\n')).not.toContain('Secret')
    expect(ctx.logs).toContainEqual(
      'ocr: utility process exited unexpectedly (crashed, code 2); 1 line(s) of output'
    )
  })

  it('shows the tail in development builds only', async () => {
    const ctx = setup({ isPackaged: false })
    const { child } = await connected(ctx)
    child.stderr.write('dev diagnostics\n')
    await tick()
    child.exit(2)
    ctx.gone({ reason: 'crashed', exitCode: 2 })
    expect(ctx.logs.join('\n')).toContain('dev diagnostics')
  })
})

describe('the alive flag', () => {
  it('never posts to a child that has exited', async () => {
    const ctx = setup()
    const { child } = await connected(ctx)
    child.exit(1)
    // post() would swallow FakeChild's throw, so count what reached it instead.
    ctx.sup.setLimits({ onBattery: true, thermal: 'nominal', speedLimit: 100 })
    await expect(ctx.sup.requestHeartbeat()).rejects.toThrow(/not running/)
    expect(child.postsAfterExit).toBe(0)
    expect(ctx.logs.filter((l) => l.includes('postMessage failed'))).toEqual([])
  })

  it('a child that exits before ready gets nothing when the next connect arrives', async () => {
    const ctx = setup()
    const wc = new FakeWebContents()
    ctx.sup.connect(wc)
    await tick()
    const first = ctx.children[0]
    first.exit(1)
    ctx.sup.connect(wc)
    await tick()
    expect(first.postsAfterExit).toBe(0)
    expect(first.received).toEqual([])
    // The connect starts a new child, which gets the init and the port once it is ready.
    expect(ctx.children).toHaveLength(2)
    ctx.children[1].say(READY)
    await tick()
    expect(wc.ports).toHaveLength(1)
    expect(ctx.logs.filter((l) => l.includes('postMessage failed'))).toEqual([])
  })
})

describe('one child at a time', () => {
  const orphans = (ctx: Ctx): FakeChild[] => ctx.children.filter((c) => c.orphanable)

  it('kills a child torn down before it launched, once it launches', async () => {
    const ctx = setup({}, { manualLaunch: true })
    const wc = new FakeWebContents()
    ctx.sup.connect(wc)
    await tick()
    const first = ctx.children[0]
    // A reload right after connect(), before 'spawn': Electron 38's kill() is a no-op here.
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    await tick()
    expect(first.killCalls).toBe(1)
    expect(first.killed).toBe(false)
    expect(ctx.sup.state).toBe('stopped')
    first.launch()
    await tick()
    expect(first.killed).toBe(true)
    expect(first.exited).toBe(true)
    // The next connect starts exactly one more, and nothing is left running unkilled but it.
    ctx.sup.connect(wc)
    await tick()
    ctx.children[1].launch()
    await tick()
    expect(orphans(ctx)).toEqual([ctx.children[1]])
    // No priority was set on the process that was killed at launch.
    expect(ctx.priorities).toEqual([4242])
  })

  it('a connect after an exit, before it is classified, does not end with two children', async () => {
    const ctx = setup()
    const { wc } = await connected(ctx)
    ctx.children[0].exit(1)
    // Inside GONE_GRACE_MS, still unclassified.
    ctx.sup.connect(wc)
    await tick()
    ctx.children[1].say(READY)
    await tick()
    await vi.advanceTimersByTimeAsync(10_500)
    expect(ctx.children).toHaveLength(2)
    expect(orphans(ctx)).toEqual([ctx.children[1]])
    expect(ctx.sup.state).toBe('running')
    expect(ctx.sup.lastExit).toMatchObject({ reason: 'abnormal-exit', exitCode: 1 })
    // The renderer holds one live port; nobody told it the healthy child crashed.
    expect(wc.ports).toHaveLength(2)
    expect(wc.disconnects()).toEqual([])
  })

  it('a late child-process-gone for the dead child is not pinned on the healthy one', async () => {
    const ctx = setup()
    const { wc } = await connected(ctx)
    ctx.children[0].exit(1)
    ctx.sup.connect(wc)
    await tick()
    ctx.children[1].say(READY)
    await tick()
    // Child 0's details arrive after child 1 came up (no pid to tell them apart).
    ctx.gone({ reason: 'crashed', exitCode: 1 })
    await vi.advanceTimersByTimeAsync(10_500)
    expect(ctx.children).toHaveLength(2)
    expect(orphans(ctx)).toEqual([ctx.children[1]])
    expect(ctx.sup.state).toBe('running')
    expect(wc.disconnects()).toEqual([])
    // Child 1's own crash, later, is still a crash.
    ctx.children[1].exit(2)
    ctx.gone({ reason: 'crashed', exitCode: 2 })
    await tick()
    expect(ctx.sup.lastExit).toMatchObject({ reason: 'crashed', exitCode: 2 })
    expect(wc.disconnects()).toEqual([{ reason: 'crashed' }])
  })

  it('a launch failure of a child torn down while starting does not take down its successor', async () => {
    const ctx = setup({}, { manualLaunch: true })
    const wc = new FakeWebContents()
    ctx.sup.connect(wc)
    await tick()
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    ctx.sup.connect(wc)
    await tick()
    ctx.children[1].launch()
    ctx.children[1].say(READY)
    await tick()
    // Now child 0, never launched, reports its launch failure.
    ctx.gone({ reason: 'launch-failed', exitCode: 0 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ctx.sup.state).toBe('running')
    expect(wc.disconnects()).toEqual([])
    expect(ctx.children[1].orphanable).toBe(true)
  })

  it('a gone event before its exit still belongs to the live child once the late window is over', async () => {
    const ctx = setup()
    const { wc } = await connected(ctx)
    ctx.children[0].exit(1)
    ctx.sup.connect(wc)
    await tick()
    ctx.children[1].say(READY)
    await tick()
    await vi.advanceTimersByTimeAsync(LATE_GONE_MS)
    // Child 0's details never came; child 1 now dies the gone-first way.
    ctx.gone({ reason: 'oom', exitCode: -536870904 })
    ctx.children[1].exit(1)
    await tick()
    expect(ctx.sup.lastExit).toMatchObject({ reason: 'oom' })
    expect(ctx.sup.concurrencyDivisor).toBe(2)
  })
})

describe('exits (the PR0 Windows matrix)', () => {
  it('a requested kill() is exit 0 with no child-process-gone: no respawn, no crash log', async () => {
    const ctx = setup()
    const { wc, child } = await connected(ctx)
    ctx.sup.teardown('test')
    await tick()
    expect(child.killed).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ctx.children).toHaveLength(1)
    expect(ctx.sup.state).toBe('stopped')
    expect(ctx.logs.filter((l) => l.includes('unexpectedly'))).toEqual([])
    expect(wc.disconnects()).toEqual([])
  })

  for (const [name, reason, code] of [
    ['exit 1 → killed (Node uncaught exception)', 'killed', 1],
    ['exit 2 → crashed', 'crashed', 2],
    ['process.crash() → crashed −36861', 'crashed', -36861],
    ['abnormal-exit', 'abnormal-exit', 3]
  ] as const) {
    it(`${name}: an unrequested exit respawns after backoff and re-sends a port`, async () => {
      const ctx = setup()
      const { wc, child } = await connected(ctx)
      child.exit(code < 0 ? 0xffff7000 : code) // the 'exit' code is lossy for native crashes
      ctx.gone({ reason, exitCode: code })
      await tick()
      expect(ctx.sup.lastExit).toMatchObject({ reason, exitCode: code })
      expect(wc.disconnects()).toEqual([{ reason: 'crashed' }])
      expect(ctx.sup.state).toBe('backoff')
      await vi.advanceTimersByTimeAsync(BACKOFF_MS[0])
      expect(ctx.children).toHaveLength(2)
      ctx.children[1].say(READY)
      await tick()
      expect(wc.ports).toHaveLength(2)
      expect(wc.ports[1][0]).not.toBe(wc.ports[0][0])
    })
  }

  it('a bare exit with no gone event is still a crash (classified after the grace period)', async () => {
    const ctx = setup()
    const { child } = await connected(ctx)
    child.exit(0)
    await tick()
    expect(ctx.sup.lastExit).toBeNull()
    await vi.advanceTimersByTimeAsync(GONE_GRACE_MS)
    expect(ctx.sup.lastExit).toMatchObject({ reason: 'clean-exit', exitCode: 0 })
    expect(ctx.sup.state).toBe('backoff')
  })

  it('accepts the gone event before the exit event', async () => {
    const ctx = setup()
    const { child } = await connected(ctx)
    ctx.gone({ reason: 'crashed', exitCode: 5 })
    child.exit(5)
    await vi.advanceTimersByTimeAsync(GONE_GRACE_MS)
    expect(ctx.sup.lastExit).toMatchObject({ reason: 'crashed', exitCode: 5 })
    expect(ctx.logs.filter((l) => l.includes('unexpectedly'))).toHaveLength(1)
  })

  it('ignores child-process-gone for other utility processes (filtered on details.name)', async () => {
    const ctx = setup()
    await connected(ctx)
    ctx.gone({ name: 'Network Service', reason: 'crashed' })
    ctx.gone({ name: undefined, serviceName: SERVICE_NAME, reason: 'crashed' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ctx.sup.state).toBe('running')
    expect(ctx.sup.lastExit).toBeNull()
  })

  it('backs off 500 ms, then 2 s, then 5 s', async () => {
    const ctx = setup()
    await connected(ctx)
    for (let i = 0; i < BACKOFF_MS.length; i++) {
      const before = ctx.children.length
      ctx.children.at(-1)!.exit(2)
      ctx.gone({ reason: 'crashed', exitCode: 2 })
      await vi.advanceTimersByTimeAsync(BACKOFF_MS[i] - 1)
      expect(ctx.children, `crash ${i + 1}: not before ${BACKOFF_MS[i]} ms`).toHaveLength(before)
      await vi.advanceTimersByTimeAsync(1)
      expect(ctx.children, `crash ${i + 1}: at ${BACKOFF_MS[i]} ms`).toHaveLength(before + 1)
      ctx.children.at(-1)!.say(READY)
      await tick()
    }
  })

  it('caps respawns at 3 in 60 s, then stops with crash-loop', async () => {
    const ctx = setup()
    const { wc } = await connected(ctx)
    for (let i = 0; i < 4; i++) {
      const c = ctx.children.at(-1)!
      c.exit(2)
      ctx.gone({ reason: 'crashed', exitCode: 2 })
      await vi.advanceTimersByTimeAsync(BACKOFF_MS[Math.min(i, 2)])
      ctx.children.at(-1)!.say(READY)
      await tick()
    }
    expect(ctx.children).toHaveLength(4)
    expect(ctx.sup.state).toBe('crash-loop')
    expect(wc.disconnects().at(-1)).toEqual({ reason: 'crash-loop' })
    // A deliberate user action (connect, e.g. Resume) may still try again.
    ctx.sup.connect(wc)
    await tick()
    expect(ctx.children).toHaveLength(5)
  })

  it('crashes spread over more than 60 s keep respawning', async () => {
    const ctx = setup()
    await connected(ctx)
    for (let i = 0; i < 6; i++) {
      ctx.children.at(-1)!.exit(2)
      ctx.gone({ reason: 'crashed', exitCode: 2 })
      await vi.advanceTimersByTimeAsync(30_000)
      ctx.children.at(-1)!.say(READY)
      await tick()
    }
    expect(ctx.sup.state).toBe('running')
    expect(ctx.children).toHaveLength(7)
  })

  it('oom and memory-eviction halve the concurrency for the session and respawn', async () => {
    const ctx = setup()
    const { child } = await connected(ctx)
    child.exit(1)
    ctx.gone({ reason: 'oom', exitCode: -536870904 })
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0])
    expect(ctx.sup.concurrencyDivisor).toBe(2)
    ctx.children[1].say(READY)
    await tick()
    expect(
      (ctx.children[1].messages('init')[0] as { init: { limits: { divisor: number } } }).init.limits
        .divisor
    ).toBe(2)
    ctx.children[1].exit(1)
    ctx.gone({ reason: 'memory-eviction', exitCode: 1 })
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[1])
    expect(ctx.sup.concurrencyDivisor).toBe(4)
    expect(ctx.children).toHaveLength(3)
  })

  it('launch-failed is fatal: no respawn loop, and later connects are refused', async () => {
    // A process that fails to launch never emits 'spawn'.
    const ctx = setup({}, { manualLaunch: true })
    const wc = new FakeWebContents()
    ctx.sup.connect(wc)
    await tick()
    ctx.gone({ reason: 'launch-failed', exitCode: 0 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ctx.sup.state).toBe('fatal')
    expect(ctx.children).toHaveLength(1)
    expect(wc.disconnects()).toEqual([{ reason: 'fatal' }])
    ctx.sup.connect(wc)
    await tick()
    expect(ctx.children).toHaveLength(1)
    expect(wc.disconnects()).toEqual([{ reason: 'fatal' }, { reason: 'fatal' }])
  })

  it('a fork that throws is fatal too', async () => {
    const ctx = setup({
      fork: () => {
        throw new Error('ENOENT')
      }
    })
    const wc = new FakeWebContents()
    ctx.sup.connect(wc)
    expect(ctx.sup.state).toBe('fatal')
    expect(wc.disconnects()).toEqual([{ reason: 'fatal' }])
  })

  it('the child reporting an init failure is fatal (deterministic: respawning would loop)', async () => {
    const ctx = setup()
    const { wc, child } = await connected(ctx)
    const seen: unknown[] = []
    ctx.sup.onFatal((f) => seen.push(f))
    child.say({ fatal: { code: 'init', message: 'traineddata fra: SHA-256 mismatch' } })
    await tick()
    expect(child.killed).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ctx.sup.state).toBe('fatal')
    expect(ctx.children).toHaveLength(1)
    expect(wc.disconnects()).toEqual([{ reason: 'fatal' }])
    // Which file and which check (the coordinator's path-free text) is kept, logged and told to
    // whoever waits on it (the packaged self-test fails at once with it).
    const fatal = { code: 'init', message: 'traineddata fra: SHA-256 mismatch' }
    expect(ctx.sup.lastFatal).toEqual(fatal)
    expect(seen).toEqual([fatal])
    expect(ctx.logs).toContainEqual(
      'ocr: utility process reported a fatal init error: traineddata fra: SHA-256 mismatch'
    )
    // Asking afterwards answers at once.
    const late: unknown[] = []
    ctx.sup.onFatal((f) => late.push(f))
    expect(late).toEqual([fatal])
  })

  it('a crash with nobody connected does not respawn (lazy)', async () => {
    const ctx = setup()
    const port = ctx.sup.connectLocal()
    await tick()
    ctx.children[0].say(READY)
    await port
    // The local owner is dropped by the crash.
    ctx.children[0].exit(2)
    ctx.gone({ reason: 'crashed', exitCode: 2 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ctx.children).toHaveLength(1)
    expect(ctx.sup.state).toBe('stopped')
  })
})

describe('idle, power and progress', () => {
  it('kills the process 3 minutes after the last job, as a requested kill', async () => {
    const ctx = setup()
    const { wc, child } = await connected(ctx)
    child.say({ activity: { busy: true, done: 0, total: 4 } })
    await vi.advanceTimersByTimeAsync(IDLE_KILL_MS * 2)
    expect(child.killed).toBe(false) // busy: never idle-killed mid-batch
    child.say({ activity: { busy: false, done: 0, total: 0 } })
    await vi.advanceTimersByTimeAsync(IDLE_KILL_MS - 1)
    expect(child.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(child.killed).toBe(true)
    expect(wc.disconnects()).toEqual([{ reason: 'idle' }])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ctx.children).toHaveLength(1) // no respawn after an idle kill
    // The next need spawns it again.
    ctx.sup.connect(wc)
    await tick()
    expect(ctx.children).toHaveLength(2)
  })

  it('open triage holds off the idle kill, and the 3 minutes count from its end (PR4b)', async () => {
    const ctx = setup()
    const { wc, child } = await connected(ctx)
    await vi.advanceTimersByTimeAsync(IDLE_KILL_MS - 1_000)
    child.say({ activity: { busy: false, done: 0, total: 0, triage: true } })
    await vi.advanceTimersByTimeAsync(IDLE_KILL_MS * 2)
    expect(child.killed).toBe(false) // triaging: never idle-killed mid-triage
    // Background work: no power blocker, no taskbar progress.
    expect(ctx.blockers.started).toEqual([])
    expect(ctx.progress.filter((p) => p.frac >= 0)).toEqual([])
    child.say({ activity: { busy: false, done: 0, total: 0, triage: false } })
    await vi.advanceTimersByTimeAsync(IDLE_KILL_MS - 1)
    expect(child.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(child.killed).toBe(true)
    expect(wc.disconnects()).toEqual([{ reason: 'idle' }])
  })

  it('a batch that ends while triage is still open does not arm the idle kill', async () => {
    const ctx = setup()
    const { child } = await connected(ctx)
    child.say({ activity: { busy: true, done: 0, total: 2, triage: true } })
    child.say({ activity: { busy: false, done: 0, total: 0, triage: true } })
    expect(ctx.blockers.stopped).toEqual([1])
    await vi.advanceTimersByTimeAsync(IDLE_KILL_MS * 2)
    expect(child.killed).toBe(false)
    child.say({ activity: { busy: false, done: 0, total: 0, triage: false } })
    await vi.advanceTimersByTimeAsync(IDLE_KILL_MS)
    expect(child.killed).toBe(true)
  })

  it('kills an idle process that was never used', async () => {
    const ctx = setup()
    const { child } = await connected(ctx)
    await vi.advanceTimersByTimeAsync(IDLE_KILL_MS)
    expect(child.killed).toBe(true)
  })

  it('holds the power blocker and shows progress only while a batch runs', async () => {
    const ctx = setup()
    const { wc, child } = await connected(ctx)
    child.say({ activity: { busy: true, done: 0, total: 4 } })
    child.say({ activity: { busy: true, done: 2, total: 4 } })
    expect(ctx.blockers.started).toEqual([1])
    child.say({ activity: { busy: false, done: 0, total: 0 } })
    expect(ctx.blockers.stopped).toEqual([1])
    expect(ctx.progress).toEqual([
      { wc: wc.id, frac: 0 },
      { wc: wc.id, frac: 0.5 },
      { wc: wc.id, frac: -1 }
    ])
  })

  it('releases the blocker when the process dies mid-batch', async () => {
    const ctx = setup()
    const { child } = await connected(ctx)
    child.say({ activity: { busy: true, done: 1, total: 4 } })
    child.exit(2)
    expect(ctx.blockers.stopped).toEqual([1])
  })
})

describe('window and renderer lifecycle', () => {
  for (const [name, fire] of [
    ['window closed', (ctx: Ctx, wc: FakeWebContents) => ctx.closers.get(wc)!()],
    [
      'render-process-gone',
      (_: Ctx, wc: FakeWebContents) => wc.emit('render-process-gone', {}, { reason: 'crashed' })
    ],
    [
      'main-frame reload',
      (_: Ctx, wc: FakeWebContents) =>
        wc.emit('did-start-navigation', {
          isMainFrame: true,
          isSameDocument: false,
          url: 'file:///x'
        })
    ],
    [
      'main-frame reload (deprecated positional args)',
      (_: Ctx, wc: FakeWebContents) => wc.emit('did-start-navigation', {}, 'file:///x', false, true)
    ],
    ['webContents destroyed', (_: Ctx, wc: FakeWebContents) => wc.emit('destroyed')]
  ] as const) {
    it(`${name} cancels everything and kills the process, no respawn`, async () => {
      const ctx = setup()
      const { wc, child } = await connected(ctx)
      fire(ctx, wc)
      await tick()
      expect(child.killed).toBe(true)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(ctx.children).toHaveLength(1)
      expect(ctx.sup.state).toBe('stopped')
      // Listeners are detached: a second event is a no-op.
      expect(wc.listenerCount('render-process-gone')).toBe(0)
      expect(ctx.closers.has(wc)).toBe(false)
    })
  }

  it('ignores same-document and subframe navigations', async () => {
    const ctx = setup()
    const { wc, child } = await connected(ctx)
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    await tick()
    expect(child.killed).toBe(false)
  })

  it('a new window gets a fresh process and port; the old owner is torn down', async () => {
    const ctx = setup()
    const { wc: a, child } = await connected(ctx)
    const b = new FakeWebContents()
    ctx.sup.connect(b)
    await tick()
    expect(child.killed).toBe(true)
    expect(a.listenerCount('destroyed')).toBe(0)
    ctx.children[1].say(READY)
    await tick()
    expect(b.ports).toHaveLength(1)
    expect(b.ports[0][0]).not.toBe(a.ports[0][0])
    // macOS: window closed, app alive, window reopened → its first connect spawns afresh.
    ctx.closers.get(b)!()
    await tick()
    const c = new FakeWebContents()
    ctx.sup.connect(c)
    await tick()
    expect(ctx.children).toHaveLength(3)
  })

  it('a renderer reload followed by a new connect gets a new process and port', async () => {
    const ctx = setup()
    const { wc } = await connected(ctx)
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    await tick()
    ctx.sup.connect(wc)
    await tick()
    ctx.children[1].say(READY)
    await tick()
    expect(wc.ports).toHaveLength(2)
    expect(new Set(ctx.channels.map((c) => c.port1)).size).toBe(ctx.channels.length)
  })

  it('dispose (before-quit) kills the child', async () => {
    const ctx = setup()
    const { child } = await connected(ctx)
    ctx.sup.dispose()
    expect(child.killed).toBe(true)
  })
})

describe('the tripwire self-check', () => {
  it("keeps the child realm's self-check from ready, and logs a failed one", async () => {
    const ctx = setup()
    const wc = new FakeWebContents()
    ctx.sup.connect(wc)
    await tick()
    ctx.children[0].say({
      ready: {
        ...READY.ready,
        selfCheck: { checked: SELF_CHECK.checked, failed: ['process.binding'] }
      }
    })
    await tick()
    expect(ctx.sup.childSelfCheck).toEqual({
      checked: SELF_CHECK.checked,
      failed: ['process.binding']
    })
    expect(ctx.logs.filter((l) => l.includes('self-check FAILED'))).toHaveLength(1)
  })
})

describe('liveness: a hung child (PR0b, Linux: no exit, no child-process-gone)', () => {
  it('a running child that goes silent is killed after LIVENESS_MS and treated as a crash', async () => {
    const ctx = setup({}, { killMode: 'linux' })
    const { wc, child } = await connected(ctx)
    child.say({ activity: { busy: true, done: 1, total: 4 } })
    child.hang()
    await vi.advanceTimersByTimeAsync(LIVENESS_MS - 1)
    expect(child.killCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(child.killCalls).toBe(1)
    expect(ctx.sup.lastExit).toMatchObject({ reason: 'hung', exitCode: -1 })
    expect(ctx.logs.filter((l) => l.includes('hung'))).toHaveLength(1)
    // Mid-batch: the blocker and the taskbar progress are released with it.
    expect(ctx.blockers.stopped).toEqual([1])
    expect(ctx.progress.at(-1)).toEqual({ wc: wc.id, frac: -1 })
    // The renderer's crash/Resume path, and the crash backoff.
    expect(wc.disconnects()).toEqual([{ reason: 'crashed' }])
    expect(ctx.sup.state).toBe('backoff')
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0])
    expect(ctx.children).toHaveLength(2)
    ctx.children[1].say(READY)
    await tick()
    expect(wc.ports).toHaveLength(2)
    // Linux reaps the hung child ~2 s after kill() and reports exit 0, then (sometimes) 'killed'.
    await vi.advanceTimersByTimeAsync(LINUX_REAP_MS)
    expect(child.exited).toBe(true)
    ctx.gone({ reason: 'killed', exitCode: 9 })
    await vi.advanceTimersByTimeAsync(60_000)
    // None of that is a second verdict, nor pinned on the healthy successor.
    expect(ctx.sup.state).toBe('running')
    expect(ctx.sup.lastExit).toMatchObject({ reason: 'hung' })
    expect(wc.disconnects()).toEqual([{ reason: 'crashed' }])
    expect(ctx.children).toHaveLength(2)
    expect(ctx.children[1].orphanable).toBe(true)
  })

  it('any message resets the clock, busy or idle; silence alone counts', async () => {
    const ctx = setup()
    const { child } = await connected(ctx)
    child.hang()
    // No heartbeats, but activity every 4 s for a minute keeps it alive.
    for (let t = 0; t < 60_000; t += 4_000) {
      child.say({ activity: { busy: true, done: t / 4_000, total: 100 } })
      await vi.advanceTimersByTimeAsync(4_000)
    }
    // Even a malformed message proves its event loop runs.
    child.say({ nonsense: true })
    await vi.advanceTimersByTimeAsync(LIVENESS_MS - 1)
    expect(child.killCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(child.killed).toBe(true)
    expect(ctx.sup.lastExit).toMatchObject({ reason: 'hung' })
  })

  it('an idle, healthy child that keeps heartbeating is never killed as hung', async () => {
    const ctx = setup()
    const { child } = await connected(ctx)
    await vi.advanceTimersByTimeAsync(IDLE_KILL_MS - 1)
    expect(child.killCalls).toBe(0)
    expect(ctx.sup.lastExit).toBeNull()
  })

  it('a child that hangs before its first message is hung too, and killed once it launches', async () => {
    const ctx = setup({}, { manualLaunch: true })
    const wc = new FakeWebContents()
    ctx.sup.connect(wc)
    await tick()
    const first = ctx.children[0]
    await vi.advanceTimersByTimeAsync(LIVENESS_MS)
    // kill() before 'spawn' is a no-op in Electron 38; it is still classified and replaced.
    expect(first.killCalls).toBe(1)
    expect(ctx.sup.lastExit).toMatchObject({ reason: 'hung' })
    expect(wc.disconnects()).toEqual([{ reason: 'crashed' }])
    first.launch()
    await tick()
    expect(first.killed).toBe(true)
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0])
    expect(ctx.children).toHaveLength(2)
  })

  it('a child that launched but never says ready is hung', async () => {
    const ctx = setup()
    const wc = new FakeWebContents()
    ctx.sup.connect(wc)
    await tick()
    ctx.children[0].hang()
    await vi.advanceTimersByTimeAsync(LIVENESS_MS)
    expect(ctx.children[0].killed).toBe(true)
    expect(ctx.sup.lastExit).toMatchObject({ reason: 'hung' })
  })

  it('hangs count toward the 3-in-60-s respawn cap', async () => {
    const ctx = setup()
    const { wc } = await connected(ctx)
    for (let i = 0; i <= MAX_RESPAWNS; i++) {
      ctx.children.at(-1)!.hang()
      await vi.advanceTimersByTimeAsync(LIVENESS_MS)
      if (i < MAX_RESPAWNS) {
        await vi.advanceTimersByTimeAsync(BACKOFF_MS[i])
        ctx.children.at(-1)!.say(READY)
        await tick()
      }
    }
    expect(ctx.children).toHaveLength(MAX_RESPAWNS + 1)
    expect(ctx.sup.state).toBe('crash-loop')
    expect(wc.disconnects().at(-1)).toEqual({ reason: 'crash-loop' })
  })

  it('main stalling (the timer fires late) re-arms instead of killing a child it did not hear', async () => {
    const ctx = setup()
    const { child } = await connected(ctx)
    child.hang()
    await vi.advanceTimersByTimeAsync(LIVENESS_MS - 1_000)
    // Main blocks for a minute: wall time moves, no timer runs, the child's messages queue up.
    vi.setSystemTime(Date.now() + 60_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(child.killCalls).toBe(0)
    // The queued heartbeat is delivered once main runs again.
    child.say(HB)
    await vi.advanceTimersByTimeAsync(LIVENESS_MS - 1)
    expect(child.killCalls).toBe(0)
    // Silent for a whole window with main running: hung.
    await vi.advanceTimersByTimeAsync(1)
    expect(child.killCalls).toBe(1)
  })

  it('the window is injectable', async () => {
    const ctx = setup({ livenessMs: 1_000 })
    const { child } = await connected(ctx)
    child.hang()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(child.killed).toBe(true)
  })

  // Electron 38 main, after a synchronous stall, runs the due timer BEFORE it delivers the
  // utility-process messages that queued meanwhile [measured, scratch experiment]. So the deadline
  // firing up to an interval late, with the child's heartbeats right behind it, is the normal shape
  // of a 15–20 s main stall, and must not kill a child that never stopped sending.
  it.each([1, 3_000, OCR_HEARTBEAT_INTERVAL_MS])(
    'a main stall that ends %i ms past the deadline does not kill a child whose heartbeats queued behind it',
    async (lateMs) => {
      const ctx = setup()
      const { wc, child } = await connected(ctx)
      // Heartbeats by hand: the "queue" is whatever is said after the timers ran.
      child.hang()
      child.say(HB)
      // Main is blocked from here to `end`. Then every timer that came due runs at once, each
      // seeing `end` as the time...
      const end = Date.now() + LIVENESS_MS + lateMs
      const now = vi.spyOn(Date, 'now').mockReturnValue(end)
      await vi.advanceTimersByTimeAsync(LIVENESS_MS + lateMs)
      now.mockRestore()
      // ...and only then do the heartbeats the child sent meanwhile arrive.
      child.say(HB)
      child.say(HB)
      child.say(HB)
      expect(child.killCalls).toBe(0)
      child.responsive = true
      await vi.advanceTimersByTimeAsync(60_000)
      expect(child.killCalls).toBe(0)
      expect(ctx.sup.lastExit).toBeNull()
      expect(ctx.sup.state).toBe('running')
      expect(wc.disconnects()).toEqual([])
    }
  )

  it('suspicion alone never kills: a heartbeat in the last interval clears it', async () => {
    const ctx = setup()
    const { child } = await connected(ctx)
    child.hang()
    child.say(HB)
    // Past the suspect point, inside the confirmation interval.
    await vi.advanceTimersByTimeAsync(LIVENESS_MS - OCR_HEARTBEAT_INTERVAL_MS + 1)
    expect(child.killCalls).toBe(0)
    child.say(HB)
    await vi.advanceTimersByTimeAsync(LIVENESS_MS - 1)
    expect(child.killCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(child.killCalls).toBe(1)
    expect(ctx.sup.lastExit).toMatchObject({ reason: 'hung' })
  })
})

describe('a V8 heap abort (the thread caps do not contain every runaway; budget.ts)', () => {
  // Measured stderr of a utility process whose capped worker grew one array / Map past the cap.
  const ABORT = [
    '\r\n<--- Last few GCs --->\r\n',
    '[56408:0000412C00628000]      574 ms: Mark-Compact (reduce) 639.3 (642.6) -> 384.2 (386.0) MB\r\n',
    'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\r\n',
    '----- Native stack trace -----\r\n',
    ' 1: 00007FF78628A6BA llhttp_get_upgrade+45290\r\n'
  ].join('')

  it('recognises the abort line, and only at the start of a line', () => {
    expect(isV8FatalOom(ABORT)).toBe(true)
    expect(
      isV8FatalOom(
        'FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory'
      )
    ).toBe(true)
    expect(isV8FatalOom('FATAL ERROR: Zone Allocation failed - process out of memory\n')).toBe(true)
    expect(isV8FatalOom('')).toBe(false)
    expect(isV8FatalOom('FATAL ERROR: v8::ToLocalChecked Empty MaybeLocal\n')).toBe(false)
    // Text that merely contains it (a page's words echoed by a library, say) is not the abort.
    expect(
      isV8FatalOom('warn: "FATAL ERROR: x Allocation failed - JavaScript heap out of memory"\n')
    ).toBe(false)
  })

  it("an abort reported as 'crashed' 134 is a 'v8-oom': a crash that halves the concurrency", async () => {
    const ctx = setup()
    const { wc, child } = await connected(ctx)
    child.stderr.write(ABORT)
    await tick()
    child.exit(134)
    ctx.gone({ reason: 'crashed', exitCode: 134 })
    await tick()
    expect(ctx.sup.lastExit).toMatchObject({ reason: 'v8-oom', exitCode: 134 })
    expect(ctx.sup.concurrencyDivisor).toBe(2)
    expect(wc.disconnects()).toEqual([{ reason: 'crashed' }])
    expect(ctx.sup.state).toBe('backoff')
    // The respawned child is told the halved divisor.
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0])
    ctx.children[1].say(READY)
    await tick()
    expect(ctx.children[1].messages('init')).toMatchObject([{ init: { limits: { divisor: 2 } } }])
    // Never the output itself in a packaged build.
    expect(ctx.logs.join('\n')).not.toContain('Reached heap limit')
  })

  it('the Linux shape (the aborting child hangs until killed) is a v8-oom too', async () => {
    const ctx = setup({}, { killMode: 'linux' })
    const { child } = await connected(ctx)
    child.stderr.write(ABORT)
    await tick()
    child.hang()
    await vi.advanceTimersByTimeAsync(LIVENESS_MS)
    expect(child.killCalls).toBe(1)
    expect(ctx.sup.lastExit).toMatchObject({ reason: 'v8-oom', exitCode: -1 })
    expect(ctx.sup.concurrencyDivisor).toBe(2)
    expect(ctx.logs.filter((l) => l.includes('hung') && l.includes('V8 heap'))).toHaveLength(1)
  })

  it('a crash without the abort line leaves the concurrency alone', async () => {
    const ctx = setup()
    const { child } = await connected(ctx)
    child.stderr.write('some other output\n')
    await tick()
    child.exit(134)
    ctx.gone({ reason: 'crashed', exitCode: 134 })
    await tick()
    expect(ctx.sup.lastExit).toMatchObject({ reason: 'crashed' })
    expect(ctx.sup.concurrencyDivisor).toBe(1)
  })
})

describe('Linux exits and kills (PR0b)', () => {
  it("a 'killed' child-process-gone for a child we killed is not pinned on its successor", async () => {
    const ctx = setup({}, { killMode: 'linux' })
    const { wc, child } = await connected(ctx)
    // Reload, then the renderer connects again at once: a new child comes up while the old one is
    // still being reaped.
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    ctx.sup.connect(wc)
    await tick()
    ctx.children[1].say(READY)
    await tick()
    await vi.advanceTimersByTimeAsync(LINUX_REAP_MS)
    expect(child.exited).toBe(true)
    ctx.gone({ reason: 'killed', exitCode: 9 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ctx.sup.state).toBe('running')
    expect(ctx.sup.lastExit).toBeNull()
    expect(wc.disconnects()).toEqual([])
    expect(ctx.children[1].orphanable).toBe(true)
    expect(ctx.children[1].killCalls).toBe(0)
  })

  it("the same for 'killed' 15 arriving before the killed child's exit", async () => {
    const ctx = setup({}, { killMode: 'linux' })
    const { wc } = await connected(ctx)
    const b = new FakeWebContents()
    ctx.sup.connect(b) // owner change: kill the old child, start a new one
    await tick()
    ctx.children[1].say(READY)
    await tick()
    ctx.gone({ reason: 'killed', exitCode: 15 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ctx.sup.state).toBe('running')
    expect(b.disconnects()).toEqual([])
    expect(wc.disconnects()).toEqual([])
    expect(ctx.children[1].orphanable).toBe(true)
  })

  it('a gone event that never gets its exit: the child is killed as well as classified', async () => {
    const ctx = setup({}, { killMode: 'linux' })
    const { wc, child } = await connected(ctx)
    ctx.gone({ reason: 'crashed', exitCode: 11 })
    await vi.advanceTimersByTimeAsync(GONE_GRACE_MS)
    expect(ctx.sup.lastExit).toMatchObject({ reason: 'crashed', exitCode: 11 })
    expect(child.killCalls).toBe(1)
    expect(wc.disconnects()).toEqual([{ reason: 'crashed' }])
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0])
    ctx.children[1].say(READY)
    await tick()
    // Its exit 0 (the reap) changes nothing.
    await vi.advanceTimersByTimeAsync(LINUX_REAP_MS)
    expect(ctx.sup.state).toBe('running')
    expect(ctx.children.filter((c) => c.orphanable)).toEqual([ctx.children[1]])
  })

  it('a child that exits 0 by itself is still a crash (Linux exit codes do not tell)', async () => {
    const ctx = setup({ platform: 'linux', env: {} })
    const { wc, child } = await connected(ctx)
    child.exit(0)
    await vi.advanceTimersByTimeAsync(GONE_GRACE_MS)
    expect(ctx.sup.lastExit).toMatchObject({ reason: 'clean-exit', exitCode: 0 })
    expect(wc.disconnects()).toEqual([{ reason: 'crashed' }])
    expect(ctx.sup.state).toBe('backoff')
  })
})

describe('exit codes', () => {
  it('maps unsigned exit codes back to signed', () => {
    expect(signedExitCode(0)).toBe(0)
    expect(signedExitCode(134)).toBe(134)
    expect(signedExitCode(-36861)).toBe(-36861)
    expect(signedExitCode(3221225477)).toBe(-1073741819) // 0xC0000005
    expect(signedExitCode(0xffff7003)).toBe(-36861)
    // Windows process.crash(): 'exit' reports the uint64 wrap of −36861 as a double (PR0b).
    const wrapped = 18446744073709515000
    expect(Math.abs(signedExitCode(wrapped) - -36861)).toBeLessThanOrEqual(1024)
    expect(signedExitCode(NaN)).toBe(-1)
  })

  it('a bare Windows crash exit (no gone event) reports a signed code', async () => {
    const ctx = setup()
    const { child } = await connected(ctx)
    child.exit(18446744073709515000)
    await vi.advanceTimersByTimeAsync(GONE_GRACE_MS)
    expect(ctx.sup.lastExit?.reason).toBe('abnormal-exit')
    expect(ctx.sup.lastExit?.exitCode).toBe(-36864)
  })

  it("prefers child-process-gone's exact code over the 'exit' code", async () => {
    const ctx = setup()
    const { child } = await connected(ctx)
    child.exit(18446744073709515000)
    ctx.gone({ reason: 'crashed', exitCode: -36861 })
    await tick()
    expect(ctx.sup.lastExit).toMatchObject({ reason: 'crashed', exitCode: -36861 })
  })
})

describe('heartbeat', () => {
  it('logs the network tripwire once if any counter is above 0', async () => {
    const ctx = setup()
    const { child } = await connected(ctx)
    const bad = {
      heartbeat: { ...HB.heartbeat, tripwire: { process: 0, raster: 1, recognize: 0 } }
    }
    child.say(bad)
    child.say(bad)
    expect(ctx.logs.filter((l) => l.includes('TRIPWIRE'))).toHaveLength(1)
    expect(ctx.sup.lastHeartbeat?.tripwire.raster).toBe(1)
  })
})
