// The renderer OCR store against a scripted port (DESIGN.md §3.3.1, §3.3.5–§3.3.6, §3.4.1 Stage
// 0, §3.5.2, §3.8): lazy connect (a text PDF never connects), Stage 0 through Find's extractor and
// Find's full-extraction trigger, triage before recognize, D4 on and off, work order, cancel,
// reconcile by source token (duplicates, move-then-remove), crash → Resume, the two-crash rule,
// progress and ETA, message validation, the export snapshot and the mid-job prompt.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { defaultSettings, type Settings } from '../../../shared/settings'
import { makePageKey } from '../edit/model'
import type { EditLayer } from '../pdfx/build'
import type { DocEntry, PdfSource } from '../types'
import { ocrConfig } from './config'
import { createOcrStore, type OcrStore } from './ocr-store'
import {
  FakeOcrPort,
  FakeText,
  doc,
  eagerIdle,
  nativeText,
  okResult,
  pageOf,
  recognisedPage,
  settle,
  source,
  triaged
} from './test-utils/fake-ocr'

const keyOf = (s: PdfSource, i: number): string => makePageKey(s.id, i)
const emptyLayer = (ocrSelect?: Map<string, string | null>): EditLayer => ({
  overlays: new Map(),
  attachments: new Map(),
  ...(ocrSelect ? { ocrSelect } : {})
})

let stores: OcrStore[] = []
afterEach(() => {
  for (const s of stores) s.dispose()
  stores = []
  vi.useRealTimers()
})

interface Rig {
  store: OcrStore
  port: FakeOcrPort
  text: FakeText
}

function rig(
  opts: {
    settings?: Partial<Settings>
    texts?: Map<string, ReturnType<typeof nativeText>>
    text?: FakeText
    now?: () => number
    idle?: (fn: () => void) => () => void
  } = {}
): Rig {
  const port = new FakeOcrPort()
  const text = opts.text ?? new FakeText(opts.texts ?? new Map())
  const settings: Settings = { ...defaultSettings('en'), ...opts.settings }
  const store = createOcrStore({
    port,
    text,
    getSettings: async () => settings,
    idle: opts.idle ?? eagerIdle,
    now: opts.now
  })
  stores.push(store)
  return { store, port, text }
}

/** An idle queue the test runs by hand (what requestIdleCallback would run later). */
function manualIdle(): {
  idle: (fn: () => void) => () => void
  queue: Array<() => void>
  drain: () => Promise<void>
} {
  const queue: Array<() => void> = []
  return {
    queue,
    idle: (fn) => {
      queue.push(fn)
      return () => {
        const i = queue.indexOf(fn)
        if (i >= 0) queue.splice(i, 1)
      }
    },
    async drain() {
      for (let n = 0; n < 100 && queue.length > 0; n++) {
        queue.shift()!()
        await settle()
      }
    }
  }
}

/** A scanned source of `n` pages whose native text is empty. */
function scan(id: string, n: number, texts: Map<string, ReturnType<typeof nativeText>>) {
  const s = source(id)
  for (let i = 0; i < n; i++) texts.set(keyOf(s, i), nativeText(0))
  return s
}

/** Answer the last triage request for `src` with `cls` for every page it asked about. */
function answerTriage(
  port: FakeOcrPort,
  cls: Parameters<typeof triaged>[1] | ((i: number) => Parameters<typeof triaged>[1])
): void {
  const t = port.of('triage').at(-1) as { src: string; pages?: number[] }
  port.emit({
    triaged: {
      src: t.src,
      pages: (t.pages ?? []).map((i) => triaged(i, typeof cls === 'function' ? cls(i) : cls)),
      done: true
    }
  })
}

/** Answer every page of the last recognize request with a recognised page. */
function answerAll(port: FakeOcrPort, words = ['hello']): void {
  const r = port.recognizes().at(-1)!
  for (const p of r.pages)
    port.emit({
      result: { jobId: r.jobId, src: r.src, index: p.index, page: okResult(recognisedPage(words)) }
    })
  port.emit({ jobDone: { jobId: r.jobId, done: r.pages.length, failed: 0, cancelled: false } })
}

describe('connecting lazily', () => {
  it('a text PDF never connects: Stage 0 reads ≤ 8 pages through Find and finds no candidate', async () => {
    const texts = new Map()
    const s = source('txt')
    for (let i = 0; i < 20; i++) texts.set(keyOf(s, i), nativeText(400))
    const { store, port, text } = rig({ texts })
    store.reconcile([
      doc(
        'd',
        Array.from({ length: 20 }, (_, i) => pageOf(s, i))
      )
    ])
    await settle(40)
    expect(port.connects).toBe(0)
    expect(port.posts).toEqual([])
    // The search engine's own extractor, the first 8 pages only (no double extraction: Find's
    // store is the only one).
    expect(text.reads).toEqual(Array.from({ length: 8 }, (_, i) => keyOf(s, i)))
  })

  it('a scan opens the gate: connect, then open and triage, and nothing is recognised unasked', async () => {
    const texts = new Map()
    const s = scan('scan', 3, texts)
    const { store, port } = rig({ texts })
    store.reconcile([
      doc(
        'd',
        [0, 1, 2].map((i) => pageOf(s, i))
      )
    ])
    await settle()
    expect(port.connects).toBe(1)
    expect(port.kinds()).toEqual(['open', 'triage'])
    expect(port.of('triage')[0]).toMatchObject({ pages: [0, 1, 2] })
    answerTriage(port, 'scanned')
    await settle()
    expect(port.recognizes()).toEqual([])
    expect(store.getPageState(keyOf(s, 0))).toMatchObject({ pageClass: 'scanned', status: 'none' })
    expect(store.scannedPageKeys()).toEqual([0, 1, 2].map((i) => keyOf(s, i)))
  })

  it("Find's full extraction opens the gate for a scan after page 8", async () => {
    const texts = new Map()
    const s = source('late')
    for (let i = 0; i < 12; i++) texts.set(keyOf(s, i), nativeText(400))
    const { store, port, text } = rig({ texts })
    store.reconcile([
      doc(
        'd',
        Array.from({ length: 12 }, (_, i) => pageOf(s, i))
      )
    ])
    await settle(40)
    expect(port.connects).toBe(0)
    // A search ran: Find extracted page 11, which has no text.
    text.extracted(keyOf(s, 11), nativeText(3))
    await settle()
    expect(port.connects).toBe(1)
    expect(port.kinds()).toEqual(['open', 'triage'])
  })

  it('without a port OCR is unavailable and requests return null', () => {
    const text = new FakeText()
    const store = createOcrStore({ port: null, text })
    stores.push(store)
    const s = source('x')
    store.reconcile([doc('d', [pageOf(s, 0)])])
    expect(store.getSnapshot()).toMatchObject({ link: 'unavailable', unavailable: 'no-port' })
    expect(store.recognize([keyOf(s, 0)])).toBeNull()
  })
})

