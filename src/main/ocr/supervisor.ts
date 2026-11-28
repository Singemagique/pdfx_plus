// The OCR utility-process supervisor (DESIGN.md §3.3.2, Electron-38-safe). It owns the one
// "pdfx-ocr" utilityProcess: spawns it lazily, drains its stdio, hands each renderer a fresh port,
// tears it down with the window, kills it when idle and respawns it after a crash.
//
// No `electron` import here: host.ts injects fork, the app's child-process-gone events, the power
// blocker, the progress bar and window hooks, so this state machine runs in vitest with a fake
// child (supervisor.node.test.ts).
//
// Rules, each from a PR0 / PR0b measurement:
// - stdio 'pipe' with BOTH pipes drained continuously into a 64 KB ring buffer: an undrained child
//   blocked on a 10 MiB stderr write on Windows (PR0, PR0b). On macOS and Linux the write completes
//   and the child buffers it in its own memory instead (PR0b), so draining matters everywhere. The
//   buffer is never logged in packaged builds (stderr can carry fragments of page content); only the
//   exit reason, code and line count are.
// - env carries nothing from main except SystemRoot on win32 (without it Chromium's Winsock init in
//   the child prints WSALookupServiceBegin 10108 at every spawn). No NODE_OPTIONS, no proxy vars.
//   This is what WE pass: Electron itself adds DBUS_SESSION_BUS_ADDRESS on linux and
//   __CF_USER_TEXT_ENCODING on darwin (PR0b), so nothing may assume the child sees exactly this,
//   and nothing in the child reads its environment (ocr-source-bans.node.test.ts).
// - An alive flag guards every postMessage (the #53293 fix is not in Electron 38).
// - kill() before 'spawn' is a no-op in Electron 38 (UtilityProcessWrapper::Kill returns false
//   while it has no pid yet), so a generation torn down while starting is killed again on 'spawn'.
// - One child at a time: a connect while the last child is dead but not yet classified classifies
//   it first, a spawn kills any child still alive, and a child-process-gone that arrives late (no
//   pid to match on) is charged to the earlier child it belongs to, never to the healthy one. That
//   includes children WE killed: on Linux a killed child sometimes reports child-process-gone
//   'killed' (code 9 or 15) about 2 s later, sometimes nothing (PR0b). A child classified without an
//   exit is killed too, so a misattributed event can never leave an unkilled orphan.
// - Liveness: the coordinator heartbeats every OCR_HEARTBEAT_INTERVAL_MS from its first moment. On
//   Linux a crashed or V8-OOM child can hang (state D/S/I) with no 'exit' and no child-process-gone
//   for minutes (PR0b, with and without the sandbox and inside unshare). So a child that sends
//   nothing for LIVENESS_MISSES intervals, busy or idle, ready or not, is killed and classified
//   'hung': a crash for the respawn/backoff policy and the renderer ('crashed', Resume), whatever
//   exit code it reports afterwards (Linux: 0 after ~2 s). The last interval is a separate
//   confirmation timer, so a main-process stall is never mistaken for a silent child
//   (LIVENESS_LATE_MS).
// - A V8 heap abort in any thread (the heap caps do not contain every shape of runaway) is read off
//   the child's stderr and classified 'v8-oom', which halves the concurrency like 'oom'.
// - Exits: `child-process-gone` is filtered on details.name === 'pdfx-ocr' (serviceName is
//   'node.mojom.NodeService' for every utility process). On Windows exit 1 reads as 'killed', our
//   own kill() gives exit 0 and NO child-process-gone, and 'abnormal-exit' was never seen; on Linux
//   our kill() gives exit 0 too. An exit code cannot tell a crash from a clean exit on every OS, so
//   `killRequested` is set before every kill(), and any exit without it is a crash whatever the
//   reason or code: respawn with backoff, at most 3 in 60 s. 'oom' / 'memory-eviction' / 'v8-oom' halve
//   the concurrency for the session; 'launch-failed' is fatal. Crash codes come from
//   child-process-gone.exitCode when there is one: the 'exit' code is lossy for native crashes
//   (Windows reports process.crash()'s −36861 as the uint64 wrap 18446744073709515000; macOS 11).
//   A bare 'exit' code is mapped back to signed (`signedExitCode`).
// - The port belongs to one webContents. Window closed, render-process-gone and a main-frame
//   navigation (a reload) cancel everything and kill the process; every ocr.connect() gets a FRESH
//   MessageChannelMain and a port is never reused.
// - Idle kill after 3 minutes (WASM memory never shrinks; killing is how it returns to the OS),
//   counted from the end of the last batch AND the last triage request: open triage holds it off.
//   BELOW_NORMAL priority at spawn. The power blocker is held only while a batch runs; the taskbar
//   progress follows the batch.

import {
  OCR_DISCONNECTED_CHANNEL,
  OCR_HEARTBEAT_INTERVAL_MS,
  OCR_PORT_CHANNEL,
  parseOcrToMain,
  type Heartbeat,
  type MainToOcr,
  type OcrActivity,
  type OcrDisconnectReason,
  type OcrHostLimits,
  type OcrInit,
  type TripwireSelfCheck
} from '../../shared/ocr/protocol'

