import { describe, expect, it, vi } from 'vitest'
import { createFindEngine } from './engine'
import { buildPageText, type PageText, type PageTextItem } from './extract'
import type { PageRect } from './geometry'
import { compileQuery, findAll, normalizeQuery } from './normalize'
import type { DocEntry, PageEntry, PdfSource } from '../types'
import type { Overlay } from '../edit/model'

// ---- fixtures -------------------------------------------------------------------------------

/** A fake pdf.js proxy: page texts by index. */
type FakePdf = { texts: string[] }
const fakePdf = (...texts: string[]): FakePdf => ({ texts })

const pageText = (s: string): PageText =>
  buildPageText(
    [
      {
        str: s,
        t: [10, 0, 0, 10, 50, 700],
        width: s.length * 5,
        height: 10,
        ascent: 0.8,
        descent: -0.2,
        vertical: false,
        rtl: false,
        mono: true,
        hasEOL: false
      }
    ],
    [1, 0, 0, -1, 0, 792]
  )

const source = (id: string, pdf: FakePdf): PdfSource =>
  ({ id, bytes: new Uint8Array(), pdf }) as unknown as PdfSource

function docOf(id: string, src: PdfSource, indices: number[]): DocEntry {
  return {
    id,
    name: `${id}.pdf`,
    pages: indices.map(
      (pageIndex, i): PageEntry => ({
        id: `${id}-p${i}`,
        source: src,
        pageIndex,
        width: 612,
        height: 792
      })
    )
  }
}