describe('Stage 0 scheduling', () => {
  it('runs at idle priority: nothing is read before the idle callback, then one page per slice', async () => {
    const texts = new Map()
    const s = source('idle')
    for (let i = 0; i < 3; i++) texts.set(keyOf(s, i), nativeText(400))
    const m = manualIdle()
    const { store, port, text } = rig({ texts, idle: m.idle })
    store.reconcile([
      doc(
        'd',
        [0, 1, 2].map((i) => pageOf(s, i))
      )
    ])
    await settle()
    expect(text.reads).toEqual([])
    expect(port.connects).toBe(0)
    expect(m.queue).toHaveLength(1)
    m.queue.shift()!()
    await settle()
    expect(text.reads).toEqual([keyOf(s, 0)])
    // The next page waits for the next idle slice.
    expect(m.queue).toHaveLength(1)
    await m.drain()
    expect(text.reads).toEqual([0, 1, 2].map((i) => keyOf(s, i)))
    expect(port.connects).toBe(0)
  })

  it('a source deleted before its idle slice and restored by undo is still checked', async () => {
    const texts = new Map()
    const s = scan('undo', 1, texts)
    const m = manualIdle()
    const { store, port } = rig({ texts, idle: m.idle })
    const d = [doc('d', [pageOf(s, 0)])]
    store.reconcile(d)
    await settle()
    store.reconcile([])
    await m.drain()
    expect(port.connects).toBe(0)
    store.reconcile(d)
    await settle()
    await m.drain()
    expect(port.connects).toBe(1)
    expect(port.kinds()).toEqual(['open', 'triage'])
  })

  it('a page deleted while Stage 0 reads it is no evidence: a text PDF still never connects', async () => {
    class Vanishing extends FakeText {
      onRead: ((key: string) => boolean) | null = null
      override async readNative(key: string) {
        if (this.onRead?.(key)) {
          this.reads.push(key)
          return undefined // what the engine answers for a key that stopped being live
        }
        return super.readNative(key)
      }
    }
    const s = source('vt')
    const text = new Vanishing()
    for (let i = 0; i < 10; i++) text.texts.set(keyOf(s, i), nativeText(400))
    const { store, port } = rig({ text })
    const pages = Array.from({ length: 10 }, (_, i) => pageOf(s, i))
    text.onRead = (key) => {
      if (key !== keyOf(s, 0)) return false
      text.onRead = null
      store.reconcile([doc('d', pages.slice(1))])
      return true
    }
    store.reconcile([doc('d', pages)])
    await settle(40)
    expect(port.connects).toBe(0)
    expect(port.posts).toEqual([])
    // Checked again from the pages that are left.
    expect(text.reads.slice(1)).toEqual(Array.from({ length: 8 }, (_, i) => keyOf(s, i + 1)))
  })
})

describe('D4: imported images', () => {
  it('auto-recognises a PDFx-made image source, triage first, with the settings languages', async () => {
    const { store, port } = rig({ settings: { 'ocr.languages': ['deu', 'eng'] } })
    const s = source('img', { origin: 'image' })
    store.reconcile([doc('d', [pageOf(s, 0)])])
    await settle()
    // No Stage 0 for an imported image, and triage BEFORE recognize (PR6: DPI and masking).
    expect(port.kinds()).toEqual(['open', 'triage'])
    answerTriage(port, 'scanned')
    await settle()
    expect(port.kinds()).toEqual(['open', 'triage', 'recognize'])
    const r = port.recognizes()[0]
    expect(r.opts.langs).toEqual(['deu', 'eng'])
    expect(r.pages).toEqual([{ index: 0, userUnit: 1, width: 612, height: 792 }])
    expect(store.getSnapshot().batches[0]).toMatchObject({
      kind: 'auto',
      state: 'running',
      total: 1
    })
    answerAll(port)
    await settle()
    expect(store.getSnapshot().batches[0]).toMatchObject({ state: 'done', recognized: 1, total: 1 })
    expect(store.getPageState(keyOf(s, 0))).toMatchObject({ status: 'ok', hasText: true })
  })

  it('does nothing with auto-recognition off (no connect, no bytes copied)', async () => {
    const texts = new Map()
    const { store, port, text } = rig({ texts, settings: { 'ocr.autoRecognizeImports': false } })
    const s = source('img', { origin: 'image' })
    const img = doc('d', [pageOf(s, 0)])
    store.reconcile([img])
    await settle(20)
    expect(port.connects).toBe(0)
    expect(port.posts).toEqual([])
    // Not even when something else connects: a scan opened in another document is triaged, and
    // the image's bytes still stay here until someone asks for it.
    const scanned = scan('other', 1, texts)
    store.reconcile([img, doc('e', [pageOf(scanned, 0)])])
    await settle()
    expect(port.kinds()).toEqual(['open', 'triage'])
    expect(port.of('open')).toHaveLength(1)
    // Find extracting the image page (no text) does not send it either.
    text.extracted(keyOf(s, 0), nativeText(0))
    await settle()
    expect(port.of('open')).toHaveLength(1)
    // An explicit request does.
    store.recognize([keyOf(s, 0)])
    await settle()
    expect(port.of('open')).toHaveLength(2)
  })
})

