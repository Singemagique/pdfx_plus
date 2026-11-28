// Find over recognised text through the REAL search engine and the REAL OCR store (DESIGN.md
// §3.6.1, §3.7.3 rule 3): a scanned page becomes findable when its results arrive; a key that
// leaves and comes back is supplied again; redactions filter the words (rule 1 in the engine, rule
// 2 through the predicted removal report, fail-safe while it is pending or when it fails); a
// reopened `ocr-ours` page with a redaction loses its own layer from Find, as from the export; Copy
// Page Text copies the same filtered text.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { defaultSettings } from '../../../shared/settings'
import { makePageKey, type Overlay } from '../edit/model'
import type { EditLayer } from '../pdfx/build'
import type { FrameBox, RemovedReport } from '../pdfx/ocr-export'
import { createFindEngine, type FindEngine } from '../search/engine'
import { buildPageText, type PageText } from '../search/extract'
import { textMatchRects } from '../search/geometry'
import { compileQuery, normalizeQuery } from '../search/normalize'
import type { DocEntry, PdfSource } from '../types'
import { copyPageText } from './copy-page-text'
import { createOcrFindSupply, type OcrFindSupply, type RemovalPredictor } from './ocr-find-supply'
import { createOcrStore, type OcrStore } from './ocr-store'
import {
  FakeOcrPort,
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

const H = 792

interface Rig {
  engine: FindEngine
  store: OcrStore
  supply: OcrFindSupply
  port: FakeOcrPort
  s: PdfSource
  key: string
  docs: DocEntry[]
  layer: (reds?: Overlay[]) => EditLayer
}

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
})

/** A pdf.js stand-in whose pages carry the given native texts. */
function pdfWith(texts: PageText[]): PdfSource['pdf'] {
  return { texts, getPage: async () => ({ userUnit: 1 }) } as unknown as PdfSource['pdf']
}

async function rig(
  opts: { native?: PageText; natives?: PageText[]; predict?: RemovalPredictor } = {}
): Promise<Rig> {
  const s = source('scan')
  const natives = opts.natives ?? [opts.native ?? nativeText(0)]
  s.pdf = pdfWith(natives)
  const key = makePageKey(s.id, 0)
  const engine = createFindEngine({
    onChange: () => {},
    extract: async (pdf, i) => (pdf as unknown as { texts: PageText[] }).texts[i]
  })
  const port = new FakeOcrPort()
  const store = createOcrStore({
    port,
    text: engine,
    getSettings: async () => defaultSettings('en'),
    idle: eagerIdle
  })
  const supply = createOcrFindSupply({
    store,
    text: engine,
    predict: opts.predict ?? (async () => new Map()),
    debounceMs: 0
  })
  cleanup.push(() => {
    supply.dispose()
    store.dispose()
  })
  const docs = [
    doc(
      'd',
      natives.map((_, i) => pageOf(s, i))
    )
  ]
  const layer = (reds: Overlay[] = []): EditLayer => {
    const overlays = new Map<string, Overlay[]>()
    for (const o of reds) overlays.set(o.pageKey, [...(overlays.get(o.pageKey) ?? []), o])
    return { overlays, attachments: new Map() }
  }
  engine.reconcile(docs)
  store.reconcile(docs)
  supply.sync(docs, layer())
  await settle()
  return { engine, store, supply, port, s, key, docs, layer }
}

/** Triage the page as `cls`, recognise it, and answer with `words`. */
async function recognise(
  r: Rig,
  words: string[],
  cls: Parameters<typeof triaged>[1] = 'scanned',
  extra: Partial<ReturnType<typeof triaged>> = {}
): Promise<void> {
  const src = r.port.of('open')[0]?.src
  if (src) r.port.emit({ triaged: { src, pages: [{ ...triaged(0, cls), ...extra }], done: true } })
  await settle()
  if (cls === 'ocr-ours') r.store.replace([r.key], ['eng'])
  else r.store.recognize([r.key])
  await settle()
  const req = r.port.recognizes().at(-1)!
  r.port.emit({
    result: { jobId: req.jobId, src: req.src, index: 0, page: okResult(recognisedPage(words)) }
  })
  r.port.emit({ jobDone: { jobId: req.jobId, done: 1, failed: 0, cancelled: false } })
  await settle()
}

function hits(engine: FindEngine, q: string): string[] {
  const n = normalizeQuery(q)
  const m = engine.search(n, compileQuery(n)!)
  return [...m.entries()].filter(([, v]) => v).map(([k]) => k)
}

