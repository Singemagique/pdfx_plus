// `pdfx --ocr-selftest <out.json>` (DESIGN.md §3.9.3 tier 1c). Main plays the renderer over a real
// port into the real utility process: open the embedded clean300 scan, triage it with PDFium in the
// raster thread (it must be `scanned`), render it, recognise it with the real engine from
// resources/ocr, and require the packed result (stamped with triage's class) to match the recorded
// replay exactly (selftest-fixture.ts), then check every tripwire counter is 0. PR11 adds the
// shortcut check and the 3-OS CI wiring.
//
// This file is the session logic only (no Electron import), so it also runs in vitest against the
// coordinator; host.ts `runOcrSelftest` wires it to the packaged app and writes the report.

import { createHash } from 'node:crypto'

import {
  OCR_PROTOCOL_VERSION,
  parseFromOcr,
  type FromOcr,
  type Heartbeat,
  type PageResult,
  type ToOcr,
  type TripwireSelfCheck
} from '../../shared/ocr/protocol'
import { unpack, type PackedOcrPage } from '../../shared/ocr/types'
import { SELFTEST, selftestPdf } from './selftest-fixture'

/**
 * SHA-256 over everything a packed page says about its words: status, DPI, text and every array
 * (little-endian on every platform PDFx ships for), plus the line languages, and its provenance and
 * confidence: the languages and data hashes it was recognised with (sorted), the calibrated mean
 * and its source. Two runs agree on it only if they produced the same words at the same Float32
 * positions, stamped with the same manifest hashes.
 */
export function packedDigest(p: PackedOcrPage): string {
  const h = createHash('sha256')
  h.update(`${p.status}\n${p.renderDpi}\n${p.engineId}\n${p.text}\n`)
  for (const a of [p.wordOff, p.wordGeom, p.wordLine, p.lineGeom, p.charOff, p.charEdges]) {
    h.update(a ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : new Uint8Array(0))
    h.update('|')
  }
  h.update(JSON.stringify(p.lineLang ?? null))
  const hashes = Object.keys(p.dataHashes)
    .sort()
    .map((l) => [l, p.dataHashes[l]])
  h.update(
    JSON.stringify({
      langs: p.langs,
      dataHashes: hashes,
      meanConfCal: p.meanConfCal,
      confSource: p.confSource,
      pipelineVersion: p.pipelineVersion,
      pageClass: p.pageClass
    })
  )
  return h.digest('hex')
}

/** The copy text of a packed page (words by spaces, lines by newlines). */
export function packedCopyText(p: PackedOcrPage): string {
  return unpack(p)
    .lines.map((l) => l.words.map((w) => w.t).join(' '))
    .join('\n')
}

/** What the report carries about the page instead of its arrays. */
export interface SelftestPageSummary {
  status: string
  reason?: string
  renderDpi: number | null
  raster: { width: number; height: number } | null
  words: number
  digest: string | null
  digestMatches: boolean
  textMatches: boolean
  meanConfCal: number | null
  /** The class the recognised page was stamped with (triage's). */
  pageClass: string | null
}

/** What the report carries about the page's triage (never its native words). */
export interface SelftestTriageSummary {
  pageClass: string | null
  failure?: string
  refused?: string
  renderDpi: number | null
  effectiveDpi: number | null
  bitsPerPixel: number | null
}

/**
 * The class triage must give the self-test page: an image-only scan of the clean300 preset. The
 * recognised page carries it too, and the recorded digest covers it.
 */
export const SELFTEST_PAGE_CLASS = 'scanned'

/** The renderer end of the port, as main holds it (a MessagePortMain). */
export interface SelftestPort {
  on(event: 'message', listener: (e: { data: unknown }) => void): unknown
  /** The other end went away (the utility process died or was killed). */
  on(event: 'close', listener: () => void): unknown
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
  /** What triage said about the page (it runs first, as the renderer would run it). */
  triage: SelftestTriageSummary | null
  page: SelftestPageSummary | null
  jobDone: { done: number; failed: number; cancelled: boolean } | null
  heartbeat: Heartbeat | null
  /** Every message the "renderer" received passed the protocol validator. */
  messagesValid: boolean
  messageCount: number
}

export const SELFTEST_DPI = SELFTEST.dpi

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
const STEP_TIMEOUT_MS = 60_000

function summarise(p: PageResult): SelftestPageSummary {
  const rec = p.recognition
  const digest = rec ? packedDigest(rec) : null
  const s: SelftestPageSummary = {
    status: p.status,
    renderDpi: p.renderDpi,
    raster: p.raster,
    words: rec ? rec.wordOff.length - 1 : 0,
    digest,
    digestMatches: digest === SELFTEST.expected.digest,
    textMatches: !!rec && packedCopyText(rec) === SELFTEST.expected.text,
    meanConfCal: rec?.meanConfCal ?? null,
    pageClass: rec?.pageClass ?? null
  }
  if (p.reason) s.reason = p.reason
  return s
}

/**
 * Run the session over `port`. Every step fails at once, instead of after STEP_TIMEOUT_MS, when
 * `abort` rejects (host.ts: the supervisor went fatal, e.g. an engine file failed its manifest
 * check) or the port's other end closes; the failure is that reason.
 */