describe('failure paths of a request', () => {
  it('a request on a source the coordinator refused fails at once (never waits forever)', async () => {
    const texts = new Map()
    const s = scan('big', 1, texts)
    const { store, port } = rig({ texts })
    const d = [doc('d', [pageOf(s, 0)])]
    store.reconcile(d)
    await settle()
    const src = port.of('open')[0].src
    port.emit({ error: { code: 'too-large', message: 'too large', src } })
    port.clear()
    const id = store.recognize([keyOf(s, 0)])!
    await settle()
    expect(port.recognizes()).toEqual([])
    expect(store.getSnapshot().batches.find((b) => b.id === id)).toMatchObject({
      state: 'done',
      failed: 1,
      total: 1
    })
    expect(store.getPageState(keyOf(s, 0))).toMatchObject({
      status: 'too-large',
      reason: 'source-too-large'
    })
    // Nothing pending: an export does not ask.
    await expect(store.exportSource.flushOrConfirm(d)).resolves.toBe(true)
    expect(store.getPrompt()).toBeNull()
  })

  it('a page triage could not classify, recognised because it was asked for, is exported and searched', async () => {
    const texts = new Map()
    const s = source('nul')
    texts.set(keyOf(s, 0), nativeText(0))
    const { store, port } = rig({ texts })
    const d = [doc('d', [pageOf(s, 0)])]
    store.reconcile(d)
    await settle()
    answerTriage(port, null)
    await settle()
    store.recognize([keyOf(s, 0)])
    await settle()
    expect(port.recognizes()).toHaveLength(1)
    answerAll(port, ['nulltext'])
    await settle()
    expect(store.getSnapshot().batches[0]).toMatchObject({ state: 'done', recognized: 1 })
    expect(store.getPageState(keyOf(s, 0))).toMatchObject({ status: 'ok', hasText: true })
    expect(store.pageSupply(keyOf(s, 0))?.page?.text).toBe('nulltext')
    expect(store.exportSource.snapshotFor(d, emptyLayer())?.get(keyOf(s, 0))?.text).toBe('nulltext')
  })

  it('triage of a source stops after two crashes; a named page is still recognised', async () => {
    const texts = new Map()
    const s = scan('tc', 2, texts)
    const { store, port } = rig({ texts })
    store.reconcile([doc('d', [pageOf(s, 0), pageOf(s, 1)])])
    await settle()
    expect(port.of('triage')).toHaveLength(1)
    for (let crash = 0; crash < 2; crash++) {
      port.disconnected('crashed')
      port.connected()
      await settle()
    }
    // The second crash's respawn triaged once more; after it, no third triage goes out.
    expect(port.of('triage')).toHaveLength(2)
    port.connected()
    await settle()
    expect(port.of('triage')).toHaveLength(2)
    store.recognize([keyOf(s, 0)])
    await settle()
    expect(port.of('triage')).toHaveLength(2)
    expect(port.recognizes().map((r) => r.pages.map((p) => p.index))).toEqual([[0]])
  })
})