export const SERVICE_NAME = 'pdfx-ocr'
export const IDLE_KILL_MS = 3 * 60_000
export const RING_BYTES = 64 * 1024
export const RESPAWN_WINDOW_MS = 60_000
export const MAX_RESPAWNS = 3
export const BACKOFF_MS = [500, 2_000, 5_000] as const
/** How long an 'exit' waits for its child-process-gone details before it is classified anyway. */
export const GONE_GRACE_MS = 500
/**
 * How long a child classified without its child-process-gone (its exit was not a clean 0) may
 * still have that event arrive. One that does is matched to it, not to the next child.
 */
export const LATE_GONE_MS = 5_000
export const HEARTBEAT_TIMEOUT_MS = 5_000
/**
 * Heartbeat intervals with no message at all before the child is killed as hung. 3 × 5 s = 15 s:
 * fork → first message took 141–523 ms on the CI runners (PR0b), and the coordinator's main thread
 * does no page work (its longest synchronous step is copying a ≤ 1.5 GB source into a
 * SharedArrayBuffer, about a second [est]).
 */
export const LIVENESS_MISSES = 3
export const LIVENESS_MS = LIVENESS_MISSES * OCR_HEARTBEAT_INTERVAL_MS
/**
 * The silence is checked in two steps: after LIVENESS_MISSES − 1 intervals the child is only
 * suspected, and it is killed when the last interval also passes with no message. A deadline timer
 * cannot tell on its own whether the child or main was silent: after main blocked (a long synchronous
 * call, a debugger), Electron 38 runs the due libuv timer BEFORE it delivers the utility-process
 * messages that queued meanwhile [measured: a 10x-scaled copy of this rule in Electron 38.8.6 main,
 * scratch experiment; one-step rule: stalls of 1.6–1.95 s (16–19.5 s real) killed a child that
 * kept sending; two-step: no stall from 1.2 to 3.5 s killed it, a silent child died at 1.50 s]. The
 * confirmation timer is armed only once main runs again, so the queued heartbeats get there first. A
 * confirmation that itself fires more than LIVENESS_LATE_MS late (main blocked again) is re-armed.
 */
export const LIVENESS_LATE_MS = 1_000
/**
 * How long a child we killed may still report its child-process-gone before it exits. Linux reaped
 * a hung child 2.0–2.3 s after kill() (PR0b); after its exit, LATE_GONE_MS applies.
 */
export const KILL_GONE_MS = 30_000

/**
 * A bare 'exit' code as a signed value. Electron reports negative / NTSTATUS codes unsigned: as a
 * uint32 (0xC0000005 → 3221225477) or, for process.crash() on Windows, as a uint64 rounded to a
 * double (−36861 → 18446744073709515000; PR0b), which maps back only to within 1024 (−36864).
 */
export function signedExitCode(code: number): number {
  if (!Number.isFinite(code)) return -1
  if (code >= 2 ** 63) return code - 2 ** 64
  if (code >= 2 ** 31 && code < 2 ** 32) return code - 2 ** 32
  return code
}

/**
 * What Node prints on stderr when V8 runs out of heap and aborts the process (node::OOMErrorHandler:
 * "FATAL ERROR: <where> Allocation failed - JavaScript heap out of memory").
 *
 * The thread heap caps (budget.ts) do NOT turn every thread OOM into ERR_WORKER_OUT_OF_MEMORY. Node
 * gives a capped worker only 16 MiB past its limit to stop in, so a runaway built from small objects
 * is contained, but one that grows a single big array, Map or backing store asks for more than that
 * in one allocation and aborts the WHOLE process [measured: Electron 38.8.6 utility process with
 * THREAD_RESOURCE_LIMITS, `a.push(x)` / `new Array(8e7).fill()` / `Map.set` runaways: exit 134,
 * child-process-gone 'crashed', this line on stderr; small-object runaways: ERR_WORKER_OUT_OF_MEMORY,
 * process alive, nothing on stderr. Same split in Node 24.12; threads.node.test.ts]. Such an exit is
 * classified 'v8-oom' and treated as an OOM (the concurrency halves), not as a generic crash.
 */
const V8_FATAL_OOM =
  /^FATAL ERROR: [^\n]*Allocation failed - (?:JavaScript heap|process) out of memory/m

/** Did this output end in V8's fatal out-of-memory abort? (Matches a fixed line; never logged.) */
export function isV8FatalOom(output: string): boolean {
  return V8_FATAL_OOM.test(output)
}

// ---------------------------------------------------------------------------------------------
// Injected surfaces.

export interface ReadableLike {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
}

/** The subset of Electron's UtilityProcess this file uses. */
export interface ChildLike {
  readonly pid: number | undefined
  readonly stdout: ReadableLike | null
  readonly stderr: ReadableLike | null
  postMessage(message: unknown, transfer?: unknown[]): void
  kill(): boolean
  on(event: 'spawn', listener: () => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'error', listener: (type: string, location: string, report: string) => void): unknown
}

