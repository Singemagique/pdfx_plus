// The OCR utility-process supervisor (DESIGN.md §3.3.2, Electron-38-safe). It owns the one
// "pdfx-ocr" utilityProcess: spawns it lazily, drains its stdio, hands each renderer a fresh port,
// tears it down with the window, kills it when idle and respawns it after a crash.
//
// No `electron` import here: host.ts injects fork, the app's child-process-gone events, the power
// blocker, the progress bar and window hooks, so this state machine runs in vitest with a fake
// child (supervisor.node.test.ts).
//
// Rules, each from a PR0 measurement:
// - stdio 'pipe' with BOTH pipes drained continuously into a 64 KB ring buffer: an undrained child
//   blocked on a 10 MiB stderr write on Windows. The buffer is never logged in packaged builds
//   (stderr can carry fragments of page content); only the exit reason, code and line count are.
// - env carries nothing from main except SystemRoot on win32 (without it Chromium's Winsock init in
//   the child prints WSALookupServiceBegin 10108 at every spawn). No NODE_OPTIONS, no proxy vars.
// - An alive flag guards every postMessage (the #53293 fix is not in Electron 38).
// - kill() before 'spawn' is a no-op in Electron 38 (UtilityProcessWrapper::Kill returns false
//   while it has no pid yet), so a generation torn down while starting is killed again on 'spawn'.
// - One child at a time: a connect while the last child is dead but not yet classified classifies
//   it first, a spawn kills any child still alive, and a child-process-gone that arrives late (no
//   pid to match on) is charged to the earlier child it belongs to, never to the healthy one.
// - Exits: `child-process-gone` is filtered on details.name === 'pdfx-ocr' (serviceName is
//   'node.mojom.NodeService' for every utility process). On Windows exit 1 reads as 'killed', our
//   own kill() gives exit 0 and NO child-process-gone, and 'abnormal-exit' was never seen. So
//   `killRequested` is set before every kill(), and any exit without it is a crash whatever the
//   reason: respawn with backoff, at most 3 in 60 s. 'oom' / 'memory-eviction' also halve the
//   concurrency for the session; 'launch-failed' is fatal. Crash codes come from
//   child-process-gone.exitCode (the 'exit' code is lossy for native crashes).
// - The port belongs to one webContents. Window closed, render-process-gone and a main-frame
//   navigation (a reload) cancel everything and kill the process; every ocr.connect() gets a FRESH
//   MessageChannelMain and a port is never reused.
// - Idle kill after 3 minutes (WASM memory never shrinks; killing is how it returns to the OS).
//   BELOW_NORMAL priority at spawn. The power blocker is held only while a batch runs; the taskbar
//   progress follows the batch.

import {
  OCR_DISCONNECTED_CHANNEL,
  OCR_PORT_CHANNEL,
  parseOcrToMain,
  type Heartbeat,
  type MainToOcr,
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
}

export type SupervisorState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'backoff'
  | 'crash-loop'
  | 'fatal'

export interface ExitInfo {
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
}

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
  /** Children classified without their child-process-gone, which may still arrive (LATE_GONE_MS). */
  private lateGone: Array<{ gen: Gen; until: number }> = []
  /** Children forked that have neither launched ('spawn') nor exited, oldest first. */
  private unlaunched: Gen[] = []
  lastExit: ExitInfo | null = null
  /** The electron.net members the current child's tripwire stubbed (from its `ready`). */
  childElectronNet: string[] | null = null
  /** The current child's in-realm tripwire self-check (from its `ready`). */
  childSelfCheck: TripwireSelfCheck | null = null
  lastHeartbeat: Heartbeat | null = null
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
      grace: null
    }
    this.gen = gen
    this.unlaunched.push(gen)
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
      this.deps.log(`ocr: utility process reported a fatal ${msg.fatal.code} error`)
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

  private onActivity(a: { busy: boolean; done: number; total: number }): void {
    const wc = this.owner?.kind === 'wc' ? this.owner.wc : null
    if (a.busy) {
      this.clearIdle()
      if (this.blockerId === null)
        this.blockerId = this.deps.powerSaveBlocker.start('prevent-app-suspension')
      if (wc && !wc.isDestroyed())
        this.deps.setProgress(wc, a.total > 0 ? Math.min(1, a.done / a.total) : 0)
    } else {
      this.endBatch()
      this.armIdle()
    }
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
    // Set BEFORE kill(): on Windows our own kill() is an 'exit' with code 0 and no gone event.
    gen.killRequested = true
    gen.alive = false
    if (this.stateValue !== 'fatal') this.stateValue = 'stopped'
    // Before 'spawn' this does nothing in Electron 38 (no pid yet); the 'spawn' handler kills again.
    this.killChild(gen)
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
    gen.exitCode = code
    this.launched(gen)
    if (gen === this.gen) {
      this.clearIdle()
      this.endBatch()
    }
    if (gen.killRequested) {
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
    // A child classified without its gone event may still be owed one; the oldest such child takes
    // it, so it can never be pinned on the healthy child after it.
    const now = Date.now()
    this.lateGone = this.lateGone.filter((l) => l.until > now)
    if (this.lateGone.length > 0) {
      // That child was already classified as a crash; only its reason is late. Nothing to act on.
      this.lateGone.shift()
      this.deps.log(`ocr: late child-process-gone (${d.reason}) for an earlier utility process`)
      return
    }
    const gen = this.gen
    if (!gen || gen.classified || gen.killRequested) return
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
    // Its gone event can still come (a non-zero exit always has one); expect it, for a while.
    if (!gen.gone && gen.exitCode !== 0)
      this.lateGone.push({ gen, until: Date.now() + LATE_GONE_MS })
    const reason = gen.gone?.reason ?? (gen.exitCode === 0 ? 'clean-exit' : 'abnormal-exit')
    // child-process-gone's code is exact for native crashes; 'exit' is lossy there (PR0).
    const exitCode = gen.gone?.exitCode ?? gen.exitCode ?? -1
    this.lastExit = { reason, exitCode, lines: gen.ring.lines, bytes: gen.ring.total }
    this.deps.log(
      `ocr: utility process exited unexpectedly (${reason}, code ${exitCode}); ${gen.ring.lines} line(s) of output`
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
    if (reason === 'oom' || reason === 'memory-eviction')
      this.divisor = Math.min(64, this.divisor * 2)

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

  private becomeFatal(): void {
    this.stateValue = 'fatal'
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