describe('requests', () => {
  it('a user request waits for triage, recognises the scans and counts the text page as skipped', async () => {
    const texts = new Map()
    const s = source('mix')
    texts.set(keyOf(s, 0), nativeText(400))
    texts.set(keyOf(s, 1), nativeText(0))
    const { store, port } = rig({ texts })
    store.reconcile([doc('d', [pageOf(s, 0), pageOf(s, 1)])])
    await settle()
    const src = port.of('open')[0].src
    port.clear()
    const id = store.recognize([keyOf(s, 0), keyOf(s, 1)])!
    await settle()
    expect(port.recognizes()).toEqual([]) // triage has not answered
    port.emit({
      triaged: {
        src,
        pages: [triaged(0, 'text'), triaged(1, 'scanned')],
        done: true
      }
    })
    await settle()
    const r = port.recognizes()
    expect(r).toHaveLength(1)
    expect(r[0].pages.map((p) => p.index)).toEqual([1])
    const b = store.getSnapshot().batches.find((x) => x.id === id)!
    expect(b).toMatchObject({ skipped: 1, total: 2, done: 1 })
    expect(store.getPageState(keyOf(s, 0))).toMatchObject({ pageClass: 'text', skip: 'has-text' })
  })

  it('the page in view goes first, and the coordinator is told (focus)', async () => {
    const texts = new Map()
    const s = scan('f', 5, texts)
    const { store, port } = rig({ texts })
    store.reconcile([
      doc(
        'd',
        [0, 1, 2, 3, 4].map((i) => pageOf(s, i))
      )
    ])
    store.setFocus(keyOf(s, 3))
    await settle()
    expect(port.of('triage')[0]).toMatchObject({ pages: [3, 0, 1, 2, 4] })
    answerTriage(port, 'scanned')
    store.recognize([0, 1, 2, 3, 4].map((i) => keyOf(s, i)))
    await settle()
    expect(port.recognizes()[0].pages.map((p) => p.index)).toEqual([3, 0, 1, 2, 4])
    expect(port.of('focus').at(-1)).toEqual({ src: port.recognizes()[0].src, index: 3 })
  })

  it('cancel stops the job: the coordinator is told, finished pages stay', async () => {
    const texts = new Map()
    const s = scan('c', 3, texts)
    const { store, port } = rig({ texts })
    store.reconcile([
      doc(
        'd',
        [0, 1, 2].map((i) => pageOf(s, i))
      )
    ])
    await settle()
    answerTriage(port, 'scanned')
    const id = store.recognize([0, 1, 2].map((i) => keyOf(s, i)))!
    await settle()
    const r = port.recognizes()[0]
    port.emit({
      result: { jobId: r.jobId, src: r.src, index: 0, page: okResult(recognisedPage(['kept'])) }
    })
    store.cancel(id)
    expect(port.of('cancel')).toEqual([r.jobId])
    const b = store.getSnapshot().batches[0]
    expect(b).toMatchObject({ state: 'stopped', recognized: 1, done: 1, total: 3 })
    expect(store.getPageState(keyOf(s, 0))).toMatchObject({ hasText: true })
    expect(store.getPageState(keyOf(s, 1))).toMatchObject({ status: 'none', hasText: false })
  })

  it('skipped-protected counts as done for the coordinator but is a skip here', async () => {
    const texts = new Map()
    const s = scan('p', 1, texts)
    const { store, port } = rig({ texts })
    store.reconcile([doc('d', [pageOf(s, 0)])])
    await settle()
    // A replace goes out whatever the class (here: no verdict yet → the coordinator decides).
    answerTriage(port, 'scanned')
    store.recognize([keyOf(s, 0)])
    await settle()
    const r = port.recognizes()[0]
    port.emit({
      result: {
        jobId: r.jobId,
        src: r.src,
        index: 0,
        page: { status: 'skipped-protected', renderDpi: null, raster: null, recognition: null }
      }
    })
    port.emit({ jobDone: { jobId: r.jobId, done: 1, failed: 0, cancelled: false } })
    expect(store.getSnapshot().batches[0]).toMatchObject({
      recognized: 0,
      skipped: 1,
      state: 'done'
    })
    expect(store.getPageState(keyOf(s, 0))).toMatchObject({ skip: 'protected', hasText: false })
  })

  it('a malformed message is dropped and jobDone fails the page it would have answered', async () => {
    const texts = new Map()
    const s = scan('m', 1, texts)
    const { store, port } = rig({ texts })
    store.reconcile([doc('d', [pageOf(s, 0)])])
    await settle()
    answerTriage(port, 'scanned')
    store.recognize([keyOf(s, 0)])
    await settle()
    const r = port.recognizes()[0]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bad = okResult(recognisedPage(['x']))
    ;(bad.recognition as unknown as { wordOff: Uint32Array }).wordOff = new Uint32Array([0, 99])
    port.emit({ result: { jobId: r.jobId, src: r.src, index: 0, page: bad } })
    port.emit({
      result: {
        jobId: r.jobId,
        src: r.src,
        index: 0,
        page: okResult(recognisedPage(['x'])),
        extra: 1
      }
    })
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
    expect(store.getPageState(keyOf(s, 0))).toMatchObject({ status: 'running' })
    port.emit({ jobDone: { jobId: r.jobId, done: 1, failed: 0, cancelled: false } })
    expect(store.getPageState(keyOf(s, 0))).toMatchObject({ status: 'failed', hasText: false })
    expect(store.getSnapshot().batches[0]).toMatchObject({ failed: 1, state: 'done' })
  })
})

describe('reconcile by source token', () => {
  it('duplicates share one token; close only when no live page uses the source', async () => {
    const texts = new Map()
    const s = scan('dup', 1, texts)
    // A duplicate (freshPageCopy): a new source id, the SAME bytes.
    const copy: PdfSource = { ...s, id: 'dup-copy' }
    texts.set(keyOf(copy, 0), nativeText(0))
    const { store, port } = rig({ texts })
    const a = doc('a', [pageOf(s, 0)])
    const b = doc('b', [pageOf(copy, 0)])
    store.reconcile([a, b])
    await settle()
    expect(port.of('open')).toHaveLength(1)
    answerTriage(port, 'scanned')
    store.recognize([keyOf(s, 0), keyOf(copy, 0)])
    await settle()
    // One page of one source: recognised once for both keys.
    expect(port.recognizes()).toHaveLength(1)
    expect(port.recognizes()[0].pages).toHaveLength(1)
    answerAll(port, ['shared'])
    await settle()
    expect(store.getPageState(keyOf(copy, 0))).toMatchObject({ hasText: true })
    store.reconcile([b])
    expect(port.of('close')).toEqual([])
    store.reconcile([])
    expect(port.of('close')).toEqual([port.of('open')[0].src])
  })

  it('move then remove: the moved page keeps its work and its results', async () => {
    const texts = new Map()
    const s = scan('mv', 2, texts)
    const { store, port } = rig({ texts })
    const p0 = pageOf(s, 0)
    const p1 = pageOf(s, 1)
    store.reconcile([doc('A', [p0, p1])])
    await settle()
    answerTriage(port, 'scanned')
    store.recognize([keyOf(s, 0), keyOf(s, 1)])
    await settle()
    const r = port.recognizes()[0]
    // Page 1 moves to document B, then A is removed.
    store.reconcile([doc('A', [p0]), doc('B', [p1])])
    store.reconcile([doc('B', [p1])])
    await settle()
    expect(port.of('close')).toEqual([])
    expect(port.of('cancel')).toEqual([])
    port.emit({
      result: { jobId: r.jobId, src: r.src, index: 1, page: okResult(recognisedPage(['moved'])) }
    })
    expect(store.getPageState(keyOf(s, 1))).toMatchObject({ hasText: true })
    const snap = store.exportSource.snapshotFor([doc('B', [p1])], emptyLayer())
    expect([...(snap?.keys() ?? [])]).toEqual([keyOf(s, 1)])
  })

  it('a source nobody uses any more: its queued work goes silently and it is closed', async () => {
    const texts = new Map()
    const s = scan('gone', 2, texts)
    const { store, port } = rig({ texts })
    store.reconcile([doc('A', [pageOf(s, 0), pageOf(s, 1)])])
    await settle()
    answerTriage(port, 'scanned')
    const id = store.recognize([keyOf(s, 0), keyOf(s, 1)])!
    await settle()
    const r = port.recognizes()[0]
    store.reconcile([])
    expect(port.of('cancel')).toEqual([r.jobId])
    expect(port.of('close')).toEqual([r.src])
    // Not "done": nothing was recognised, the pages went away (a toast must not say finished).
    expect(store.getSnapshot().batches.find((b) => b.id === id)).toMatchObject({
      total: 0,
      state: 'stopped'
    })
  })

  it('an imported image removed mid-recognition and restored by undo is recognised again', async () => {
    const { store, port } = rig()
    const s = source('img', { origin: 'image' })
    const d = [doc('d', [pageOf(s, 0)])]
    store.reconcile(d)
    await settle()
    answerTriage(port, 'scanned')
    await settle()
    expect(port.recognizes()).toHaveLength(1)
    store.reconcile([])
    expect(port.kinds().slice(-2)).toEqual(['cancel', 'close'])
    expect(store.getSnapshot().batches[0]).toMatchObject({ kind: 'auto', state: 'stopped' })
    port.clear()
    store.reconcile(d)
    await settle()
    // Opened again (the verdict is kept: no second triage) and recognised.
    expect(port.kinds().filter((k) => k !== 'focus')).toEqual(['open', 'recognize'])
    expect(store.getSnapshot().batches.at(-1)).toMatchObject({ kind: 'auto', state: 'running' })
    answerAll(port, ['back'])
    await settle()
    expect(store.getPageState(keyOf(s, 0))).toMatchObject({ status: 'ok', hasText: true })
  })

  it('a deleted page of an auto-recognised image comes back with its recognition (page-level undo)', async () => {
    const { store, port } = rig()
    const s = source('img2', { origin: 'image' })
    const p0 = pageOf(s, 0)
    const p1 = pageOf(s, 1)
    store.reconcile([doc('d', [p0, p1])])
    await settle()
    // Triage answers page 0 only: page 1's work is still unsent when it is deleted.
    const t = port.of('triage')[0]
    port.emit({ triaged: { src: t.src, pages: [triaged(0, 'scanned')], done: false } })
    await settle()
    store.reconcile([doc('d', [p0])])
    await settle()
    port.emit({ triaged: { src: t.src, pages: [triaged(1, 'scanned')], done: true } })
    await settle()
    expect(port.recognizes().flatMap((r) => r.pages.map((p) => p.index))).toEqual([0])
    store.reconcile([doc('d', [p0, p1])])
    await settle()
    expect(port.recognizes().flatMap((r) => r.pages.map((p) => p.index))).toEqual([0, 1])
  })
})