export interface ForkOptions {
  serviceName: string
  stdio: 'pipe'
  env: Record<string, string>
}

/** `app.on('child-process-gone', (_, details))`. */
export interface ProcessGoneDetails {
  type: string
  reason: string
  exitCode: number
  serviceName?: string
  name?: string
}

// ny[] listeners: Electron's WebContents types every event's arguments differently.
export interface WebContentsLike {
  readonly id: number
  isDestroyed(): boolean
  postMessage(channel: string, message: unknown, transfer?: unknown[]): void
  send(channel: string, ...args: unknown[]): void
  on(event: string, listener: (...args: any[]) => void): unknown
  removeListener(event: string, listener: (...args: any[]) => void): unknown
}

/** A MessagePortMain, opaque here: it is only ever handed on. */
export interface PortMainLike {
  close(): void
}

export interface SupervisorDeps {
  fork(modulePath: string, args: string[], options: ForkOptions): ChildLike
  /** The `?modulePath` of src/main/ocr/process/index.ts. */
  modulePath: string
  onChildProcessGone(listener: (details: ProcessGoneDetails) => void): void
  createChannel(): { port1: PortMainLike; port2: PortMainLike }
  powerSaveBlocker: { start(type: 'prevent-app-suspension'): number; stop(id: number): void }
  /** os.setPriority(pid, PRIORITY_BELOW_NORMAL). */
  setPriority(pid: number): void
  /** BrowserWindow.fromWebContents(wc)?.setProgressBar(frac); −1 removes it. */
  setProgress(wc: WebContentsLike, frac: number): void
  /** Call `listener` once when wc's window closes; returns a disposer. */
  onWindowClosed(wc: WebContentsLike, listener: () => void): () => void
  /** Paths and host limits for the child's `init` (the divisor is the supervisor's own). */
  init(): OcrInit
  platform: string
  env: Record<string, string | undefined>
  isPackaged: boolean
  log(line: string): void
  /** Silence before a child counts as hung (default LIVENESS_MS). */
  livenessMs?: number
}

export type SupervisorState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'backoff'
  | 'crash-loop'
  | 'fatal'

export interface ExitInfo {
  /**
   * child-process-gone's reason; without one 'clean-exit' (code 0) or 'abnormal-exit'; 'hung' for a
   * child killed by the liveness check; 'v8-oom' over any of those when the child's stderr ends in
   * V8's heap abort (`isV8FatalOom`). Every one of them is a crash to the respawn policy.
   */
  reason: string
  exitCode: number
  /** Output the ring buffer saw: counts only, never contents. */
  lines: number
  bytes: number
}

// ---------------------------------------------------------------------------------------------

/** The last `capacity` bytes of a stream, plus totals. Memory only; never written anywhere. */
export class ByteRing {
  private chunks: Buffer[] = []
  private size = 0
  total = 0
  lines = 0

  constructor(readonly capacity = RING_BYTES) {}

