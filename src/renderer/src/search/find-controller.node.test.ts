import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFindController, type FindController, type FindMatch } from './find-controller'
import { createFindEngine } from './engine'
import { buildPageText, type PageText } from './extract'
import type { DocEntry, PageEntry, PdfSource } from '../types'
import type { Overlay } from '../edit/model'

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

type FakePdf = { texts: string[] }

function docOf(id: string, texts: string[]): DocEntry {
  const pdf: FakePdf = { texts }
  const src = { id: `src-${id}`, bytes: new Uint8Array(), pdf } as unknown as PdfSource
  return {
    id,
    name: `${id}.pdf`,
    pages: texts.map(
      (_, i): PageEntry => ({
        id: `${id}-p${i}`,
        source: src,
        pageIndex: i,
        width: 612,
        height: 792
      })
    )
  }
}

/** Extraction that resolves on the next microtask, or parks pages until released. */
function makeExtract() {
  const held: Array<() => void> = []
  let hold = false
  const extract = vi.fn(
    (pdf: unknown, pageIndex: number) =>
      new Promise<PageText>((resolve) => {
        const done = (): void => resolve(pageText((pdf as FakePdf).texts[pageIndex] ?? ''))
        if (hold) held.push(done)
        else done()
      })
  )
  return {
    extract,
    hold: (on: boolean) => (hold = on),
    release: () => held.splice(0).forEach((f) => f())
  }
}

let ctl: FindController
let navigations: FindMatch[]
let anchor: string | null
let x: ReturnType<typeof makeExtract>

function setup(docs: DocEntry[], opts: { maxMatches?: number } = {}): void {
  navigations = []
  anchor = null
  x = makeExtract()
  ctl = createFindController({
    createEngine: (onChange) => createFindEngine({ onChange, extract: x.extract as never }),
    onNavigate: (m) => navigations.push(m),
    getAnchorPageId: () => anchor,
    ...opts
  })
  ctl.setDocs(docs)
}

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(500)
}

const search = async (q: string): Promise<void> => {
  ctl.setQuery(q)
  await settle()
}

const current = (): string | undefined => ctl.getCurrentMatch()?.pageId

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

const DOCS = (): DocEntry[] => [
  docOf('a', ['apple pie', 'no fruit here', 'apple and apple']),
  docOf('b', ['banana', 'apple tart'])
]