describe('crashes', () => {
  async function running(n: number): Promise<Rig & { s: PdfSource; keys: string[] }> {
    const texts = new Map()
    const s = scan('cr', n, texts)
    const r = rig({ texts })
    const keys = Array.from({ length: n }, (_, i) => keyOf(s, i))
    r.store.reconcile([
      doc(
        'd',
        keys.map((_, i) => pageOf(s, i))
      )
    ])
    await settle()
    r.port.connected()
    answerTriage(r.port, 'scanned')
    r.store.recognize(keys)
    await settle()
    return { ...r, s, keys }
  }

  it('crash → held for Resume (finished pages kept); Resume sends only what is left', async () => {
    const { store, port, s, keys } = await running(4)
    const r = port.recognizes()[0]
    port.emit({
      result: { jobId: r.jobId, src: r.src, index: 0, page: okResult(recognisedPage(['zero'])) }
    })
    port.emit({
      progress: { jobId: r.jobId, doneOrFailed: 1, total: 4, inflightFrac: 0.5, inflight: [1] }
    })
    port.disconnected('crashed')
    const b = store.getSnapshot().batches[0]
    expect(b).toMatchObject({ state: 'crashed', done: 1, total: 4 })
    expect(store.getPageState(keys[1])).toMatchObject({ status: 'held' })
    expect(store.getPageState(keys[0])).toMatchObject({ hasText: true })
    // Main respawned the process and handed over a port; nothing restarts until Resume.
    port.connected()
    port.clear()
    await settle()
    expect(port.recognizes()).toEqual([])
    store.resume()
    await settle()
    // A fresh session: the source is opened again; triage verdicts are kept (no re-triage).
    expect(port.kinds().filter((k) => k !== 'focus')).toEqual(['open', 'recognize'])
    expect(port.recognizes()[0].pages.map((p) => p.index)).toEqual([1, 2, 3])
    void s
  })

  it('a page implicated in two crashes is failed and never retried', async () => {
    const { store, port, keys } = await running(3)
    for (let crash = 0; crash < 2; crash++) {
      const r = port.recognizes().at(-1)!
      port.emit({
        progress: {
          jobId: r.jobId,
          doneOrFailed: 0,
          total: r.pages.length,
          inflightFrac: 0.3,
          inflight: [1]
        }
      })
      port.disconnected('crashed')
      port.connected()
      store.resume()
      await settle()
    }
    expect(store.getPageState(keys[1])).toMatchObject({
      status: 'failed',
      reason: 'recognize-crash'
    })
    expect(
      port
        .recognizes()
        .at(-1)!
        .pages.map((p) => p.index)
    ).toEqual([0, 2])
    // Asking again does not retry it either.
    port.clear()
    store.recognize([keys[1]])
    await settle()
    expect(port.recognizes()).toEqual([])
  })

  it('a port lost without a crash (a replaced port) resends without implicating anyone', async () => {
    const { store, port, keys } = await running(2)
    const r = port.recognizes()[0]
    port.emit({
      progress: { jobId: r.jobId, doneOrFailed: 0, total: 2, inflightFrac: 0.3, inflight: [0] }
    })
    port.clear()
    port.connected() // a new session without a disconnect: the old one is void
    await settle()
    expect(port.kinds().filter((k) => k !== 'focus')).toEqual(['open', 'recognize'])
    expect(store.getSnapshot().batches[0].state).toBe('running')
    expect(store.getPageState(keys[0])).toMatchObject({ status: 'running' })
  })

  it('asking again for a page a crash holds takes it over (instead of an empty "done" request)', async () => {
    const { store, port, keys } = await running(1)
    port.disconnected('crashed')
    port.connected()
    await settle()
    port.clear()
    const id = store.recognize([keys[0]])!
    await settle()
    expect(port.recognizes()).toHaveLength(1)
    const views = store.getSnapshot().batches
    expect(views.find((b) => b.id === id)).toMatchObject({ state: 'running', total: 1, done: 0 })
    // The crashed request let it go: nothing left to Resume there.
    expect(views[0]).toMatchObject({ state: 'stopped' })
    answerAll(port, ['again'])
    await settle()
    expect(store.getSnapshot().batches.find((b) => b.id === id)).toMatchObject({
      state: 'done',
      recognized: 1
    })
  })

  it('a request for a page another request is running follows it; stopping the other keeps it', async () => {
    const { store, port, keys } = await running(1)
    const first = store.getSnapshot().batches[0].id
    const id = store.recognize([keys[0]])!
    await settle()
    // Not sent twice, and not reported done while the page is still out.
    expect(port.recognizes()).toHaveLength(1)
    expect(store.getSnapshot().batches.find((b) => b.id === id)).toMatchObject({
      state: 'running',
      total: 1,
      done: 0
    })
    // The user stops the first request: the page goes out again for the second.
    store.cancel(first)
    await settle()
    expect(port.of('cancel')).toEqual([port.recognizes()[0].jobId])
    expect(port.recognizes()).toHaveLength(2)
    answerAll(port, ['kept'])
    await settle()
    expect(store.getSnapshot().batches.find((b) => b.id === id)).toMatchObject({
      state: 'done',
      recognized: 1
    })
    expect(store.getPageState(keys[0])).toMatchObject({ status: 'ok', hasText: true })
  })

  it('a follower counts the outcome too when the page finishes', async () => {
    const { store, port, keys } = await running(1)
    const id = store.recognize([keys[0]])!
    await settle()
    answerAll(port, ['both'])
    await settle()
    const views = store.getSnapshot().batches
    expect(views[0]).toMatchObject({ state: 'done', recognized: 1 })
    expect(views.find((b) => b.id === id)).toMatchObject({ state: 'done', recognized: 1 })
  })

  it('crash-loop ends OCR for the session', async () => {
    const { store, port } = await running(1)
    port.disconnected('crash-loop')
    expect(store.getSnapshot()).toMatchObject({ link: 'unavailable', unavailable: 'crash-loop' })
    expect(store.getSnapshot().batches[0].state).toBe('failed')
  })
})