  push(data: Buffer | string): void {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    this.total += buf.length
    for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) this.lines++
    if (buf.length >= this.capacity) {
      this.chunks = [Buffer.from(buf.subarray(buf.length - this.capacity))]
      this.size = this.capacity
      return
    }
    this.chunks.push(buf)
    this.size += buf.length
    while (this.size > this.capacity) {
      const head = this.chunks[0]
      const over = this.size - this.capacity
      if (head.length <= over) {
        this.chunks.shift()
        this.size -= head.length
      } else {
        this.chunks[0] = head.subarray(over)
        this.size -= over
      }
    }
  }

  get bytes(): number {
    return this.size
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

interface Gen {
  child: ChildLike
  ring: ByteRing
  alive: boolean
  ready: boolean
  killRequested: boolean
  exitCode: number | null
  gone: ProcessGoneDetails | null
  classified: boolean
  grace: ReturnType<typeof setTimeout> | null
  /** It went silent and we killed it (classified 'hung', whatever it reports later). */
  hung: boolean
  liveness: ReturnType<typeof setTimeout> | null
  /** When the liveness timer is due (Date.now() ms), to tell a silent child from a stalled main. */
  livenessDue: number
}

/** The 'exit' / child-process-gone reasons that halve the concurrency for the session. */
const OOM_REASONS = new Set(['oom', 'memory-eviction', 'v8-oom'])

type Owner =
  | { kind: 'wc'; wc: WebContentsLike; detach: () => void }
  | {
      kind: 'local'
      resolve: (port: PortMainLike) => void
      reject: (err: Error) => void
    }

export class OcrSupervisor {
  private gen: Gen | null = null
  private owner: Owner | null = null
  private wantHandover = false
  private stateValue: SupervisorState = 'stopped'
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private backoffTimer: ReturnType<typeof setTimeout> | null = null
  private blockerId: number | null = null
  private crashes: number[] = []
  private divisor = 1
  private limits: Omit<OcrHostLimits, 'divisor'> | null = null
  private heartbeatWaiters: Array<{
    resolve: (hb: Heartbeat) => void
    reject: (e: Error) => void
  }> = []
  private tripwireLogged = false
  private disposed = false
  /**
   * Children that may still report a child-process-gone that is theirs, not the current child's:
   * crashes classified without one (LATE_GONE_MS), and children we killed or found hung
   * (KILL_GONE_MS until their exit, LATE_GONE_MS after it). Oldest first.
   */
  private owedGone: Array<{ gen: Gen; until: number }> = []
  /** Children forked that have neither launched ('spawn') nor exited, oldest first. */
  private unlaunched: Gen[] = []
  lastExit: ExitInfo | null = null
  /** The electron.net members the current child's tripwire stubbed (from its `ready`). */
  childElectronNet: string[] | null = null
  /** The current child's in-realm tripwire self-check (from its `ready`). */
  childSelfCheck: TripwireSelfCheck | null = null
  lastHeartbeat: Heartbeat | null = null
  /** What the child's last `fatal` said (its path-free OcrError text), if it sent one. */
  lastFatal: { code: string; message: string } | null = null
  private fatalListeners: Array<(fatal: { code: string; message: string } | null) => void> = []
  spawnCount = 0

  constructor(private readonly deps: SupervisorDeps) {
    deps.onChildProcessGone((d) => this.onGone(d))
  }

  get state(): SupervisorState {
    return this.stateValue
  }

  get concurrencyDivisor(): number {
    return this.divisor
  }

  /** Output seen from the current (or last) child: counts only. */
  get output(): { lines: number; bytes: number; buffered: number } {
    const r = this.gen?.ring
    return r
      ? { lines: r.lines, bytes: r.total, buffered: r.bytes }
      : { lines: 0, bytes: 0, buffered: 0 }
  }

  /**
   * The renderer of `wc` asked for OCR (ocr.connect()). Spawns the process if needed and sends wc a
   * fresh port. A different webContents takes over: the previous owner's work is torn down first.
   */
  connect(wc: WebContentsLike): void {
    if (this.disposed || wc.isDestroyed()) return
    if (this.stateValue === 'fatal') {
      wc.send(OCR_DISCONNECTED_CHANNEL, { reason: 'fatal' satisfies OcrDisconnectReason })
      return
    }
    if (this.owner && !(this.owner.kind === 'wc' && this.owner.wc === wc))
      this.teardown('owner-changed')
    if (!this.owner) this.owner = this.attach(wc)
    this.wantHandover = true
    this.ensureChild()
  }

  /**
   * Main itself is the renderer (the packaged self-test): resolves with the renderer's end of a
   * fresh channel once the process is ready.
   */
  connectLocal(): Promise<PortMainLike> {
    if (this.stateValue === 'fatal') return Promise.reject(new Error('OCR is unavailable'))
    if (this.owner) this.teardown('owner-changed')
    return new Promise((resolve, reject) => {
      this.owner = { kind: 'local', resolve, reject }
      this.wantHandover = true
      this.ensureChild()
    })
  }

  /** Cancel everything and kill the process (window closed, renderer gone, reload, quit). */
  teardown(reason: string): void {
    const owner = this.owner
    this.owner = null
    this.wantHandover = false
    if (owner?.kind === 'wc') owner.detach()
    if (owner?.kind === 'local') owner.reject(new Error(`OCR torn down (${reason})`))
    if (this.backoffTimer) clearTimeout(this.backoffTimer)
    this.backoffTimer = null
    if (this.stateValue === 'backoff') this.stateValue = 'stopped'
    this.kill(reason)
  }

  dispose(): void {
    this.teardown('quit')
    this.disposed = true
  }

  /** Battery / thermal / speed-limit changes from powerMonitor. */
  setLimits(limits: Omit<OcrHostLimits, 'divisor'>): void {
    this.limits = limits
    if (this.gen?.alive && this.gen.ready) this.post({ limits: this.hostLimits() })
  }

  /** The child's next heartbeat (asks for one now). */
  requestHeartbeat(timeoutMs = HEARTBEAT_TIMEOUT_MS): Promise<Heartbeat> {
    return new Promise((resolve, reject) => {
      if (!this.gen?.alive || !this.gen.ready) {
        reject(new Error('OCR process not running'))
        return
      }
      const timer = setTimeout(() => {
        this.heartbeatWaiters = this.heartbeatWaiters.filter((w) => w !== waiter)
        reject(new Error('heartbeat timed out'))
      }, timeoutMs)
      const waiter = {
        resolve: (hb: Heartbeat) => {
          clearTimeout(timer)
          resolve(hb)
        },
        reject: (e: Error) => {
          clearTimeout(timer)
          reject(e)
        }
      }
      this.heartbeatWaiters.push(waiter)
      this.post({ heartbeat: {} })
    })
  }

  // -------------------------------------------------------------------------------------------

  private attach(wc: WebContentsLike): Owner {
    const gone = (): void => this.teardownIfOwner(wc, 'render-process-gone')
    const destroyed = (): void => this.teardownIfOwner(wc, 'destroyed')
    // Electron 38 passes the details on the event object; the positional (event, url, isInPlace,
    // isMainFrame) form is the deprecated one, kept as a fallback.
    const navigation = (...args: unknown[]): void => {
      const d = (args[0] ?? {}) as { isMainFrame?: boolean; isSameDocument?: boolean }
      const isMainFrame = d.isMainFrame ?? (args[3] as boolean | undefined)
      const sameDocument = d.isSameDocument ?? (args[2] as boolean | undefined)
      if (isMainFrame && !sameDocument) this.teardownIfOwner(wc, 'navigation')
    }
    wc.on('render-process-gone', gone)
    wc.on('did-start-navigation', navigation)
    wc.on('destroyed', destroyed)
    const offClosed = this.deps.onWindowClosed(wc, () => this.teardownIfOwner(wc, 'window-closed'))
    return {
      kind: 'wc',
      wc,
      detach: () => {
        wc.removeListener('render-process-gone', gone)
        wc.removeListener('did-start-navigation', navigation)
        wc.removeListener('destroyed', destroyed)
        offClosed()
      }
    }
  }

  private teardownIfOwner(wc: WebContentsLike, reason: string): void {
    if (this.owner?.kind === 'wc' && this.owner.wc === wc) this.teardown(reason)
  }

  private hostLimits(): OcrHostLimits {
    const base = this.limits ?? this.deps.init().limits
    return {
      onBattery: base.onBattery,
      thermal: base.thermal,
      speedLimit: base.speedLimit,
      divisor: this.divisor
    }
  }

  private ensureChild(): void {
    if (this.gen?.alive) {
      if (this.gen.ready && this.wantHandover) this.handOver()
      return
    }
    const dead = this.gen
    if (dead && !dead.classified && !dead.killRequested) {
      // It exited (or was reported gone) moments ago and is still waiting for its details. Settle
      // it now, as the crash it is, so its classification cannot later respawn over (and orphan)
      // the child this connect is about to start. Without the owner: this connect is starting
      // afresh, so there is nobody to tell "crashed" and no backoff to wait for.
      const owner = this.owner
      this.owner = null
      this.classify(dead)
      this.owner = owner
      if (this.stateValue === 'fatal') {
        this.becomeFatal()
        return
      }
    }
    if (this.backoffTimer) {
      // An explicit connect beats the backoff wait.
      clearTimeout(this.backoffTimer)
      this.backoffTimer = null
    }
    this.spawn()
  }

  private spawn(): void {
    // Never two children: one still alive here would be orphaned (never killed, its messages ignored).
    if (this.gen?.alive) this.kill('replaced')
    const env: Record<string, string> = {}
    // Only SystemRoot, only on win32 (PR0): nothing else from main's environment reaches the child.
    if (this.deps.platform === 'win32' && this.deps.env.SystemRoot)
      env.SystemRoot = this.deps.env.SystemRoot
    let child: ChildLike
    try {
      child = this.deps.fork(this.deps.modulePath, [], {
        serviceName: SERVICE_NAME,
        stdio: 'pipe',
        env
      })
    } catch (e) {
      this.deps.log(`ocr: fork failed (${e instanceof Error ? e.name : 'error'})`)
      this.becomeFatal()
      return
    }
    this.spawnCount++
    this.stateValue = 'starting'
    const gen: Gen = {
      child,
      ring: new ByteRing(),
      alive: true,
      ready: false,
      killRequested: false,
      exitCode: null,
      gone: null,
      classified: false,
      grace: null,
      hung: false,
      liveness: null,
      livenessDue: 0
    }
    this.gen = gen
    this.unlaunched.push(gen)
    // From the fork on: a child that hangs before its first message is just as hung.
    this.armLiveness(gen)
    // Drain BOTH pipes, always: a full pipe blocks the child (PR0, Windows, 10 MiB).
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (chunk) => gen.ring.push(chunk))
      stream?.on('error', () => {})
    }
    child.on('spawn', () => {
      this.launched(gen)
      if (gen.killRequested && gen.exitCode === null) {
        // Torn down while starting: the kill() then was a no-op (no pid yet). Kill it now.
        this.killChild(gen)
        return
      }
      if (child.pid !== undefined) {
        try {
          this.deps.setPriority(child.pid)
        } catch {
          // Best effort: a priority we cannot set is not a reason to fail OCR.
        }
      }
    })
    child.on('message', (m) => this.onChildMessage(gen, m))
    child.on('exit', (code) => this.onExit(gen, code))
    child.on('error', (type, location) =>
      // The experimental 'error' event (V8 fatal errors). Type and location are code positions;
      // the report can quote memory, so it is not logged.
      this.deps.log(`ocr: utility process error event (${String(type)} at ${String(location)})`)
    )
  }

  private post(msg: MainToOcr, transfer?: unknown[]): boolean {
    const gen = this.gen
    if (!gen || !gen.alive) return false
    try {
      gen.child.postMessage(msg, transfer)
      return true
    } catch (e) {
      this.deps.log(`ocr: postMessage failed (${e instanceof Error ? e.name : 'error'})`)
      return false
    }
  }

  private onChildMessage(gen: Gen, raw: unknown): void {
    if (gen !== this.gen || !gen.alive) return
    // Any message at all proves the child's event loop runs (a malformed one included).
    this.armLiveness(gen)
    let msg
    try {
      msg = parseOcrToMain(raw)
    } catch {
      // The child parses untrusted PDFs: never act on a message that fails the schema.
      this.deps.log('ocr: dropped a malformed message from the utility process')
      return
    }
    if ('ready' in msg) {
      gen.ready = true
      this.childElectronNet = [...msg.ready.electronNet]
      this.childSelfCheck = {
        checked: [...msg.ready.selfCheck.checked],
        failed: [...msg.ready.selfCheck.failed]
      }
      if (msg.ready.selfCheck.failed.length > 0)
        this.deps.log(
          `ocr: tripwire self-check FAILED in the utility process (${msg.ready.selfCheck.failed.join(', ')})`
        )
      this.stateValue = 'running'
      const init = this.deps.init()
      this.post({ init: { paths: init.paths, limits: this.hostLimits() } })
      if (this.wantHandover) this.handOver()
      this.armIdle()
    } else if ('activity' in msg) {
      this.onActivity(msg.activity)
    } else if ('heartbeat' in msg) {
      this.lastHeartbeat = msg.heartbeat
      const t = msg.heartbeat.tripwire
      if (!this.tripwireLogged && t.process + t.raster + t.recognize > 0) {
        this.tripwireLogged = true
        this.deps.log(
          `ocr: NETWORK TRIPWIRE fired in the utility process (process ${t.process}, raster ${t.raster}, recognize ${t.recognize})`
        )
      }
      for (const w of this.heartbeatWaiters.splice(0)) w.resolve(msg.heartbeat)
    } else if ('fatal' in msg) {
      // The message is the coordinator's path-free OcrError text (e.g. "traineddata fra: SHA-256
      // mismatch"): which file and which check, never document content.
      this.lastFatal = { code: msg.fatal.code, message: msg.fatal.message }
      this.deps.log(
        `ocr: utility process reported a fatal ${msg.fatal.code} error: ${msg.fatal.message}`
      )
      this.kill('fatal')
      this.becomeFatal()
    }
  }

  private handOver(): void {
    const owner = this.owner
    if (!owner || !this.gen?.ready) return
    this.wantHandover = false
    const { port1, port2 } = this.deps.createChannel()
    if (!this.post({ port: {} }, [port2])) {
      port1.close()
      port2.close()
      return
    }
    if (owner.kind === 'local') {
      owner.resolve(port1)
      return
    }
    if (owner.wc.isDestroyed()) {
      port1.close()
      this.teardown('destroyed')
      return
    }
    owner.wc.postMessage(OCR_PORT_CHANNEL, null, [port1])
  }

  private onActivity(a: OcrActivity): void {
    const wc = this.owner?.kind === 'wc' ? this.owner.wc : null
    if (a.busy) {
      this.clearIdle()
      if (this.blockerId === null)
        this.blockerId = this.deps.powerSaveBlocker.start('prevent-app-suspension')
      if (wc && !wc.isDestroyed())
        this.deps.setProgress(wc, a.total > 0 ? Math.min(1, a.done / a.total) : 0)
      return
    }
    this.endBatch()
    // Open triage is work too (background: no power blocker, no progress), so the idle kill waits
    // for it and its IDLE_KILL_MS count starts again when the last triage request ends.
    if (a.triage) this.clearIdle()
    else this.armIdle()
  }

  private endBatch(): void {
    if (this.blockerId !== null) {
      this.deps.powerSaveBlocker.stop(this.blockerId)
      this.blockerId = null
    }
    const wc = this.owner?.kind === 'wc' ? this.owner.wc : null
    if (wc && !wc.isDestroyed()) this.deps.setProgress(wc, -1)
  }

  private armIdle(): void {
    this.clearIdle()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.gen?.alive) return
      this.kill('idle')
      this.notifyOwner('idle')
    }, IDLE_KILL_MS)
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private kill(reason: string): void {
    this.clearIdle()
    this.endBatch()
    const gen = this.gen
    for (const w of this.heartbeatWaiters.splice(0)) w.reject(new Error(`OCR stopped (${reason})`))
    if (!gen || !gen.alive) return
    // Set BEFORE kill(): on Windows and Linux our own kill() is an 'exit' with code 0.
    gen.killRequested = true
    gen.alive = false
    this.clearLiveness(gen)
    // On Linux its child-process-gone ('killed') can still come, after a successor started (PR0b).
    this.owe(gen, Date.now() + KILL_GONE_MS)
    if (this.stateValue !== 'fatal') this.stateValue = 'stopped'
    // Before 'spawn' this does nothing in Electron 38 (no pid yet); the 'spawn' handler kills again.
    this.killChild(gen)
  }

  // -------------------------------------------------------------------------------------------
  // Liveness.

  private get livenessMs(): number {
    return this.deps.livenessMs ?? LIVENESS_MS
  }

  /** The last interval of the window: the confirmation step (LIVENESS_LATE_MS). */
  private get confirmMs(): number {
    return Math.round(this.livenessMs / LIVENESS_MISSES)
  }

  /** Any message: a fresh window. Silence for all but its last interval only makes it a suspect. */
  private armLiveness(gen: Gen): void {
    this.clearLiveness(gen)
    const ms = this.livenessMs - this.confirmMs
    gen.livenessDue = Date.now() + ms
    gen.liveness = setTimeout(() => this.onSuspect(gen), ms)
  }

  private clearLiveness(gen: Gen): void {
    if (gen.liveness) clearTimeout(gen.liveness)
    gen.liveness = null
  }

  private onSuspect(gen: Gen): void {
    gen.liveness = null
    if (gen !== this.gen || !gen.alive || gen.classified) return
    // Fired more than an interval late: main itself was blocked (a long synchronous save, a
    // suspended laptop). Give the child a fresh window instead of judging a silence main caused.
    if (Date.now() - gen.livenessDue > this.confirmMs) {
      this.armLiveness(gen)
      return
    }
    // Never a kill from here: the heartbeats that queued while main was blocked are delivered after
    // this callback (Electron 38 order), and any of them re-arms the window.
    this.confirmLiveness(gen)
  }

  private confirmLiveness(gen: Gen): void {
    this.clearLiveness(gen)
    const ms = this.confirmMs
    gen.livenessDue = Date.now() + ms
    gen.liveness = setTimeout(() => this.onSilent(gen), ms)
  }

  private onSilent(gen: Gen): void {
    gen.liveness = null
    if (gen !== this.gen || !gen.alive || gen.classified) return
    // Late again: main was blocked during the confirmation too, and the child's messages may be
    // queued behind this very timer. Confirm once more rather than kill a child main did not hear.
    if (Date.now() - gen.livenessDue > Math.min(LIVENESS_LATE_MS, this.confirmMs)) {
      this.confirmLiveness(gen)
      return
    }
    gen.hung = true
    // Its later exit (Linux: code 0) and any gone event are ours now: never a second verdict.
    gen.killRequested = true
    gen.alive = false
    this.clearIdle()
    this.endBatch()
    this.owe(gen, Date.now() + KILL_GONE_MS)
    // Before 'spawn' this is a no-op; the 'spawn' handler kills again (killRequested).
    this.killChild(gen)
    this.classify(gen)
  }

  /** `gen` may still report a child-process-gone until `until`; it must not hit its successor. */
  private owe(gen: Gen, until: number): void {
    const entry = this.owedGone.find((o) => o.gen === gen)
    if (entry) entry.until = until
    else this.owedGone.push({ gen, until })
  }

  private killChild(gen: Gen): boolean {
    try {
      return gen.child.kill()
    } catch {
      // Already gone.
      return false
    }
  }

  private launched(gen: Gen): void {
    this.unlaunched = this.unlaunched.filter((g) => g !== gen)
  }

  private onExit(gen: Gen, code: number): void {
    gen.alive = false
    gen.exitCode = signedExitCode(code)
    this.launched(gen)
    this.clearLiveness(gen)
    if (gen === this.gen) {
      this.clearIdle()
      this.endBatch()
    }
    // A child that owes a gone event owes it for LATE_GONE_MS after its exit.
    if (this.owedGone.some((o) => o.gen === gen)) this.owe(gen, Date.now() + LATE_GONE_MS)
    if (gen.killRequested) {
      // Requested or hung: the code says nothing (a hung Linux child exits 0 once killed).
      gen.classified = true
      return
    }
    if (gen.gone) this.classify(gen)
    else if (!gen.grace) gen.grace = setTimeout(() => this.classify(gen), GONE_GRACE_MS)
  }

  private onGone(d: ProcessGoneDetails): void {
    // Every utility process reports serviceName 'node.mojom.NodeService'; ours is in `name`.
    if (d.name !== SERVICE_NAME) return
    // The details carry no pid. A launch failure belongs to the oldest child that never launched
    // (one torn down while starting may fail to launch after its successor did).
    if (d.reason === 'launch-failed') {
      const failed = this.unlaunched.shift()
      if (!failed) return
      failed.alive = false
      if (failed !== this.gen || failed.killRequested || failed.classified) {
        // Nobody is waiting for that one any more.
        failed.classified = true
        return
      }
      failed.gone = d
      this.classify(failed)
      return
    }
    // A child classified without its gone event, or one we killed, may still be owed one; the oldest
    // such child takes it, so it can never be pinned on the healthy child after it. Unless the
    // current child has itself exited and is waiting for exactly this: then it is its own. Erring
    // this way is safe: a real death of the current child is still seen, by its exit or by the
    // liveness check; only the precise reason is lost.
    const now = Date.now()
    this.owedGone = this.owedGone.filter((o) => o.until > now)
    const gen = this.gen
    const waiting = !!gen && !gen.classified && !gen.killRequested && gen.exitCode !== null
    if (!waiting && this.owedGone.length > 0) {
      // That child was already classified or killed; only its reason is late. Nothing to act on.
      this.owedGone.shift()
      this.deps.log(`ocr: late child-process-gone (${d.reason}) for an earlier utility process`)
      return
    }
    if (!gen || gen.classified || gen.killRequested) return
    this.clearLiveness(gen)
    gen.gone = d
    gen.alive = false
    if (gen.exitCode !== null || d.reason === 'launch-failed') this.classify(gen)
    else if (!gen.grace) gen.grace = setTimeout(() => this.classify(gen), GONE_GRACE_MS)
  }

  private classify(gen: Gen): void {
    if (gen.classified) return
    gen.classified = true
    if (gen.grace) clearTimeout(gen.grace)
    gen.grace = null
    this.clearLiveness(gen)
    if (!gen.hung) {
      // Its gone event can still come (a non-zero exit always has one); expect it, for a while. (A
      // hung child is owed one already, from its kill.)
      if (!gen.gone && gen.exitCode !== 0) this.owe(gen, Date.now() + LATE_GONE_MS)
      if (gen.exitCode === null && !gen.killRequested) {
        // Reported gone but never exited (a Linux crash can hang there). Make sure it is dead: if
        // the report was really another child's, this kills a stray instead of orphaning it.
        gen.killRequested = true
        this.killChild(gen)
      }
    }
    // A V8 heap abort is 'crashed' (Windows) or a hang (Linux) to Electron; its stderr says what it
    // was. It outranks both: it is the cause, and it decides the policy below.
    const v8Oom = isV8FatalOom(gen.ring.text())
    const reason = v8Oom
      ? 'v8-oom'
      : gen.hung
        ? 'hung'
        : (gen.gone?.reason ?? (gen.exitCode === 0 ? 'clean-exit' : 'abnormal-exit'))
    // child-process-gone's code is exact for native crashes; 'exit' is lossy there (PR0, PR0b).
    const exitCode = gen.hung ? -1 : (gen.gone?.exitCode ?? gen.exitCode ?? -1)
    this.lastExit = { reason, exitCode, lines: gen.ring.lines, bytes: gen.ring.total }
    this.deps.log(
      gen.hung
        ? `ocr: utility process hung (no message in ${Math.round(this.livenessMs / 1000)} s${v8Oom ? ', V8 heap out of memory' : ''}); ${gen.ring.lines} line(s) of output`
        : `ocr: utility process exited unexpectedly (${reason}, code ${exitCode}); ${gen.ring.lines} line(s) of output`
    )
    // The output itself only in development builds: it can quote document content.
    if (!this.deps.isPackaged && gen.ring.bytes > 0)
      this.deps.log(`ocr: [dev] last output:\n${gen.ring.text().slice(-4096)}`)
    if (gen === this.gen) this.gen = null
    for (const w of this.heartbeatWaiters.splice(0)) w.reject(new Error('OCR process exited'))
    if (this.owner?.kind === 'local') {
      this.owner.reject(new Error(`OCR process exited (${reason})`))
      this.owner = null
    }

    if (reason === 'launch-failed') {
      this.becomeFatal()
      return
    }
    if (OOM_REASONS.has(reason)) this.divisor = Math.min(64, this.divisor * 2)

    // Every unrequested exit is a crash: respawn with backoff, at most MAX_RESPAWNS in the window.
    const now = Date.now()
    this.crashes = this.crashes.filter((t) => now - t < RESPAWN_WINDOW_MS)
    this.crashes.push(now)
    if (this.crashes.length > MAX_RESPAWNS) {
      this.stateValue = 'crash-loop'
      this.notifyOwner('crash-loop')
      return
    }
    this.notifyOwner('crashed')
    if (!this.owner) {
      // Lazy: nobody needs OCR right now; the next connect() spawns.
      this.stateValue = 'stopped'
      return
    }
    this.stateValue = 'backoff'
    const delay = BACKOFF_MS[Math.min(this.crashes.length, BACKOFF_MS.length) - 1]
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null
      if (!this.owner || this.disposed) {
        this.stateValue = 'stopped'
        return
      }
      this.wantHandover = true
      this.spawn()
    }, delay)
  }

  /**
   * Call `listener` once when OCR becomes unavailable for the session ('fatal': a fatal report from
   * the child, or a launch failure), at once if it already is. Returns a disposer.
   */
  onFatal(listener: (fatal: { code: string; message: string } | null) => void): () => void {
    if (this.stateValue === 'fatal') {
      listener(this.lastFatal)
      return () => {}
    }
    this.fatalListeners.push(listener)
    return () => {
      const i = this.fatalListeners.indexOf(listener)
      if (i >= 0) this.fatalListeners.splice(i, 1)
    }
  }

  private becomeFatal(): void {
    this.stateValue = 'fatal'
    for (const l of this.fatalListeners.splice(0)) l(this.lastFatal)
    this.notifyOwner('fatal')
    if (this.owner?.kind === 'local') this.owner.reject(new Error('OCR is unavailable'))
    if (this.owner?.kind === 'wc') this.owner.detach()
    this.owner = null
  }

  private notifyOwner(reason: OcrDisconnectReason): void {
    const owner = this.owner
    if (owner?.kind !== 'wc' || owner.wc.isDestroyed()) return
    owner.wc.send(OCR_DISCONNECTED_CHANNEL, { reason })
  }
}