describe('find controller', () => {
  it('is inert until opened, then indexes', async () => {
    setup(DOCS())
    await settle()
    expect(x.extract).not.toHaveBeenCalled()
    ctl.open()
    await settle()
    expect(x.extract).toHaveBeenCalledTimes(5)
    expect(ctl.getBarState()).toMatchObject({
      open: true,
      indexing: false,
      indexed: 5,
      indexTotal: 5
    })
  })

  it('debounces the query by 150 ms', async () => {
    setup(DOCS())
    ctl.open()
    await settle()
    ctl.setQuery('apple')
    await vi.advanceTimersByTimeAsync(100)
    expect(ctl.getBarState().total).toBe(0)
    await vi.advanceTimersByTimeAsync(60)
    expect(ctl.getBarState().total).toBe(4)
  })

  it('orders matches across documents and pages, and counts pages', async () => {
    setup(DOCS())
    ctl.open()
    await settle()
    await search('Apple')
    const bar = ctl.getBarState()
    expect(bar).toMatchObject({ query: 'apple', total: 4, pagesMatched: 3, currentIndex: 0 })
    expect(current()).toBe('a-p0')
    const order: string[] = []
    for (let i = 0; i < 4; i++) {
      order.push(`${current()}:${ctl.getCurrentMatch()?.start}`)
      ctl.next()
    }
    expect(order).toEqual(['a-p0:0', 'a-p2:0', 'a-p2:10', 'b-p1:0'])
  })

  it('wraps around on next and prev', async () => {
    setup(DOCS())
    ctl.open()
    await settle()
    await search('apple')
    ctl.prev()
    expect(ctl.getBarState().currentIndex).toBe(3)
    ctl.next()
    expect(ctl.getBarState().currentIndex).toBe(0)
  })

  it('goes to the first match when Enter flushes a pending query, without advancing', async () => {
    setup(DOCS())
    ctl.open()
    await settle()
    ctl.setQuery('apple')
    ctl.next() // Enter inside the debounce window
    expect(ctl.getBarState().currentIndex).toBe(0)
    expect(navigations.map((m) => m.pageId)).toEqual(['a-p0'])
    ctl.next()
    expect(ctl.getBarState().currentIndex).toBe(1)
  })

  it('starts a new query from the anchor page', async () => {
    setup(DOCS())
    ctl.open()
    await settle()
    anchor = 'a-p1'
    await search('apple')
    expect(current()).toBe('a-p2')
    anchor = 'b-p0'
    await search('apple t')
    expect(current()).toBe('b-p1')
    anchor = 'b-p1'
    await search('pie') // nothing at/after the anchor: wraps to the first match
    expect(current()).toBe('a-p0')
  })

  it('navigates on a new query and on every next/prev, not on incremental updates', async () => {
    setup(DOCS())
    x.hold(true)
    ctl.open()
    await search('apple')
    expect(navigations).toHaveLength(0) // nothing indexed yet
    expect(ctl.getBarState()).toMatchObject({ total: 0, indexing: true })
    x.release() // pages 0 and 1 of a
    await settle()
    expect(navigations.map((m) => m.pageId)).toEqual(['a-p0'])
    x.release()
    await settle()
    x.release()
    await settle()
    expect(ctl.getBarState()).toMatchObject({ total: 4, indexing: false })
    // The current match stays put while the rest of the collection arrives.
    expect(current()).toBe('a-p0')
    expect(navigations).toHaveLength(1)
    ctl.next()
    ctl.next()
    expect(navigations.map((m) => m.pageId)).toEqual(['a-p0', 'a-p2', 'a-p2'])
  })

  it('keeps the current match across a reorder and follows it to its new place', async () => {
    const docs = DOCS()
    setup(docs)
    ctl.open()
    await settle()
    await search('apple')
    ctl.next() // a-p2:0
    navigations.length = 0
    ctl.setDocs([docs[1], docs[0]])
    await settle()
    expect(ctl.getCurrentMatch()).toMatchObject({ pageId: 'a-p2', start: 0 })
    expect(ctl.getBarState().currentIndex).toBe(2)
    expect(navigations).toHaveLength(0)
  })

  it('moves to the next page when the current match disappears', async () => {
    const docs = DOCS()
    setup(docs)
    ctl.open()
    await settle()
    await search('apple')
    ctl.next() // a-p2
    navigations.length = 0
    const [a, b] = docs
    ctl.setDocs([{ ...a, pages: a.pages.slice(0, 2) }, b])
    await settle()
    expect(current()).toBe('b-p1')
    expect(navigations.map((m) => m.pageId)).toEqual(['b-p1'])
  })

  it('reports page status: current / hit / null', async () => {
    setup(DOCS())
    ctl.open()
    await settle()
    await search('apple')
    expect(ctl.getPageStatus('a-p0')).toBe('current')
    expect(ctl.getPageStatus('a-p2')).toBe('hit')
    expect(ctl.getPageStatus('a-p1')).toBeNull()
    ctl.next()
    expect(ctl.getPageStatus('a-p0')).toBe('hit')
    expect(ctl.getPageStatus('a-p2')).toBe('current')
  })

  it('clears statuses on close but keeps the query for the next open', async () => {
    setup(DOCS())
    ctl.open()
    await settle()
    await search('apple')
    ctl.close()
    expect(ctl.getBarState()).toMatchObject({ open: false, total: 0 })
    expect(ctl.getPageStatus('a-p0')).toBeNull()
    expect(ctl.getPageHighlights('a-p0')).toHaveLength(0)
    expect(ctl.getRawQuery()).toBe('apple')
    ctl.open()
    expect(ctl.getBarState()).toMatchObject({ open: true, query: 'apple', total: 4 })
    expect(ctl.getPageStatus('a-p0')).toBe('current')
  })

  it('bumps the focus nonce when opened again while open', async () => {
    setup(DOCS())
    ctl.open()
    const n = ctl.getBarState().focusNonce
    ctl.open()
    expect(ctl.getBarState().focusNonce).toBe(n + 1)
  })

  it('caps the match list', async () => {
    setup([docOf('a', ['a a a a a', 'a a'])], { maxMatches: 3 })
    ctl.open()
    await settle()
    await search('a')
    expect(ctl.getBarState()).toMatchObject({ total: 3, capped: true, pagesMatched: 2 })
  })

  it('keeps snapshot identities stable while nothing changes', async () => {
    setup(DOCS())
    ctl.open()
    await settle()
    await search('apple')
    const bar = ctl.getBarState()
    const hl = ctl.getPageHighlights('a-p2')
    expect(hl).toHaveLength(2)
    expect(hl.filter((h) => h.current)).toHaveLength(0)
    expect(ctl.getBarState()).toBe(bar)
    expect(ctl.getPageHighlights('a-p2')).toBe(hl)
    ctl.next()
    const after = ctl.getPageHighlights('a-p2')
    expect(after).not.toBe(hl)
    expect(after.map((h) => h.current)).toEqual([true, false])
    expect(ctl.getBarState()).not.toBe(bar)
    expect(ctl.getPageHighlights('a-p1')).toBe(ctl.getPageHighlights('b-p0'))
  })

  it('finds overlay text and highlights its box', async () => {
    const docs = DOCS()
    setup(docs)
    ctl.open()
    await settle()
    const overlay: Overlay = {
      id: 'ov1',
      pageKey: 'src-b#0',
      z: 0,
      createdAt: 0,
      geom: { x: 100, y: 600, w: 120, h: 30, rotation: 0, opacity: 1 },
      type: 'text',
      text: 'Kiwi note',
      fontSize: 12,
      color: { r: 0, g: 0, b: 0 },
      font: 'Helvetica',
      align: 'left'
    }
    ctl.setOverlays([overlay])
    await search('kiwi')
    expect(ctl.getCurrentMatch()).toMatchObject({
      pageId: 'b-p0',
      kind: 'overlay',
      overlayId: 'ov1'
    })
    expect(ctl.getPageHighlights('b-p0')).toEqual([
      { rect: { x: 100, y: 792 - 630, w: 120, h: 30 }, current: true }
    ])
  })
})