describe('progress', () => {
  it('reports in-flight progress and an EWMA ETA once 3 pages are done', async () => {
    let t = 0
    const texts = new Map()
    const s = scan('eta', 6, texts)
    const { store, port } = rig({ texts, now: () => t })
    store.reconcile([
      doc(
        'd',
        Array.from({ length: 6 }, (_, i) => pageOf(s, i))
      )
    ])
    await settle()
    answerTriage(port, 'scanned')
    store.recognize(Array.from({ length: 6 }, (_, i) => keyOf(s, i)))
    await settle()
    const r = port.recognizes()[0]
    const finish = (i: number): void =>
      port.emit({
        result: { jobId: r.jobId, src: r.src, index: i, page: okResult(recognisedPage(['w'])) }
      })
    t = 1000
    finish(0)
    t = 2000
    finish(1)
    expect(store.getSnapshot().batches[0].etaMs).toBeNull()
    t = 3000
    finish(2)
    port.emit({ progress: { jobId: r.jobId, doneOrFailed: 3, total: 6, inflightFrac: 0.5 } })
    const b = store.getSnapshot().batches[0]
    expect(b.inflightFrac).toBe(0.5)
    // 1000 ms per page, 2.5 pages left.
    expect(b.etaMs).toBeCloseTo(2500)
  })

  it('notifies subscribers at most 10 times a second', async () => {
    vi.useFakeTimers()
    const texts = new Map()
    const s = scan('n', 1, texts)
    const { store, port } = rig({ texts })
    store.reconcile([doc('d', [pageOf(s, 0)])])
    await vi.advanceTimersByTimeAsync(50)
    answerTriage(port, 'scanned')
    store.recognize([keyOf(s, 0)])
    await vi.advanceTimersByTimeAsync(50)
    const r = port.recognizes()[0]
    expect(r).toBeDefined()
    const listener = vi.fn()
    store.subscribe(listener)
    // A progress message every 10 ms for one second: 100 state changes, spread over time.
    for (let i = 1; i <= 100; i++) {
      port.emit({
        progress: { jobId: r.jobId, doneOrFailed: 0, total: 1, inflightFrac: i / 101 }
      })
      await vi.advanceTimersByTimeAsync(10)
    }
    await vi.advanceTimersByTimeAsync(200)
    expect(listener.mock.calls.length).toBeGreaterThan(5)
    expect(listener.mock.calls.length).toBeLessThanOrEqual(12)
  })
})