/** A redaction over the first recognised word ("hello" at x 72..102, baseline 700, 12 pt). */
const overHello = (key: string): Overlay => ({
  id: 'red-1',
  pageKey: key,
  z: 1,
  createdAt: 1,
  type: 'redaction',
  fill: { r: 0, g: 0, b: 0 },
  geom: { x: 70, y: 695, w: 34, h: 20, rotation: 0, opacity: 1 }
})
/** The same box in page px (top-left origin), as the find controller hands it to the engine. */
const helloPx = { x: 70, y: H - 715, w: 34, h: 20 }

/** A redaction in a margin of page `key` (it covers no word). */
const inMargin = (key: string, id = 'red-m', x = 560): Overlay => ({
  ...overHello(key),
  id,
  geom: { x, y: 20, w: 30, h: 20, rotation: 0, opacity: 1 }
})

/** A page's own (old) PDFx OCR layer as pdf.js reads it: 40 lines of text, so Stage 0 skips it. */
function oldLayer(): PageText {
  return buildPageText(
    Array.from({ length: 40 }, (_, i) => ({
      str: `oldlayer words line ${i} of the earlier recognition`,
      t: [12, 0, 0, 12, 72, 740 - i * 16],
      width: 300,
      height: 12,
      ascent: 0.8,
      descent: -0.2,
      vertical: false,
      rtl: false,
      hasEOL: true
    })),
    [1, 0, 0, -1, 0, H]
  )
}

