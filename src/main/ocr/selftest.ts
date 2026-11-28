// `pdfx --ocr-selftest <out.json>` (DESIGN.md §3.9.3 tier 1c), the PR4a skeleton. Main plays the
// renderer over a real port into the real utility process: open the embedded page, render it in the
// raster thread, round-trip the stub recognizer, then check every tripwire counter is 0. PR11 grows
// this into the `clean300` exact-replay run and the shortcut check.
//
// This file is the session logic only (no Electron import), so it also runs in vitest against the
// coordinator; host.ts `runOcrSelftest` wires it to the packaged app and writes the report.

import {
  OCR_PROTOCOL_VERSION,
  parseFromOcr,
  type FromOcr,
  type Heartbeat,
  type PageResult,
  type ToOcr,
  type TripwireSelfCheck
} from '../../shared/ocr/protocol'
import { SELFTEST_BAND_FRACTION, SELFTEST_PAGE, selftestPdf } from './selftest-fixture'

/** The renderer end of the port, as main holds it (a MessagePortMain). */
export interface SelftestPort {
  on(event: 'message', listener: (e: { data: unknown }) => void): unknown
  postMessage(msg: unknown): void
  start(): void
  close(): void
}

export interface SelftestReport {
  ok: boolean
  failures: string[]
  protocolVersion: number
  timingsMs: Record<string, number>
  opened: { pageCount: number } | null
  page: PageResult | null
  jobDone: { done: number; failed: number; cancelled: boolean } | null
  heartbeat: Heartbeat | null
  /** Every message the "renderer" received passed the protocol validator. */
  messagesValid: boolean
  messageCount: number
}

export const SELFTEST_DPI = 150

/**
 * Escape hatches the utility process's own self-check must have called (and seen trip). Any one
 * missing from `checked` means the check itself was cut down, which fails the self-test too.
 */
export const REQUIRED_CHILD_CHECKS = [
  'process._linkedBinding',
  'process.binding',
  'process.dlopen',
  'worker_threads.Worker',
  'child_process.spawn',
  'dgram.Socket',
  'dns.Resolver',
  'electron.net.isOnline'
] as const

/**
 * What the child said about its own tripwire in `ready`: in a utility process require('electron').net
 * exists (PR0), so all four members must be stubbed, and every required escape hatch must have
 * tripped when the child called it on itself.
 */
export function childTripwireFailures(
  electronNet: readonly string[] | null,
  selfCheck: TripwireSelfCheck | null
): string[] {
  const failures: string[] = []
  if ((electronNet ?? []).length !== 4)
    failures.push(`electron.net stubs: ${JSON.stringify(electronNet)}, expected 4`)
  if (!selfCheck) failures.push('no tripwire self-check from the utility process')
  else {
    if (selfCheck.failed.length > 0)
      failures.push(
        `tripwire self-check failed in the utility process: ${selfCheck.failed.join(', ')}`
      )
    const missing = REQUIRED_CHILD_CHECKS.filter((c) => !selfCheck.checked.includes(c))
    if (missing.length > 0) failures.push(`tripwire self-check skipped: ${missing.join(', ')}`)
  }
  return failures
}
const STEP_TIMEOUT_MS = 30_000

export async function selftestSession(
  port: SelftestPort,
  heartbeat: () => Promise<Heartbeat>,
  now: () => number = () => performance.now()
): Promise<SelftestReport> {
  const failures: string[] = []
  const timingsMs: Record<string, number> = {}
  const received: FromOcr[] = []
  let messagesValid = true
  const waiters: Array<{ pred: (m: FromOcr) => boolean; resolve: (m: FromOcr) => void }> = []

  port.on('message', (e) => {
    let m: FromOcr
    try {
      m = parseFromOcr(e.data)
    } catch {
      messagesValid = false
      return
    }
    received.push(m)
    for (const w of [...waiters])
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(m)
      }
  })
  port.start()

  const wait = (what: string, pred: (m: FromOcr) => boolean): Promise<FromOcr> =>
    new Promise((resolve, reject) => {
      const found = received.find(pred)
      if (found) return resolve(found)
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${what}`)),
        STEP_TIMEOUT_MS
      )
      waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m)
        }
      })
    })
  const send = (m: ToOcr): void => port.postMessage(m)
  const errorOf = (m: FromOcr): string | null => ('error' in m ? m.error.code : null)

  let opened: SelftestReport['opened'] = null
  let page: PageResult | null = null
  let jobDone: SelftestReport['jobDone'] = null
  let hb: Heartbeat | null = null
  try {
    let t = now()
    send({ open: { src: 'selftest', bytes: selftestPdf() } })
    const o = await wait('opened', (m) => 'opened' in m || 'error' in m)
    timingsMs.open = now() - t
    if ('opened' in o) opened = { pageCount: o.opened.pageCount }
    else throw new Error(`open failed: ${errorOf(o)}`)
    if (opened.pageCount !== 1) failures.push(`page count ${opened.pageCount}, expected 1`)

    t = now()
    send({
      recognize: {
        jobId: 'selftest-1',
        src: 'selftest',
        pages: [{ index: 0, userUnit: 1, ...SELFTEST_PAGE }],
        opts: { langs: ['eng'], renderDpi: SELFTEST_DPI }
      }
    })
    const done = await wait('jobDone', (m) => 'jobDone' in m || 'error' in m)
    timingsMs.recognize = now() - t
    if ('jobDone' in done) {
      const { done: d, failed, cancelled } = done.jobDone
      jobDone = { done: d, failed, cancelled }
    } else throw new Error(`recognize failed: ${errorOf(done)}`)
    const r = received.find((m) => 'result' in m)
    page = r && 'result' in r ? r.result.page : null

    const w = Math.round((SELFTEST_PAGE.width * SELFTEST_DPI) / 72)
    const h = Math.round((SELFTEST_PAGE.height * SELFTEST_DPI) / 72)
    if (!page) failures.push('no page result')
    else {
      if (page.status !== 'ok') failures.push(`page status ${page.status} (${page.reason ?? '-'})`)
      if (page.raster?.width !== w || page.raster?.height !== h)
        failures.push(`raster ${JSON.stringify(page.raster)}, expected ${w}x${h}`)
      const ink = page.recognition?.inkFrac ?? 0
      // The band alone is 10%; the line of text adds a little. Blank (a silent-blank render) is 0.
      if (ink < SELFTEST_BAND_FRACTION * 0.95 || ink > SELFTEST_BAND_FRACTION + 0.05)
        failures.push(`ink fraction ${ink.toFixed(4)} outside the expected band`)
    }

    t = now()
    hb = await heartbeat()
    timingsMs.heartbeat = now() - t
    const tw = hb.tripwire
    if (tw.process !== 0 || tw.raster !== 0 || tw.recognize !== 0)
      failures.push(`network tripwire fired: ${JSON.stringify(tw)}`)
    if (!hb.tripwireIntact) failures.push('a tripwire stub was replaced in the utility process')
  } catch (e) {
    failures.push(e instanceof Error ? e.message : 'session failed')
  } finally {
    port.close()
  }
  if (!messagesValid) failures.push('a message failed the protocol validator')
  return {
    ok: failures.length === 0,
    failures,
    protocolVersion: OCR_PROTOCOL_VERSION,
    timingsMs,
    opened,
    page,
    jobDone,
    heartbeat: hb,
    messagesValid,
    messageCount: received.length
  }
}