describe('export snapshot and choices', () => {
  async function recognised(): Promise<Rig & { s: PdfSource; key: string; d: DocEntry[] }> {
    const texts = new Map()
    const s = scan('ex', 1, texts)
    const r = rig({ texts })
    const d = [doc('d', [pageOf(s, 0)])]
    r.store.reconcile(d)
    await settle()
    answerTriage(r.port, 'scanned')
    r.store.recognize([keyOf(s, 0)])
    await settle()
    answerAll(r.port, ['auto'])
    return { ...r, s, key: keyOf(s, 0), d }
  }

  it('auto results of scanned pages; the ocrSelect choice wins (Remove = nothing)', async () => {
    const { store, key, d } = await recognised()
    expect(store.exportSource.snapshotFor(d, emptyLayer())?.get(key)?.text).toBe('auto')
    expect(store.exportSource.snapshotFor(d, emptyLayer(new Map([[key, null]])))).toBeUndefined()
    // A choice naming a config the store lacks bakes nothing (never another result).
    expect(store.exportSource.snapshotFor(d, emptyLayer(new Map([[key, 'other']])))).toBeUndefined()
  })

  it('an ocr-ours page exports with no auto result unless the user chose one', async () => {
    const texts = new Map()
    const s = source('ours')
    texts.set(keyOf(s, 0), nativeText(0))
    const { store, port } = rig({ texts })
    const select = vi.fn()
    store.syncEdits({ selectOcr: select })
    const d = [doc('d', [pageOf(s, 0)])]
    store.reconcile(d)
    await settle()
    answerTriage(port, 'ocr-ours')
    // Replace records the choice FIRST (undoable), then recognises the page again.
    const hash = ocrConfig(['fra']).hash
    store.replace([keyOf(s, 0)], ['fra'])
    expect(select).toHaveBeenCalledWith(keyOf(s, 0), hash)
    await settle()
    expect(port.recognizes()[0].opts.langs).toEqual(['fra'])
    answerAll(port, ['neu'])
    expect(store.exportSource.snapshotFor(d, emptyLayer())).toBeUndefined()
    expect(
      store.exportSource
        .snapshotFor(d, emptyLayer(new Map([[keyOf(s, 0), hash]])))
        ?.get(keyOf(s, 0))?.text
    ).toBe('neu')
  })

  it('Remove records an undoable ocrSelect null; fed back, nothing is exported or found', async () => {
    const { store, key, d } = await recognised()
    const select = vi.fn()
    store.syncEdits({ selectOcr: select })
    store.remove([key])
    expect(select).toHaveBeenCalledWith(key, null)
    // EditProvider records the op and hands the new ocrSelect back.
    store.syncEdits({ ocrSelect: new Map([[key, null]]) })
    expect(store.exportSource.snapshotFor(d, emptyLayer(new Map([[key, null]])))).toBeUndefined()
    expect(store.pageSupply(key)?.page).toBeUndefined()
    expect(store.getPageState(key)).toMatchObject({ hasText: false })
  })

  it('undoing a Replace brings back the original automatic text (lossless Replace)', async () => {
    const { store, port, key, d } = await recognised()
    const hash = ocrConfig(['deu']).hash
    store.syncEdits({ selectOcr: vi.fn() })
    store.replace([key], ['deu'])
    await settle()
    answerAll(port, ['second'])
    await settle()
    const chosen = new Map([[key, hash]])
    store.syncEdits({ ocrSelect: chosen })
    expect(store.pageSupply(key)?.page?.text).toBe('second')
    expect(store.exportSource.snapshotFor(d, emptyLayer(chosen))?.get(key)?.text).toBe('second')
    // Ctrl+Z: the ocrSelect op is undone.
    store.syncEdits({ ocrSelect: new Map() })
    expect(store.pageSupply(key)?.page?.text).toBe('auto')
    expect(store.exportSource.snapshotFor(d, emptyLayer())?.get(key)?.text).toBe('auto')
  })

  it('includeInExports follows the D7 setting', async () => {
    const { store } = rig({ settings: { 'ocr.includeInExports': false } })
    await settle()
    expect(store.exportSource.includeInExports()).toBe(false)
    await store.setSettings({ 'ocr.includeInExports': true })
    expect(store.exportSource.includeInExports()).toBe(true)
  })
})