/** A controllable extractor: each call parks until the test resolves (or rejects) it. */
function deferredExtract() {
  const calls: Array<{
    pdf: FakePdf
    pageIndex: number
    resolve: () => void
    reject: (e: unknown) => void
  }> = []
  let live = 0
  let maxLive = 0
  const extract = vi.fn((pdf: unknown, pageIndex: number): Promise<PageText> => {
    live++
    maxLive = Math.max(maxLive, live)
    return new Promise<PageText>((resolve, reject) => {
      const p = pdf as FakePdf
      calls.push({
        pdf: p,
        pageIndex,
        resolve: () => {
          live--
          resolve(pageText(p.texts[pageIndex] ?? ''))
        },
        reject: (e) => {
          live--
          reject(e)
        }
      })
    })
  })
  return { extract, calls, maxLive: () => maxLive }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function resolveAll(calls: ReturnType<typeof deferredExtract>['calls']): Promise<void> {
  for (let guard = 0; guard < 100; guard++) {
    const pending = calls.splice(0)
    if (pending.length === 0) return
    for (const c of pending) c.resolve()
    await flush()
  }
}

const query = (q: string): [string, RegExp] => {
  const n = normalizeQuery(q)
  return [n, compileQuery(n)!]
}

const hitKeys = (m: ReadonlyMap<string, unknown>): string[] =>
  [...m.entries()].filter(([, v]) => v).map(([k]) => k)

// ---- tests ----------------------------------------------------------------------------------

describe('find engine', () => {
  it('extracts nothing before activate()', async () => {
    const x = deferredExtract()
    const engine = createFindEngine({ onChange: () => {}, extract: x.extract as never })
    const pdf = fakePdf('alpha', 'beta')
    engine.reconcile([docOf('a', source('s1', pdf), [0, 1])])
    await flush()
    expect(x.extract).not.toHaveBeenCalled()
    expect(engine.progress()).toEqual({ indexed: 0, total: 2 })
    engine.activate()
    expect(x.extract).toHaveBeenCalledTimes(2)
  })

  it('never runs more than two extractions at once', async () => {
    const x = deferredExtract()
    const engine = createFindEngine({ onChange: () => {}, extract: x.extract as never })
    const pdf = fakePdf(...Array.from({ length: 10 }, (_, i) => `page ${i}`))
    engine.reconcile([docOf('a', source('s1', pdf), [...Array(10).keys()])])
    engine.activate()
    expect(x.extract).toHaveBeenCalledTimes(2)
    await resolveAll(x.calls)
    expect(x.extract).toHaveBeenCalledTimes(10)
    expect(x.maxLive()).toBe(2)
    expect(engine.progress()).toEqual({ indexed: 10, total: 10 })
  })

  it('keeps the cache across a reorder or move (no re-extraction)', async () => {
    const x = deferredExtract()
    const engine = createFindEngine({ onChange: () => {}, extract: x.extract as never })
    const src = source('s1', fakePdf('one', 'two', 'three'))
    engine.reconcile([docOf('a', src, [0, 1, 2])])
    engine.activate()
    await resolveAll(x.calls)
    expect(x.extract).toHaveBeenCalledTimes(3)
    engine.reconcile([docOf('a', src, [2, 0]), docOf('b', src, [1])])
    await flush()
    expect(x.extract).toHaveBeenCalledTimes(3)
    expect(engine.progress()).toEqual({ indexed: 3, total: 3 })
  })

  it('reuses the extraction for a duplicate (fresh source id, same proxy)', async () => {
    const x = deferredExtract()
    const engine = createFindEngine({ onChange: () => {}, extract: x.extract as never })
    const pdf = fakePdf('original words')
    engine.reconcile([docOf('a', source('s1', pdf), [0])])
    engine.activate()
    // A duplicate made while the first extraction is still in flight waits on it…
    engine.reconcile([docOf('a', source('s1', pdf), [0]), docOf('b', source('s2', pdf), [0])])
    await resolveAll(x.calls)
    // …and one made afterwards copies the stored result.
    engine.reconcile([
      docOf('a', source('s1', pdf), [0]),
      docOf('b', source('s2', pdf), [0]),
      docOf('c', source('s3', pdf), [0])
    ])
    await flush()
    expect(x.extract).toHaveBeenCalledTimes(1)
    expect(engine.progress()).toEqual({ indexed: 3, total: 3 })
    expect(hitKeys(engine.search(...query('original')))).toEqual(['s1#0', 's2#0', 's3#0'])
  })

  it('drops a removed source from the cache, the results and the progress', async () => {
    const x = deferredExtract()
    const onChange = vi.fn()
    const engine = createFindEngine({ onChange, extract: x.extract as never })
    const a = source('s1', fakePdf('needle'))
    const b = source('s2', fakePdf('needle too'))
    engine.reconcile([docOf('a', a, [0]), docOf('b', b, [0])])
    engine.activate()
    await resolveAll(x.calls)
    expect(hitKeys(engine.search(...query('needle')))).toEqual(['s1#0', 's2#0'])
    onChange.mockClear()
    engine.reconcile([docOf('a', a, [0])])
    expect(onChange).toHaveBeenCalled()
    expect(engine.getPageText('s2#0')).toBeUndefined()
    expect(hitKeys(engine.search(...query('needle')))).toEqual(['s1#0'])
    expect(engine.progress()).toEqual({ indexed: 1, total: 1 })
  })

  it('does not store a stale in-flight result for a removed source', async () => {
    const x = deferredExtract()
    const engine = createFindEngine({ onChange: () => {}, extract: x.extract as never })
    const a = source('s1', fakePdf('kept'))
    const b = source('s2', fakePdf('gone'))
    engine.reconcile([docOf('a', a, [0]), docOf('b', b, [0])])
    engine.activate()
    engine.reconcile([docOf('a', a, [0])]) // b removed while its extraction runs
    await resolveAll(x.calls)
    expect(engine.getPageText('s2#0')).toBeUndefined()
    expect(hitKeys(engine.search(...query('gone')))).toEqual([])
    expect(engine.progress()).toEqual({ indexed: 1, total: 1 })
  })

  it('stores a late result for a key that was removed and added back', async () => {
    const x = deferredExtract()
    const engine = createFindEngine({ onChange: () => {}, extract: x.extract as never })
    const a = source('s1', fakePdf('back again'))
    engine.reconcile([docOf('a', a, [0])])
    engine.activate()
    engine.reconcile([])
    engine.reconcile([docOf('a', a, [0])])
    await resolveAll(x.calls)
    expect(x.extract).toHaveBeenCalledTimes(1)
    expect(engine.getPageText('s1#0')?.norm).toBe('back again')
  })

  it('counts a failed extraction as indexed and empty', async () => {
    const x = deferredExtract()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const engine = createFindEngine({ onChange: () => {}, extract: x.extract as never })
    engine.reconcile([docOf('a', source('s1', fakePdf('x', 'y')), [0, 1])])
    engine.activate()
    x.calls.shift()!.reject(new Error('broken page'))
    await resolveAll(x.calls)
    expect(engine.progress()).toEqual({ indexed: 2, total: 2 })
    expect(engine.getPageText('s1#0')?.norm).toBe('')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  describe('overlays', () => {
    const geom = { x: 10, y: 10, w: 100, h: 20, rotation: 0, opacity: 1 }
    const base = { pageKey: 's1#0', z: 0, createdAt: 0, geom }
    const text = (id: string, t: string): Overlay => ({
      ...base,
      id,
      type: 'text',
      text: t,
      fontSize: 12,
      color: { r: 0, g: 0, b: 0 },
      font: 'Helvetica',
      align: 'left'
    })
    const form = (id: string, value: string | boolean, control?: 'radio'): Overlay => ({
      ...base,
      id,
      type: 'formValue',
      field: id,
      value,
      ...(control ? { control } : {})
    })

    it('searches text overlays and string form values before any indexing', () => {
      const engine = createFindEngine({ onChange: () => {}, extract: vi.fn() as never })
      engine.reconcile([docOf('a', source('s1', fakePdf('')), [0])])
      engine.setOverlays([
        text('t1', 'Signed by Zoë'),
        form('f1', 'zoe@example.com'),
        form('f2', true),
        form('r1', 'Zoe', 'radio')
      ])
      const hits = engine.search(...query('zoe')).get('s1#0')
      expect(hits?.text.length).toBe(0)
      expect(hits?.overlays.map((o) => o.overlayId)).toEqual(['t1', 'f1'])
      expect(engine.getOverlay('t1')?.geom).toEqual(geom)
    })

    it('invalidates only the page whose overlays changed', async () => {
      const calls: string[] = []
      const counting: typeof findAll = (t, re, limit) => {
        calls.push(t)
        return findAll(t, re, limit)
      }
      const x = deferredExtract()
      const onChange = vi.fn()
      const engine = createFindEngine({ onChange, extract: x.extract as never, match: counting })
      engine.reconcile([docOf('a', source('s1', fakePdf('p0 word', 'p1 word')), [0, 1])])
      engine.activate()
      await resolveAll(x.calls)
      const first = [text('t1', 'word one')]
      engine.setOverlays(first)
      engine.search(...query('word'))
      calls.length = 0
      onChange.mockClear()

      engine.setOverlays(first) // same array: a no-op
      expect(onChange).not.toHaveBeenCalled()
      engine.setOverlays([...first]) // same overlay objects: nothing changed
      expect(onChange).not.toHaveBeenCalled()
      engine.search(...query('word'))
      expect(calls).toEqual([])

      engine.setOverlays([text('t1', 'word two')])
      expect(onChange).toHaveBeenCalledTimes(1)
      engine.search(...query('word'))
      // Page 0 (the overlay's page) re-ran: its text and its overlay. Page 1 did not.
      expect(calls).toEqual(['p0 word', 'word two'])
    })
  })

  it('flags a page that has more matches than the per-page limit', async () => {
    const x = deferredExtract()
    const engine = createFindEngine({
      onChange: () => {},
      extract: x.extract as never,
      perPageLimit: 4
    })
    engine.reconcile([docOf('a', source('s1', fakePdf('a a a a a a', 'a a a a')), [0, 1])])
    engine.activate()
    await resolveAll(x.calls)
    const hits = engine.search(...query('a'))
    expect(hits.get('s1#0')).toMatchObject({ capped: true })
    expect(hits.get('s1#0')!.text.length).toBe(8)
    expect(hits.get('s1#1')).toMatchObject({ capped: false })
    expect(hits.get('s1#1')!.text.length).toBe(8)
  })

  it('indexes from a prioritized page onwards, then wraps to the start', async () => {
    const x = deferredExtract()
    const engine = createFindEngine({ onChange: () => {}, extract: x.extract as never })
    const pdf = fakePdf(...Array.from({ length: 8 }, (_, i) => `p${i}`))
    engine.reconcile([docOf('a', source('s1', pdf), [...Array(8).keys()])])
    engine.activate('s1#5')
    const order = (): number[] => x.extract.mock.calls.map(([, i]) => i as number)
    expect(order()).toEqual([5, 6])
    await resolveAll(x.calls)
    expect(order()).toEqual([5, 6, 7, 0, 1, 2, 3, 4])
  })

  it('re-prioritizes the pending queue in collection order', async () => {
    const x = deferredExtract()
    const engine = createFindEngine({ onChange: () => {}, extract: x.extract as never })
    const pdf = fakePdf(...Array.from({ length: 8 }, (_, i) => `p${i}`))
    engine.reconcile([docOf('a', source('s1', pdf), [...Array(8).keys()])])
    engine.activate('s1#6') // runs 6, 7; queue 0…5
    engine.prioritize('s1#3') // an anchor whose own page is still queued
    await resolveAll(x.calls)
    expect(x.extract.mock.calls.map(([, i]) => i)).toEqual([6, 7, 3, 4, 5, 0, 1, 2])
  })

  it('releases the shared extraction of a proxy no live page uses', async () => {
    const x = deferredExtract()
    const engine = createFindEngine({ onChange: () => {}, extract: x.extract as never })
    const pdf = fakePdf('once')
    engine.reconcile([docOf('a', source('s1', pdf), [0])])
    engine.activate()
    await resolveAll(x.calls)
    engine.reconcile([]) // removed: its text must not stay reachable through the proxy
    // The same proxy back under a new source id (undo re-adding it) is extracted again.
    engine.reconcile([docOf('a', source('s2', pdf), [0])])
    await resolveAll(x.calls)
    expect(x.extract).toHaveBeenCalledTimes(2)
    expect(engine.getPageText('s2#0')?.norm).toBe('once')
  })

  describe('supplements and redactions (per page key)', () => {
    /** One OCR-style word item at (x, 700), 10 pt, 5 pt per character. */
    const word = (str: string, x: number, extra: Partial<PageTextItem> = {}): PageTextItem => ({
      str,
      t: [10, 0, 0, 10, x, 700],
      width: str.length * 5,
      height: 10,
      ascent: 0.8,
      descent: -0.2,
      vertical: false,
      rtl: false,
      hasEOL: false,
      ocr: true,
      ...extra
    })
    const ocrLine = (...words: string[]): PageTextItem[] => {
      const out: PageTextItem[] = []
      let x = 300
      words.forEach((w, i) => {
        out.push(word(w, x, { hasEOL: i === words.length - 1 }))
        x += w.length * 5
        if (i < words.length - 1) {
          out.push(word(' ', x, { width: 3 }))
          x += 3
        }
      })
      return out
    }
    /** The page-px box of the first native item's characters [lo, hi) (5 pt each, at x = 50). */
    const nativeBox = (lo: number, hi: number): PageRect => ({
      x: 50 + 5 * lo,
      y: 792 - 708,
      w: 5 * (hi - lo),
      h: 10
    })
    const has = (engine: ReturnType<typeof createFindEngine>, q: string): string[] =>
      hitKeys(engine.search(...query(q)))

    async function indexed(texts: string[], dup = false) {
      const x = deferredExtract()
      const onChange = vi.fn()
      const engine = createFindEngine({ onChange, extract: x.extract as never })
      const pdf = fakePdf(...texts)
      const docs = [
        docOf(
          'a',
          source('s1', pdf),
          texts.map((_, i) => i)
        )
      ]
      if (dup) docs.push(docOf('b', source('s2', pdf), [0]))
      engine.reconcile(docs)
      engine.activate()
      await resolveAll(x.calls)
      onChange.mockClear()
      return { engine, onChange, x, docs, pdf }
    }

    it('appends recognised text to the native text, and clearing it restores the page', async () => {
      const { engine, onChange } = await indexed(['native words'])
      engine.setSupplement('s1#0', { mode: 'append', items: ocrLine('scanned', 'words') })
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(engine.getPageText('s1#0')?.norm).toBe('native words scanned words')
      expect(has(engine, 'scanned words')).toEqual(['s1#0'])
      // Native text whose last item has no EOL still does not run into the OCR text.
      expect(has(engine, 'wordsscanned')).toEqual([])
      engine.setSupplement('s1#0', null)
      expect(onChange).toHaveBeenCalledTimes(2)
      expect(engine.getPageText('s1#0')?.norm).toBe('native words')
      expect(has(engine, 'scanned')).toEqual([])
      engine.setSupplement('s1#0', null) // nothing to clear: no change
      expect(onChange).toHaveBeenCalledTimes(2)
    })

    it('replaces the native text (an ocr-ours page after Replace / Remove)', async () => {
      const { engine } = await indexed(['old layer text'])
      engine.setSupplement('s1#0', { mode: 'replace', items: ocrLine('new', 'layer') })
      expect(engine.getPageText('s1#0')?.norm).toBe('new layer')
      expect(has(engine, 'old')).toEqual([])
      engine.setSupplement('s1#0', { mode: 'replace', items: [] }) // Remove: nothing left
      expect(engine.getPageText('s1#0')?.norm).toBe('')
      expect(has(engine, 'layer')).toEqual([])
    })

    it('a supplement waits for the native text (its vt) and never re-extracts', async () => {
      const x = deferredExtract()
      const engine = createFindEngine({ onChange: () => {}, extract: x.extract as never })
      engine.reconcile([docOf('a', source('s1', fakePdf('native')), [0])])
      engine.setSupplement('s1#0', { mode: 'append', items: ocrLine('early') })
      expect(engine.getPageText('s1#0')).toBeUndefined()
      expect(has(engine, 'early')).toEqual([])
      engine.activate()
      await resolveAll(x.calls)
      expect(has(engine, 'early')).toEqual(['s1#0'])
      expect(x.extract).toHaveBeenCalledTimes(1)
      expect(engine.progress()).toEqual({ indexed: 1, total: 1 })
    })

    it('duplicates share the extraction, not the supplement or the redactions', async () => {
      // Three spaces between words: a neighbour clear of the slice pad and of the spread of the
      // slice estimates (see the next tests).
      const { engine, x } = await indexed(['shared   native   text'], true)
      expect(x.extract).toHaveBeenCalledTimes(1)
      engine.setSupplement('s2#0', { mode: 'append', items: ocrLine('only', 'here') })
      expect(has(engine, 'only here')).toEqual(['s2#0'])
      expect(has(engine, 'shared')).toEqual(['s1#0', 's2#0'])
      // A redaction of "native" on the original filters only the original.
      engine.setRedactions('s1#0', [nativeBox(9, 15)])
      expect(has(engine, 'native')).toEqual(['s2#0'])
      expect(has(engine, 'shared')).toEqual(['s1#0', 's2#0'])
      expect(engine.getPageText('s2#0')?.norm).toBe('shared native text only here')
      expect(x.extract).toHaveBeenCalledTimes(1)
    })

    it('ignores a late supplement for a removed page, and reconcile drops supplements', async () => {
      const { engine, docs, onChange, x } = await indexed(['kept'])
      const gone = 's9#0'
      engine.setSupplement(gone, { mode: 'append', items: ocrLine('stale') }) // never live
      expect(onChange).not.toHaveBeenCalled()
      engine.setSupplement('s1#0', { mode: 'append', items: ocrLine('recognised') })
      engine.reconcile([]) // the page goes...
      engine.reconcile(docs) // ...and comes back (undo / re-add): its old supplement does not
      await resolveAll(x.calls)
      expect(has(engine, 'recognised')).toEqual([])
      expect(engine.getPageText('s1#0')?.norm).toBe('kept')
      // The supplier re-supplies a returning key; that works.
      engine.setSupplement('s1#0', { mode: 'append', items: ocrLine('recognised') })
      expect(has(engine, 'recognised')).toEqual(['s1#0'])
    })

    it('a stale extraction for a removed key resurrects neither its text nor its supplement', async () => {
      const x = deferredExtract()
      const engine = createFindEngine({ onChange: () => {}, extract: x.extract as never })
      const a = source('s1', fakePdf('kept'))
      const b = source('s2', fakePdf('gone native'))
      engine.reconcile([docOf('a', a, [0]), docOf('b', b, [0])])
      engine.activate()
      engine.setSupplement('s2#0', { mode: 'append', items: ocrLine('gone', 'ocr') })
      engine.reconcile([docOf('a', a, [0])]) // b removed while its extraction is in flight
      await resolveAll(x.calls)
      expect(engine.getPageText('s2#0')).toBeUndefined()
      engine.reconcile([docOf('a', a, [0]), docOf('b', b, [0])]) // b back: indexed again
      await resolveAll(x.calls)
      expect(engine.getPageText('s2#0')?.norm).toBe('gone native')
      expect(has(engine, 'ocr')).toEqual([])
    })

    it('filters redacted native characters at build time; undo brings them back', async () => {
      const { engine, onChange } = await indexed(['alpha bravo secret delta echo'])
      const raw = engine.getPageText('s1#0')!
      // "secret" is chars 12..18.
      engine.setRedactions('s1#0', [nativeBox(12, 18)])
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(has(engine, 'secret')).toEqual([])
      expect(has(engine, 'alpha')).toEqual(['s1#0'])
      expect(has(engine, 'echo')).toEqual(['s1#0'])
      // The redaction is a word boundary: the words either side never join.
      expect(has(engine, 'bravodelta')).toEqual([])
      expect(has(engine, 'brav delta')).toEqual([])
      // The pad (the spread of the slice estimates, half an average character width and
      // max(1 pt, 0.15 × size)) reaches across a single space, so the neighbours' facing
      // characters go too (fail-safe, DESIGN.md §3.6.1).
      expect(has(engine, 'bravo')).toEqual([])
      expect(has(engine, 'brav')).toEqual(['s1#0'])
      expect(has(engine, 'elta')).toEqual(['s1#0'])
      expect(engine.getPageText('s1#0')?.norm).toBe('alpha brav elta echo')
      // The same boxes again: no change, no rebuild.
      engine.setRedactions('s1#0', [nativeBox(12, 18)])
      expect(onChange).toHaveBeenCalledTimes(1)
      // The stored extraction was never mutated.
      expect(raw.norm).toBe('alpha bravo secret delta echo')
      engine.setRedactions('s1#0', null)
      expect(has(engine, 'secret')).toEqual(['s1#0'])
      expect(engine.getPageText('s1#0')).toBe(raw)
      engine.setRedactions('s1#0', [])
      expect(onChange).toHaveBeenCalledTimes(2)
    })

    it('moving a box (same number of boxes) filters the new place and restores the old', async () => {
      const { engine, onChange } = await indexed(['alpha   middle   secret'])
      // "alpha" is chars 0..5, "secret" 17..23.
      engine.setRedactions('s1#0', [nativeBox(0, 5)])
      expect(has(engine, 'alpha')).toEqual([])
      expect(has(engine, 'secret')).toEqual(['s1#0'])
      onChange.mockClear()
      // The user drags the box from "alpha" onto "secret".
      engine.setRedactions('s1#0', [nativeBox(17, 23)])
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(has(engine, 'secret')).toEqual([])
      expect(has(engine, 'alpha')).toEqual(['s1#0'])
      expect(has(engine, 'middle')).toEqual(['s1#0'])
      // Resized in place (same origin, wider): applied too.
      engine.setRedactions('s1#0', [{ ...nativeBox(17, 23), w: 5 * 15 }])
      expect(onChange).toHaveBeenCalledTimes(2)
      expect(has(engine, 'middle')).toEqual(['s1#0'])
      engine.setRedactions('s1#0', [{ ...nativeBox(8, 14), w: 5 * 15 }])
      expect(has(engine, 'middle')).toEqual([])
      expect(has(engine, 'secret')).toEqual([])
    })

    it('filters supplement words too, and keeps filtering a re-supplied supplement', async () => {
      const { engine } = await indexed([''])
      engine.setRedactions('s1#0', [{ x: 340, y: 792 - 706, w: 10, h: 4 }]) // inside "hidden"
      engine.setSupplement('s1#0', {
        mode: 'append',
        items: ocrLine('visible', 'hidden', 'word')
      })
      expect(has(engine, 'hidden')).toEqual([])
      expect(has(engine, 'visible')).toEqual(['s1#0'])
      expect(engine.getPageText('s1#0')?.norm).toBe('visible word')
      // A new result for the page (Replace): the box still applies.
      engine.setSupplement('s1#0', { mode: 'append', items: ocrLine('visible', 'hidden', 'again') })
      expect(has(engine, 'hidden')).toEqual([])
      expect(has(engine, 'again')).toEqual(['s1#0'])
    })

    it('keeps a page key’s redactions across reconcile (fail-safe)', async () => {
      const { engine, docs, x } = await indexed(['top  secret  plan'])
      engine.setRedactions('s1#0', [nativeBox(5, 11)])
      engine.reconcile([])
      engine.reconcile(docs)
      await resolveAll(x.calls)
      expect(has(engine, 'secret')).toEqual([])
      expect(has(engine, 'plan')).toEqual(['s1#0'])
    })
  })

  it('only searches newly indexed pages for the same query', async () => {
    const calls: string[] = []
    const counting: typeof findAll = (t, re, limit) => {
      calls.push(t)
      return findAll(t, re, limit)
    }
    const x = deferredExtract()
    const engine = createFindEngine({
      onChange: () => {},
      extract: x.extract as never,
      match: counting
    })
    engine.reconcile([docOf('a', source('s1', fakePdf('aa', 'ab', 'ac', 'ad')), [0, 1, 2, 3])])
    engine.activate()
    x.calls.splice(0).forEach((c) => c.resolve())
    await flush()
    engine.search(...query('a'))
    expect(calls).toEqual(['aa', 'ab'])
    calls.length = 0
    x.calls.splice(0).forEach((c) => c.resolve())
    await flush()
    engine.search(...query('a'))
    expect(calls).toEqual(['ac', 'ad'])
    calls.length = 0
    engine.search(...query('a'))
    expect(calls).toEqual([])
    // A new query starts over.
    engine.search(...query('b'))
    expect(calls).toEqual(['aa', 'ab', 'ac', 'ad'])
  })
})

describe('the OCR side of the index (readNative, onNativeText, setSupplement)', () => {
  it('readNative extracts one page before activate(), once, and Find reuses it', async () => {
    const x = deferredExtract()
    const seen: string[] = []
    const engine = createFindEngine({ onChange: () => {}, extract: x.extract as never })
    engine.onNativeText((key) => seen.push(key))
    const pdf = fakePdf('alpha', 'beta', 'gamma')
    engine.reconcile([docOf('a', source('s1', pdf), [0, 1, 2])])
    const read = engine.readNative('s1#2')
    expect(x.extract).toHaveBeenCalledTimes(1)
    expect(x.extract.mock.calls[0][1]).toBe(2)
    await resolveAll(x.calls)
    expect((await read)?.norm).toContain('gamma')
    expect(seen).toEqual(['s1#2'])
    // Find's full extraction later does not extract page 2 again.
    engine.activate()
    await resolveAll(x.calls)
    expect(x.extract).toHaveBeenCalledTimes(3)
    expect(seen.sort()).toEqual(['s1#0', 's1#1', 's1#2'])
    // Stored text answers at once.
    expect((await engine.readNative('s1#0'))?.norm).toContain('alpha')
  })

  it('readNative jumps the queue, and answers undefined for a key that is not (or no longer) live', async () => {
    const x = deferredExtract()
    const engine = createFindEngine({ onChange: () => {}, extract: x.extract as never })
    const pdf = fakePdf(...Array.from({ length: 6 }, (_, i) => `p${i}`))
    const src = source('s1', pdf)
    engine.reconcile([docOf('a', src, [0, 1, 2, 3, 4, 5])])
    engine.activate()
    // Two extractions are in flight; page 5 goes next, before 2, 3 and 4.
    const read = engine.readNative('s1#5')
    x.calls.splice(0).forEach((c) => c.resolve())
    await flush()
    expect(x.extract.mock.calls.map((c) => c[1]).slice(0, 3)).toEqual([0, 1, 5])
    x.calls.splice(0).forEach((c) => c.resolve())
    expect((await read)?.norm).toContain('p5')
    await expect(engine.readNative('nope#0')).resolves.toBeUndefined()
    const gone = engine.readNative('s1#4')
    engine.reconcile([docOf('a', src, [0])])
    await expect(gone).resolves.toBeUndefined()
    await resolveAll(x.calls)
  })

  it('setSupplement says whether the engine holds the supplement (false for a key not live)', () => {
    const engine = createFindEngine({ onChange: () => {}, extract: vi.fn() as never })
    engine.reconcile([docOf('a', source('s1', fakePdf('x')), [0])])
    const s = { mode: 'append' as const, items: [] }
    expect(engine.setSupplement('gone#0', s)).toBe(false)
    expect(engine.setSupplement('s1#0', s)).toBe(true)
    expect(engine.setSupplement('s1#0', s)).toBe(true)
    expect(engine.setSupplement('s1#0', null)).toBe(true)
  })
})