describe('Find supply', () => {
  it('a scanned page becomes findable when its results arrive', async () => {
    const r = await rig()
    expect(hits(r.engine, 'hello')).toEqual([])
    await recognise(r, ['hello', 'world'])
    expect(hits(r.engine, 'hello world')).toEqual([r.key])
    expect(r.supply.filteredPage(r.key)?.text).toBe('helloworld')
  })

  it('a key that leaves and comes back is supplied again (with its viewport transform)', async () => {
    const r = await rig()
    await recognise(r, ['hello'])
    expect(hits(r.engine, 'hello')).toEqual([r.key])
    // Find is open (a key that comes back has its native text indexed again).
    r.engine.activate()
    r.engine.reconcile([])
    r.store.reconcile([])
    r.supply.sync([], r.layer())
    expect(hits(r.engine, 'hello')).toEqual([])
    r.engine.reconcile(r.docs)
    r.store.reconcile(r.docs)
    r.supply.sync(r.docs, r.layer())
    await settle()
    expect(hits(r.engine, 'hello')).toEqual([r.key])
  })

  it('a supply sent before the engine knew the key is sent again once it does', async () => {
    const r = await rig()
    await recognise(r, ['early'])
    r.engine.activate()
    // The engine forgets the key; the supply is told before the engine learns it again.
    r.engine.reconcile([])
    r.supply.sync([], r.layer())
    r.supply.sync(r.docs, r.layer())
    expect(hits(r.engine, 'early')).toEqual([])
    r.engine.reconcile(r.docs)
    r.supply.sync(r.docs, r.layer())
    await settle()
    expect(hits(r.engine, 'early')).toEqual([r.key])
  })

  it('rule 3, fail-safe: no recognised word is findable until the removal report is in', async () => {
    let release: (report: RemovedReport) => void = () => {}
    const predict = vi.fn(
      () => new Promise<RemovedReport>((resolve) => (release = resolve))
    ) as RemovalPredictor
    const r = await rig({ predict })
    await recognise(r, ['hello', 'world'])
    r.engine.setRedactions(r.key, [helloPx])
    r.supply.sync(r.docs, r.layer([overHello(r.key)]))
    await settle()
    // Pending: even the word the box does not touch is held back.
    expect(hits(r.engine, 'world')).toEqual([])
    expect(r.supply.filteredPage(r.key)).toBeNull()
    expect(predict).toHaveBeenCalledTimes(1)
    // The predictor runs the pass on the redacted OCR'd page only.
    const [layer] = vi.mocked(predict).mock.calls[0]
    expect([...layer.overlays.keys()]).toEqual([r.key])
    // Pixel redaction applied: nothing removed whole; only the word under the box goes.
    release(new Map([[r.key, []]]))
    await settle()
    expect(hits(r.engine, 'world')).toEqual([r.key])
    expect(hits(r.engine, 'hello')).toEqual([])
  })

  it('rule 2 in-app: the scan the pass will remove whole takes every word with it', async () => {
    const fullPage: FrameBox = { x: 0, y: 0, w: 612, h: 792 }
    const r = await rig({ predict: async () => new Map([[makePageKey('scan', 0), [fullPage]]]) })
    await recognise(r, ['hello', 'world'])
    r.supply.sync(r.docs, r.layer([overHello(r.key)]))
    await settle()
    expect(hits(r.engine, 'world')).toEqual([])
    expect(r.supply.filteredPage(r.key)).toBeNull()
  })

  it('a failed prediction, or one with no entry for the page, keeps the words out (fail-safe)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const predict of [
      async () => {
        throw new Error('pdfium')
      },
      async () => new Map()
    ] as RemovalPredictor[]) {
      const r = await rig({ predict })
      await recognise(r, ['hello', 'world'])
      r.supply.sync(r.docs, r.layer([overHello(r.key)]))
      await settle()
      expect(hits(r.engine, 'world')).toEqual([])
    }
    warn.mockRestore()
  })

  it('undoing the redaction brings the words back', async () => {
    const r = await rig({ predict: async () => new Map([[makePageKey('scan', 0), []]]) })
    await recognise(r, ['hello', 'world'])
    r.engine.setRedactions(r.key, [helloPx])
    r.supply.sync(r.docs, r.layer([overHello(r.key)]))
    await settle()
    expect(hits(r.engine, 'hello')).toEqual([])
    r.engine.setRedactions(r.key, null)
    r.supply.sync(r.docs, r.layer())
    await settle()
    expect(hits(r.engine, 'hello')).toEqual([r.key])
  })

  it('Remove (ocrSelect null) takes the words out of Find; undo puts them back', async () => {
    const r = await rig()
    await recognise(r, ['hello'])
    r.store.syncEdits({ ocrSelect: new Map([[r.key, null]]) })
    await settle()
    expect(hits(r.engine, 'hello')).toEqual([])
    r.store.syncEdits({ ocrSelect: new Map() })
    await settle()
    expect(hits(r.engine, 'hello')).toEqual([r.key])
  })

  it('a reopened ocr-ours page: Replace swaps its own layer for the new words, a redaction drops it', async () => {
    // The page's own (old) PDFx layer is native pdf.js text; triage's visible words are a stamp.
    const old = buildPageText(
      [
        {
          str: 'oldlayer words',
          t: [12, 0, 0, 12, 72, 600],
          width: 90,
          height: 12,
          ascent: 0.8,
          descent: -0.2,
          vertical: false,
          rtl: false,
          hasEOL: true
        }
      ],
      [1, 0, 0, -1, 0, H]
    )
    const r = await rig({
      native: old,
      predict: async () => new Map([[makePageKey('scan', 0), []]])
    })
    // Stage 0 never opened the gate (the page has text); the user asks to Replace.
    r.store.prepare([r.key])
    await settle()
    expect(hits(r.engine, 'oldlayer')).toEqual([r.key])
    await recognise(r, ['fresh'], 'ocr-ours', {
      nativeWords: [{ t: 'Stamp', x0: 72, y0: 40, x1: 110, y1: 52 }]
    })
    // Replace recorded `ocrSelect` through the edit bridge; feed it back as EditProvider would.
    r.store.syncEdits({
      ocrSelect: new Map([[r.key, (await import('./config')).ocrConfig(['eng']).hash]])
    })
    await settle()
    expect(hits(r.engine, 'fresh')).toEqual([r.key])
    expect(hits(r.engine, 'stamp')).toEqual([r.key])
    expect(hits(r.engine, 'oldlayer')).toEqual([])
  })

  it('an ocr-ours page with a redaction and no choice: its whole own layer leaves Find', async () => {
    const old = buildPageText(
      [
        {
          str: 'oldlayer words',
          t: [12, 0, 0, 12, 72, 600],
          width: 90,
          height: 12,
          ascent: 0.8,
          descent: -0.2,
          vertical: false,
          rtl: false,
          hasEOL: true
        }
      ],
      [1, 0, 0, -1, 0, H]
    )
    const r = await rig({ native: old })
    r.store.prepare([r.key])
    await settle()
    const src = r.port.of('open')[0].src
    r.port.emit({
      triaged: {
        src,
        pages: [
          {
            ...triaged(0, 'ocr-ours'),
            nativeWords: [{ t: 'Stamp', x0: 72, y0: 40, x1: 110, y1: 52 }]
          }
        ],
        done: true
      }
    })
    await settle()
    // Classified ocr-ours, no choice, no redaction: its own layer stays findable.
    expect(hits(r.engine, 'oldlayer')).toEqual([r.key])
    expect(hits(r.engine, 'stamp')).toEqual([])
    r.supply.sync(r.docs, r.layer([overHello(r.key)]))
    await settle()
    expect(hits(r.engine, 'words')).toEqual([])
    expect(hits(r.engine, 'stamp')).toEqual([r.key])
  })

  it('a redacted page triage has not classified yet: its native text is held out of Find and Copy until triage says', async () => {
    for (const verdict of ['ocr-ours', 'text'] as const) {
      const r = await rig({ native: oldLayer() })
      // Stage 0 read the page (text-rich: never sent); the old layer is ordinary native text.
      expect(r.port.connects).toBe(0)
      expect(hits(r.engine, 'oldlayer')).toEqual([r.key])
      r.supply.sync(r.docs, r.layer([inMargin(r.key)]))
      await settle()
      // Unknown class + a redaction: triage is asked for, and meanwhile nothing of it is found.
      expect(r.port.kinds()).toEqual(['open', 'triage'])
      expect(hits(r.engine, 'oldlayer')).toEqual([])
      const write = vi.fn(async () => {})
      await expect(
        copyPageText(r.key, { text: r.engine, supply: r.supply, write })
      ).resolves.toEqual({ copied: false, reason: 'empty' })
      const src = r.port.of('open')[0].src
      r.port.emit({
        triaged: {
          src,
          pages: [
            {
              ...triaged(0, verdict),
              nativeWords: [{ t: 'Stamp', x0: 72, y0: 40, x1: 110, y1: 52 }]
            }
          ],
          done: true
        }
      })
      await settle()
      if (verdict === 'ocr-ours') {
        // Its own layer goes in the export: only triage's visible words stay.
        expect(hits(r.engine, 'oldlayer')).toEqual([])
        expect(hits(r.engine, 'stamp')).toEqual([r.key])
      } else {
        // An ordinary text page: its text is back.
        expect(hits(r.engine, 'oldlayer')).toEqual([r.key])
      }
    }
  })

  it('a redaction on another page of the same source re-runs the prediction for the OCR page', async () => {
    const fullPage: FrameBox = { x: 0, y: 0, w: 612, h: 792 }
    const k1 = makePageKey('scan', 1)
    const predict = vi.fn(async (layer: EditLayer) =>
      // A failed pixel swap on page 1 makes the pass remove page 0's scan whole too.
      layer.overlays.has(k1)
        ? new Map([
            [makePageKey('scan', 0), [fullPage]],
            [k1, []]
          ])
        : new Map([[makePageKey('scan', 0), []]])
    ) as RemovalPredictor
    const r = await rig({ natives: [nativeText(0), nativeText(0)], predict })
    await recognise(r, ['hello', 'world'])
    r.supply.sync(r.docs, r.layer([overHello(r.key)]))
    await settle()
    expect(hits(r.engine, 'world')).toEqual([r.key])
    // Page 1 (no recognised text) gets a redaction: page 0's report no longer stands.
    r.supply.sync(r.docs, r.layer([overHello(r.key), inMargin(k1)]))
    await settle()
    expect(predict).toHaveBeenCalledTimes(2)
    const [layer] = vi.mocked(predict).mock.calls[1]
    expect([...layer.overlays.keys()].sort()).toEqual([r.key, k1].sort())
    expect(hits(r.engine, 'world')).toEqual([])
  })

  it('moving a redaction sends the page back to pending until the new report is in', async () => {
    const fullPage: FrameBox = { x: 0, y: 0, w: 612, h: 792 }
    let release: (report: RemovedReport) => void = () => {}
    let calls = 0
    const predict = vi.fn(async () => {
      calls++
      if (calls === 1) return new Map([[makePageKey('scan', 0), []]])
      return new Promise<RemovedReport>((resolve) => (release = resolve))
    }) as RemovalPredictor
    const r = await rig({ predict })
    await recognise(r, ['hello', 'world'])
    r.supply.sync(r.docs, r.layer([inMargin(r.key)]))
    await settle()
    expect(hits(r.engine, 'world')).toEqual([r.key])
    // The same box (same id) dragged onto the scan, where pixel redaction does not apply.
    r.supply.sync(r.docs, r.layer([inMargin(r.key, 'red-m', 300)]))
    await settle()
    expect(predict).toHaveBeenCalledTimes(2)
    expect(hits(r.engine, 'world')).toEqual([])
    release(new Map([[makePageKey('scan', 0), [fullPage]]]))
    await settle()
    expect(hits(r.engine, 'world')).toEqual([])
  })

  it('recognised words land where the page shows them, with a cropped page’s viewport transform', async () => {
    // A CropBox offset by (50, 40): vt = [1, 0, 0, −1, −50, 832] for a 612 × 792 view.
    const native = buildPageText([], [1, 0, 0, -1, -50, 832])
    const r = await rig({ native })
    await recognise(r, ['hello'])
    const box = (): { x: number; y: number; w: number; h: number } => {
      const pt = r.engine.getPageText(r.key)!
      const at = pt.norm.indexOf('hello')
      expect(at).toBeGreaterThanOrEqual(0)
      return textMatchRects(pt, at, at + 5)[0]
    }
    // "hello": x 72..102, baseline 700, 12 pt (ascent 0.8, descent 0.2) in the overlay frame →
    // page px (top-left origin): y from 792 − 709.6 to 792 − 697.6.
    const expectAt = (b: { x: number; y: number; w: number; h: number }): void => {
      expect(b.x).toBeCloseTo(72, 1)
      expect(b.w).toBeCloseTo(30, 1)
      expect(b.y).toBeCloseTo(82.4, 1)
      expect(b.h).toBeCloseTo(12, 1)
    }
    expectAt(box())
    // Leaves and comes back: supplied again in the same frame.
    r.engine.activate()
    r.engine.reconcile([])
    r.store.reconcile([])
    r.supply.sync([], r.layer())
    r.engine.reconcile(r.docs)
    r.store.reconcile(r.docs)
    r.supply.sync(r.docs, r.layer())
    await settle()
    expectAt(box())
  })

  it('Copy Page Text copies the filtered text, reading a page nobody searched first', async () => {
    const r = await rig({ predict: async () => new Map([[makePageKey('scan', 0), []]]) })
    await recognise(r, ['hello', 'world'])
    r.engine.setRedactions(r.key, [helloPx])
    r.supply.sync(r.docs, r.layer([overHello(r.key)]))
    const write = vi.fn(async () => {})
    const out = await copyPageText(r.key, { text: r.engine, supply: r.supply, write })
    expect(out).toEqual({ copied: true, chars: 'world'.length })
    expect(write).toHaveBeenCalledWith('world')
    // Nothing to copy: the clipboard is left alone.
    const empty = await rig()
    write.mockClear()
    await expect(
      copyPageText(empty.key, { text: empty.engine, supply: empty.supply, write })
    ).resolves.toEqual({ copied: false, reason: 'empty' })
    expect(write).not.toHaveBeenCalled()
  })
})