describe('flushOrConfirm', () => {
  async function pending(): Promise<Rig & { d: DocEntry[]; keys: string[] }> {
    const texts = new Map()
    const s = scan('fl', 2, texts)
    const r = rig({ texts })
    const keys = [keyOf(s, 0), keyOf(s, 1)]
    const d = [doc('d', [pageOf(s, 0), pageOf(s, 1)])]
    r.store.reconcile(d)
    await settle()
    answerTriage(r.port, 'scanned')
    r.store.recognize(keys)
    await settle()
    return { ...r, d, keys }
  }

  it('answers true at once when nothing is running', async () => {
    const { store } = rig()
    await expect(store.exportSource.flushOrConfirm([])).resolves.toBe(true)
    expect(store.getPrompt()).toBeNull()
  })

  it('asks while recognition runs; Cancel refuses, Export now accepts', async () => {
    const { store, d } = await pending()
    const a = store.exportSource.flushOrConfirm(d)
    expect(store.getPrompt()).toEqual({ kind: 'running', done: 0, total: 2 })
    store.answerPrompt('cancel')
    await expect(a).resolves.toBe(false)
    const b = store.exportSource.flushOrConfirm(d)
    store.answerPrompt('now')
    await expect(b).resolves.toBe(true)
    expect(store.getPrompt()).toBeNull()
  })

  it('Wait and export: a non-modal wait that ends when the last page is in', async () => {
    const { store, port, d } = await pending()
    const a = store.exportSource.flushOrConfirm(d)
    store.answerPrompt('wait')
    await settle(1)
    expect(store.getPrompt()).toMatchObject({ kind: 'waiting', done: 0, total: 2 })
    const r = port.recognizes()[0]
    port.emit({
      result: { jobId: r.jobId, src: r.src, index: 0, page: okResult(recognisedPage(['a'])) }
    })
    await settle(1)
    expect(store.getPrompt()).toMatchObject({ kind: 'waiting', done: 1, total: 2 })
    let settled = false
    void a.then(() => (settled = true))
    await settle(1)
    expect(settled).toBe(false)
    port.emit({
      result: { jobId: r.jobId, src: r.src, index: 1, page: okResult(recognisedPage(['b'])) }
    })
    await expect(a).resolves.toBe(true)
    expect(store.getPrompt()).toBeNull()
  })

  it('a crash while waiting asks again instead of exporting without the pages', async () => {
    const { store, port, d } = await pending()
    const a = store.exportSource.flushOrConfirm(d)
    store.answerPrompt('wait')
    await settle(1)
    port.disconnected('crashed')
    await settle(1)
    expect(store.getPrompt()).toMatchObject({ kind: 'stopped', done: 0, total: 2 })
    store.answerPrompt('cancel')
    await expect(a).resolves.toBe(false)
  })

  it("warns when a Replace's text is not in the store (instead of silently dropping the old layer)", async () => {
    const texts = new Map()
    const s = scan('rp', 1, texts)
    const { store } = rig({ texts })
    const d = [doc('d', [pageOf(s, 0)])]
    store.reconcile(d)
    store.syncEdits({ ocrSelect: new Map([[keyOf(s, 0), ocrConfig(['spa']).hash]]) })
    const a = store.exportSource.flushOrConfirm(d)
    await settle(1)
    expect(store.getPrompt()).toEqual({ kind: 'missing', pages: 1 })
    store.answerPrompt('cancel')
    await expect(a).resolves.toBe(false)
    const b = store.exportSource.flushOrConfirm(d)
    await settle(1)
    store.answerPrompt('now')
    await expect(b).resolves.toBe(true)
  })

  it('warns too when the Replace is held by a crash (no "running" prompt covers it)', async () => {
    const texts = new Map()
    const s = scan('rh', 1, texts)
    const { store, port } = rig({ texts })
    const key = keyOf(s, 0)
    const d = [doc('d', [pageOf(s, 0)])]
    store.reconcile(d)
    await settle()
    answerTriage(port, 'scanned')
    store.syncEdits({ selectOcr: vi.fn() })
    store.replace([key], ['spa'])
    store.syncEdits({ ocrSelect: new Map([[key, ocrConfig(['spa']).hash]]) })
    await settle()
    expect(port.recognizes()).toHaveLength(1)
    port.disconnected('crashed')
    expect(store.getPageState(key)).toMatchObject({ status: 'held' })
    const a = store.exportSource.flushOrConfirm(d)
    await settle(1)
    expect(store.getPrompt()).toEqual({ kind: 'missing', pages: 1 })
    store.answerPrompt('cancel')
    await expect(a).resolves.toBe(false)
  })

  it('a second export while one is waiting is refused', async () => {
    const { store, d } = await pending()
    const a = store.exportSource.flushOrConfirm(d)
    await expect(store.exportSource.flushOrConfirm(d)).resolves.toBe(false)
    store.answerPrompt('cancel')
    await expect(a).resolves.toBe(false)
  })
})

describe('PR8 reads: page-state fields and notifications for the OCR surfaces', () => {
  it('"Sideways — rotate?" is against the rotation the page was recognised at, and goes once turned', async () => {
    const texts = new Map<string, ReturnType<typeof nativeText>>()
    const s = scan('rot', 1, texts)
    const { store, port } = rig({ texts })
    const key = keyOf(s, 0)
    store.syncEdits({ rotations: new Map([[key, 90]]) })
    store.reconcile([doc('d', [pageOf(s, 0)])])
    await settle()
    answerTriage(port, 'scanned')
    store.recognize([key])
    await settle()
    const r = port.recognizes()[0]
    expect(r.pages[0].editRotation).toBe(90)
    port.emit({
      result: {
        jobId: r.jobId,
        src: r.src,
        index: 0,
        page: { ...okResult(recognisedPage(['x'])), rotateBy: 180 }
      }
    })
    await settle()
    expect(store.getPageState(key)?.rotateBy).toBe(180)
    // Turned a quarter more: a quarter the other way is still left.
    store.syncEdits({ rotations: new Map([[key, 180]]) })
    expect(store.getPageState(key)?.rotateBy).toBe(90)
    // Turned by exactly what was offered (the summary's [Rotate]): upright, no offer.
    store.syncEdits({ rotations: new Map([[key, 270]]) })
    expect(store.getPageState(key)?.rotateBy).toBeUndefined()
  })

  it('a rotation change notifies subscribers (the summary row must go)', async () => {
    vi.useFakeTimers()
    const { store } = rig()
    const listener = vi.fn()
    store.subscribe(listener)
    store.syncEdits({ rotations: new Map([['k', 90]]) })
    await vi.advanceTimersByTimeAsync(200)
    expect(listener).toHaveBeenCalled()
  })

  it('loading the stored settings notifies (the dialog, menu and Sign defaults follow them)', async () => {
    vi.useFakeTimers()
    const { store } = rig({ settings: { 'ocr.includeInExports': false } })
    const listener = vi.fn()
    store.subscribe(listener)
    await vi.advanceTimersByTimeAsync(200)
    expect(listener).toHaveBeenCalled()
    expect(store.settings()['ocr.includeInExports']).toBe(false)
  })

  it('scan / removed / triaged: an imported image is a scan before triage; Remove is "removed"', async () => {
    const img = source('img', { origin: 'image', bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) })
    const { store, port } = rig({ settings: { 'ocr.autoRecognizeImports': false } })
    const key = keyOf(img, 0)
    const selections = new Map<string, string | null>()
    store.syncEdits({
      ocrSelect: selections,
      selectOcr: (k, h) => {
        selections.set(k, h)
        store.syncEdits({ ocrSelect: new Map(selections) })
      }
    })
    store.reconcile([doc('d', [pageOf(img, 0)])])
    await settle()
    expect(store.getPageState(key)).toMatchObject({ scan: true, triaged: false, removed: false })
    store.prepare([key])
    await settle()
    answerTriage(port, 'text')
    expect(store.getPageState(key)).toMatchObject({ scan: false, triaged: true })
    store.remove([key])
    expect(store.getPageState(key)?.removed).toBe(true)
  })
})