export async function selftestSession(
  port: SelftestPort,
  heartbeat: () => Promise<Heartbeat>,
  now: () => number = () => performance.now(),
  abort?: Promise<never>
): Promise<SelftestReport> {
  const failures: string[] = []
  const timingsMs: Record<string, number> = {}
  const received: FromOcr[] = []
  let messagesValid = true
  const waiters: Array<{ pred: (m: FromOcr) => boolean; resolve: (m: FromOcr) => void }> = []
  let aborted: Error | null = null
  const onAbort = new Set<(e: Error) => void>()
  let closing = false
  const fail = (e: Error): void => {
    if (aborted || closing) return
    aborted = e
    for (const r of [...onAbort]) r(e)
  }
  abort?.catch((e: unknown) => fail(e instanceof Error ? e : new Error('aborted')))
  port.on('close', () => fail(new Error('the utility process closed the port')))
  /** `p`, unless the session is aborted first. */
  const unlessAborted = <T>(p: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (aborted) return reject(aborted)
      const off = (e: Error): void => reject(e)
      onAbort.add(off)
      p.then(
        (v) => {
          onAbort.delete(off)
          resolve(v)
        },
        (e: unknown) => {
          onAbort.delete(off)
          reject(e)
        }
      )
    })

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
      if (aborted) return reject(aborted)
      const done = (): void => {
        clearTimeout(timer)
        onAbort.delete(off)
        const i = waiters.indexOf(waiter)
        if (i >= 0) waiters.splice(i, 1)
      }
      const off = (e: Error): void => {
        done()
        reject(e)
      }
      const waiter = {
        pred,
        resolve: (m: FromOcr) => {
          done()
          resolve(m)
        }
      }
      const timer = setTimeout(() => {
        done()
        reject(new Error(`timed out waiting for ${what}`))
      }, STEP_TIMEOUT_MS)
      onAbort.add(off)
      waiters.push(waiter)
    })
  const send = (m: ToOcr): void => port.postMessage(m)
  const errorOf = (m: FromOcr): string | null => ('error' in m ? m.error.code : null)

  let opened: SelftestReport['opened'] = null
  let triage: SelftestTriageSummary | null = null
  let page: SelftestPageSummary | null = null
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

    // Triage first (PDFium in the raster thread, §3.4.1): the coordinator keeps the class and
    // stamps it on the recognised page.
    t = now()
    send({ triage: { src: 'selftest', pages: [0] } })
    const tr = await wait('triaged', (m) => ('triaged' in m && m.triaged.done) || 'error' in m)
    timingsMs.triage = now() - t
    if (!('triaged' in tr)) throw new Error(`triage failed: ${errorOf(tr)}`)
    const tp = received
      .flatMap((m) => ('triaged' in m ? m.triaged.pages : []))
      .find((p) => p.index === 0)
    if (tp) {
      triage = {
        pageClass: tp.pageClass,
        renderDpi: tp.renderDpi,
        effectiveDpi: tp.effectiveDpi,
        bitsPerPixel: tp.bitsPerPixel
      }
      if (tp.failure) triage.failure = tp.failure
      if (tp.refused) triage.refused = tp.refused
      if (tp.pageClass !== SELFTEST_PAGE_CLASS)
        failures.push(
          `triage class ${tp.pageClass ?? `none (${tp.failure ?? '-'})`}, expected ${SELFTEST_PAGE_CLASS}`
        )
    } else failures.push('no triage result for page 0')

    t = now()
    send({
      recognize: {
        jobId: 'selftest-1',
        src: 'selftest',
        pages: [{ index: 0, userUnit: 1, ...SELFTEST.page }],
        opts: { langs: SELFTEST.langs, renderDpi: SELFTEST_DPI }
      }
    })
    const done = await wait('jobDone', (m) => 'jobDone' in m || 'error' in m)
    timingsMs.recognize = now() - t
    if ('jobDone' in done) {
      const { done: d, failed, cancelled } = done.jobDone
      jobDone = { done: d, failed, cancelled }
    } else throw new Error(`recognize failed: ${errorOf(done)}`)
    const r = received.find((m) => 'result' in m)
    const result: PageResult | null = r && 'result' in r ? r.result.page : null
    page = result ? summarise(result) : null

    const w = Math.round((SELFTEST.page.width * SELFTEST_DPI) / 72)
    const h = Math.round((SELFTEST.page.height * SELFTEST_DPI) / 72)
    if (!page) failures.push('no page result')
    else {
      if (page.status !== SELFTEST.expected.status)
        failures.push(`page status ${page.status} (${page.reason ?? '-'})`)
      if (page.raster?.width !== w || page.raster?.height !== h)
        failures.push(`raster ${JSON.stringify(page.raster)}, expected ${w}x${h}`)
      if (page.words !== SELFTEST.expected.words)
        failures.push(`${page.words} words, expected ${SELFTEST.expected.words}`)
      if (triage?.pageClass && page.pageClass !== triage.pageClass)
        failures.push(`page stamped ${page.pageClass}, triage said ${triage.pageClass}`)
      // The exact replay (§3.9.3 1c): the same words at the same Float32 positions as under Node.
      if (!page.digestMatches) failures.push('recognised page differs from the recorded replay')
      if (!page.textMatches) failures.push('recognised text differs from the recorded replay')
    }

    t = now()
    hb = await unlessAborted(heartbeat())
    timingsMs.heartbeat = now() - t
    const tw = hb.tripwire
    if (tw.process !== 0 || tw.raster !== 0 || tw.recognize !== 0)
      failures.push(`network tripwire fired: ${JSON.stringify(tw)}`)
    if (!hb.tripwireIntact) failures.push('a tripwire stub was replaced in the utility process')
  } catch (e) {
    failures.push(e instanceof Error ? e.message : 'session failed')
  } finally {
    closing = true
    port.close()
  }
  if (!messagesValid) failures.push('a message failed the protocol validator')
  return {
    ok: failures.length === 0,
    failures,
    protocolVersion: OCR_PROTOCOL_VERSION,
    timingsMs,
    opened,
    triage,
    page,
    jobDone,
    heartbeat: hb,
    messagesValid,
    messageCount: received.length
  }
}
