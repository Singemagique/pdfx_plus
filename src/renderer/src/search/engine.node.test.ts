import { describe, expect, it, vi } from 'vitest'
import { createFindEngine } from './engine'
import { buildPageText, type PageText } from './extract'
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