describe('redactionOutcome (the scan-redaction note, PR8)', () => {
  it('unknown before a report; whole when the pass removes the scan; pixels when it does not', async () => {
    const fullPage: FrameBox = { x: 0, y: 0, w: 612, h: 792 }
    const whole = await rig({
      predict: async () => new Map([[makePageKey('scan', 0), [fullPage]]])
    })
    await recognise(whole, ['hello', 'world'])
    expect(whole.supply.redactionOutcome(whole.key)).toBe('unknown')
    const changed = vi.fn()
    whole.supply.onChange(changed)
    whole.supply.sync(whole.docs, whole.layer([overHello(whole.key)]))
    await settle()
    expect(changed).toHaveBeenCalled()
    expect(whole.supply.redactionOutcome(whole.key)).toBe('whole')

    // Pixel redaction applied: only the glyph boxes under the box went, the scan stayed.
    const small: FrameBox = { x: 70, y: 690, w: 40, h: 20 }
    const pixels = await rig({ predict: async () => new Map([[makePageKey('scan', 0), [small]]]) })
    await recognise(pixels, ['hello', 'world'])
    pixels.supply.sync(pixels.docs, pixels.layer([overHello(pixels.key)]))
    await settle()
    expect(pixels.supply.redactionOutcome(pixels.key)).toBe('pixels')
    // A moved redaction makes the report stale until the new one is in.
    pixels.supply.sync(
      pixels.docs,
      pixels.layer([{ ...overHello(pixels.key), geom: { ...overHello(pixels.key).geom, x: 200 } }])
    )
    expect(pixels.supply.redactionOutcome(pixels.key)).toBe('unknown')
  })

  it('a failed pass reports nothing (unknown), never "pixels"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await rig({
      predict: async () => {
        throw new Error('pdfium')
      }
    })
    await recognise(r, ['hello'])
    r.supply.sync(r.docs, r.layer([overHello(r.key)]))
    await settle()
    expect(r.supply.redactionOutcome(r.key)).toBe('unknown')
    warn.mockRestore()
  })
})
