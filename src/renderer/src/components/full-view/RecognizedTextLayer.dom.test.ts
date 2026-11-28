// "Show recognized text" in full view (DESIGN.md §3.6.3, PR10): the toggle, the word boxes with
// their text, the redaction filter (the SAME words Find uses: through the real OCR store and Find
// supply), the dotted underline under the calibrated threshold, ] / [ stepping, the header counts,
// the session-only note and a reopened file's saved layer.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useEffect, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const { savedRuns, findHits } = vi.hoisted(() => {
  // geometry.ts reads window.api.platform at import time.
  ;(window as unknown as { api: { platform: string } }).api = { platform: 'win32' }
  return { savedRuns: { value: [] as unknown[] }, findHits: { value: [] as unknown[] } }
})
vi.mock('../PageView', () => ({ PageView: () => null }))
vi.mock('../edit/OverlayLayer', () => ({ OverlayLayer: () => null }))
vi.mock('../../ocr/saved-layer', () => ({
  readSavedLayer: vi.fn(async () => savedRuns.value)
}))
vi.mock('../../search/FindContext', () => ({ usePageHighlights: () => findHits.value }))

import { FullViewPage } from './FullViewPage'
import { FullViewPages } from './FullViewPages'
import { FullViewChrome } from './FullViewChrome'
import { FullViewHeaderSlot } from './header-slot'
import { EditProvider, useEditStore, type EditStore } from '../../edit/EditProvider'
import { makePageKey, type Overlay } from '../../edit/model'
import {
  connectRecognizedText,
  headerText,
  isRecognizedTextShown,
  sessionWords,
  setRecognizedTextShown,
  subscribeRecognizedTextShown,
  toggleRecognizedText,
  UNDERLINE_THRESHOLD,
  type RecognizedTextView
} from '../../ocr/recognized-text'
import { readSavedLayer } from '../../ocr/saved-layer'
import { createOcrFindSupply, type OcrFindSupply } from '../../ocr/ocr-find-supply'
import { createOcrStore, type OcrStore } from '../../ocr/ocr-store'
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
} from '../../ocr/test-utils/fake-ocr'
import { createFindEngine } from '../../search/engine'
import type { PageText } from '../../search/extract'
import { defaultSettings } from '../../../../shared/settings'
import { ENGINE_ID, PIPELINE_VERSION } from '../../../../shared/ocr/engine/tess-core'
import { pack, type OcrWord, type PackedOcrPage } from '../../../../shared/ocr/types'
import type { DocEntry, PageEntry } from '../../types'
import type { View } from './geometry'

const H = 792
const LOW = UNDERLINE_THRESHOLD - 0.2

/** Words on lines (overlay frame, y up): [text, confCal] per word, 12 pt, 6 pt per char. */
function ocrPage(
  lines: Array<Array<[string, number | null]>>,
  opts: { langs?: string[]; confSource?: 'word' | 'none'; angle?: number } = {}
): PackedOcrPage {
  const langs = opts.langs ?? ['deu', 'eng']
  return pack({
    v: 1,
    engineId: ENGINE_ID,
    dataHashes: Object.fromEntries(langs.map((l) => [l, 'a'.repeat(64)])),
    langs,
    pipelineVersion: PIPELINE_VERSION,
    pageClass: 'scanned',
    renderDpi: 300,
    physDpi: 300,
    orientation: 0,
    skewDeg: 0,
    meanConfCal: 0.8,
    confSource: opts.confSource ?? 'word',
    status: 'ok',
    lines: lines.map((ws, li) => {
      let x = 72
      return {
        angle: opts.angle ?? 0,
        size: 12,
        words: ws.map(([t, confCal]): OcrWord => {
          const w = { t, x, y: 700 - 20 * li, w: t.length * 6, conf: null, confCal }
          x += t.length * 6 + 6
          return w
        })
      }
    })
  })
}

// Three low-confidence words (one per line plus one more), one with no confidence, one at the
// threshold as written (not underlined; the exact boundary is pinned on sessionWords below, since
// Float32 storage moves 0.6 up a hair).
const PAGE = ocrPage([
  [
    ['Hello', 0.95],
    ['wrld', LOW],
    ['again', null]
  ],
  [
    ['second', UNDERLINE_THRESHOLD],
    ['tbe', LOW]
  ],
  [
    ['third', 0.99],
    ['1ine', LOW]
  ]
])

const scan = source('scan')
const page: PageEntry = pageOf(scan, 0, 'pg-1')
const KEY = makePageKey(scan.id, 0)

// ---------------------------------------------------------------------------------------------
// Harness

let store: EditStore = null as unknown as EditStore
let onEdits: ((s: EditStore) => void) | null = null

function Harness(props: {
  interactive?: boolean
  zoomed?: boolean
  isCurrent?: boolean
  panBy?: (dx: number, dy: number) => void
}): ReactNode {
  const s = useEditStore()
  store = s
  const { editLayer } = s
  useEffect(() => onEdits?.(s), [editLayer, s])
  const child = createElement(FullViewPage, {
    page,
    viewport: { w: 1200, h: 900 },
    isCurrent: props.isCurrent ?? true,
    view: { zoom: 1, x: 0, y: 0 },
    zoomed: props.zoomed ?? false,
    interactive: props.interactive ?? true,
    animating: false,
    flip: null,
    flipTransition: false,
    renderVersion: 0,
    resetView: () => {},
    applyZoom: () => {},
    panBy: props.panBy
  })
  return createElement(EditProvider, { store: s, children: child })
}

let container: HTMLDivElement
let root: Root
let disconnect: (() => void) | null = null

/** A supply stand-in: per-key pages, and a change signal. `fresh`: a new page object per call. */
function fakeSupply(
  pages: Map<string, PackedOcrPage | null>,
  opts: { fresh?: boolean; pending?: Set<string> } = {}
): {
  filteredPage: (k: string) => PackedOcrPage | null
  isPending: (k: string) => boolean
  onChange: (l: () => void) => () => void
  fire: () => void
} {
  const ls = new Set<() => void>()
  return {
    filteredPage: (k) => {
      const p = pages.get(k) ?? null
      return p && opts.fresh ? { ...p, wordGeom: p.wordGeom.slice() } : p
    },
    isPending: (k) => opts.pending?.has(k) ?? false,
    onChange: (l) => {
      ls.add(l)
      return () => void ls.delete(l)
    },
    fire: () => ls.forEach((l) => l())
  }
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  savedRuns.value = []
  vi.mocked(readSavedLayer).mockClear()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  disconnect?.()
  disconnect = null
  onEdits = null
  setRecognizedTextShown(false)
})

const render = (props: Parameters<typeof Harness>[0] = {}): Promise<void> =>
  act(async () => root.render(createElement(Harness, props)))

const words = (): SVGGElement[] => Array.from(container.querySelectorAll<SVGGElement>('.ocr-w'))
const texts = (): string[] => words().map((g) => g.querySelector('text')!.textContent ?? '')
const underlined = (): string[] =>
  Array.from(container.querySelectorAll('.ocr-low')).map((l) => {
    const t = (l.parentNode as SVGGElement).getAttribute('transform')
    return words().find((g) => g.getAttribute('transform') === t)!.textContent ?? ''
  })
const header = (): HTMLElement | null => document.body.querySelector('.ocr-text-header')
const headerMain = (): string => header()?.querySelector('.ocr-text-header-main')?.textContent ?? ''
const stepText = (): string => header()?.querySelector('.ocr-text-header-step')?.textContent ?? ''
const focusedWord = (): string | null => {
  const f = container.querySelector('.ocr-focus')
  if (!f) return null
  const t = (f.parentNode as SVGGElement).getAttribute('transform')
  return words().find((g) => g.getAttribute('transform') === t)?.textContent ?? null
}
const press = (
  key: string,
  init: KeyboardEventInit = {},
  target: EventTarget = window
): Promise<void> =>
  act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    )
  })

// ---------------------------------------------------------------------------------------------

describe('the toggle', () => {
  it('is off at launch, flips, notifies subscribers, and is what the overlay follows', async () => {
    expect(isRecognizedTextShown()).toBe(false)
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, PAGE]])))
    await render()
    expect(words()).toHaveLength(0)
    expect(header()).toBeNull()

    const seen: boolean[] = []
    const off = subscribeRecognizedTextShown(() => seen.push(isRecognizedTextShown()))
    await act(async () => void expect(toggleRecognizedText()).toBe(true))
    expect(words()).toHaveLength(7)
    expect(header()).not.toBeNull()
    // Setting the same state again is not a change.
    await act(async () => setRecognizedTextShown(true))
    await act(async () => void expect(toggleRecognizedText()).toBe(false))
    expect(words()).toHaveLength(0)
    expect(header()).toBeNull()
    expect(seen).toEqual([true, false])
    off()
  })

  it('the header Hide button turns it off', async () => {
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, PAGE]])))
    setRecognizedTextShown(true)
    await render()
    const hide = header()!.querySelector('button')!
    expect(hide.textContent).toBe('Hide')
    await act(async () => hide.click())
    expect(isRecognizedTextShown()).toBe(false)
    expect(words()).toHaveLength(0)
  })
})

describe('rendering', () => {
  beforeEach(() => setRecognizedTextShown(true))

  it('draws each word box with its text, in display coordinates at the page scale', async () => {
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, PAGE]])))
    await render()
    const svg = container.querySelector('.full-page .page-frame svg.ocr-text-layer')!
    expect(svg).not.toBeNull()
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${page.width} ${H}`)
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(texts()).toEqual(['Hello', 'wrld', 'again', 'second', 'tbe', 'third', '1ine'])
    // "Hello": baseline start (72, 700) in the overlay frame → (72, 92) on screen; box 30 × 12
    // from 0.8 em above the baseline; the text stretched to the word's width.
    const g = words()[0]
    expect(g.getAttribute('transform')).toBe('translate(72 92) rotate(0)')
    const rect = g.querySelector('rect')!
    expect(+rect.getAttribute('y')!).toBeCloseTo(-9.6)
    expect(+rect.getAttribute('width')!).toBeCloseTo(30)
    expect(+rect.getAttribute('height')!).toBeCloseTo(12)
    const text = g.querySelector('text')!
    expect(+text.getAttribute('textLength')!).toBeCloseTo(30)
    expect(text.getAttribute('lengthAdjust')).toBe('spacingAndGlyphs')
    // Second line: 20 pt lower.
    expect(words()[3].getAttribute('transform')).toBe('translate(72 112) rotate(0)')
  })

  it('rotates a tilted line clockwise on screen (the overlay frame turns counter-clockwise)', async () => {
    const tilted = ocrPage([[['tilt', 0.9]]], { angle: Math.PI / 2 })
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, tilted]])))
    await render()
    expect(words()[0].getAttribute('transform')).toBe('translate(72 92) rotate(-90)')
  })

  it('underlines exactly the words under the calibrated threshold, with a dotted line', async () => {
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, PAGE]])))
    await render()
    // `second` sits AT the threshold, `again` has no confidence: neither is underlined.
    expect(underlined()).toEqual(['wrld', 'tbe', '1ine'])
  })

  it('the underline boundary: a word exactly at the threshold is not underlined, one below is', () => {
    // Float32-exact values, so the comparison sees exactly what was stored.
    const t = Math.fround(0.6)
    const below = Math.fround(0.59)
    const ws = sessionWords(
      ocrPage([
        [
          ['at', t],
          ['under', below],
          ['none', null]
        ]
      ]),
      H,
      t
    )
    expect(ws.map((w) => [w.t, w.low])).toEqual([
      ['at', false],
      ['under', true],
      ['none', false]
    ])
  })

  it('a word with no text is neither drawn nor counted', async () => {
    disconnect = connectRecognizedText(
      fakeSupply(
        new Map([
          [
            KEY,
            ocrPage([
              [
                ['', LOW],
                ['kept', LOW]
              ]
            ])
          ]
        ])
      )
    )
    await render()
    expect(texts()).toEqual(['kept'])
    expect(headerMain()).toBe('Built-in engine · German, English · 1 low-confidence word')
  })

  it('a page recognised without word confidence says so, with no underline and no stepping', async () => {
    const page0 = ocrPage(
      [
        [
          ['plain', null],
          ['words', null]
        ]
      ],
      { confSource: 'none' }
    )
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, page0]])))
    await render()
    expect(texts()).toEqual(['plain', 'words'])
    expect(headerMain()).toBe('Built-in engine · German, English · confidence not available')
    expect(underlined()).toEqual([])
    expect(header()!.querySelector('.ocr-text-header-step')).toBeNull()
  })

  it('while the redaction report is pending, the header says it is updating (not "no text")', async () => {
    const pending = new Set([KEY])
    const fake = fakeSupply(new Map(), { pending })
    disconnect = connectRecognizedText(fake)
    await render()
    expect(words()).toHaveLength(0)
    expect(headerMain()).toBe('Updating for redactions…')
    expect(header()!.querySelector('.ocr-text-header-step')).toBeNull()
    pending.clear()
    await act(async () => fake.fire())
    expect(headerMain()).toBe('No recognized text on this page')
  })

  it('only the current page mounts the layer and its header', async () => {
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, PAGE]])))
    await render({ isCurrent: false })
    expect(container.querySelector('svg.ocr-text-layer')).toBeNull()
    expect(document.body.querySelectorAll('.ocr-text-header')).toHaveLength(0)
    await render({ isCurrent: true })
    expect(document.body.querySelectorAll('.ocr-text-header')).toHaveLength(1)
  })

  it('does not ask the supply for words while hidden', async () => {
    const fake = fakeSupply(new Map([[KEY, PAGE]]))
    const spy = vi.spyOn(fake, 'filteredPage')
    disconnect = connectRecognizedText(fake)
    setRecognizedTextShown(false)
    await render()
    await act(async () => fake.fire())
    expect(spy).not.toHaveBeenCalled()
    await act(async () => setRecognizedTextShown(true))
    expect(spy).toHaveBeenCalled()
  })

  it('sits under the Find matches, which multiply over it (same z-index, later in the page)', async () => {
    findHits.value = [{ rect: { x: 72, y: 82, w: 30, h: 12 }, current: true }]
    try {
      disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, PAGE]])))
      await render()
      const frame = container.querySelector('.page-frame')!
      const layer = frame.querySelector('svg.ocr-text-layer')!
      const find = frame.querySelector('.find-hl-layer')!
      expect(find).not.toBeNull()
      expect(layer.compareDocumentPosition(find) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    } finally {
      findHits.value = []
    }
  })

  it('header: engine, languages, low-confidence count and the session-only note', async () => {
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, PAGE]])))
    await render()
    // Languages in the result's (sorted) order.
    expect(headerMain()).toBe('Built-in engine · German, English · 3 low-confidence words')
    expect(stepText()).toBe('Press ] or [ to step through them')
    expect(header()!.querySelector('.ocr-text-header-note')!.textContent).toMatch(
      /kept only while the file is open.*after reopening, words show without underlines/
    )
    expect(header()!.getAttribute('role')).toBe('status')
  })

  it('header counts: one, none, and no confidence at all', () => {
    const base: RecognizedTextView = {
      source: 'session',
      words: [],
      low: [3],
      engineId: ENGINE_ID,
      langs: ['eng', 'deu'],
      confidence: true
    }
    expect(headerText(base)).toBe('Built-in engine · English, German · 1 low-confidence word')
    expect(headerText({ ...base, low: [] })).toBe(
      'Built-in engine · English, German · no low-confidence words'
    )
    expect(headerText({ ...base, low: [], confidence: false })).toBe(
      'Built-in engine · English, German · confidence not available'
    )
    expect(headerText({ ...base, engineId: 'other-engine/1', langs: ['xyz'] })).toBe(
      'Another engine · xyz · 1 low-confidence word'
    )
    expect(headerText({ ...base, source: 'none' })).toBe('No recognized text on this page')
  })

  it('a page with no recognised text says so, and draws nothing', async () => {
    disconnect = connectRecognizedText(fakeSupply(new Map()))
    await render()
    expect(container.querySelector('svg.ocr-text-layer')).toBeNull()
    expect(headerMain()).toBe('No recognized text on this page')
  })

  it('re-reads the words when the supply says they changed', async () => {
    const pages = new Map<string, PackedOcrPage | null>([[KEY, PAGE]])
    const fake = fakeSupply(pages)
    disconnect = connectRecognizedText(fake)
    await render()
    expect(words()).toHaveLength(7)
    pages.set(KEY, ocrPage([[['only', 0.9]]]))
    await act(async () => fake.fire())
    expect(texts()).toEqual(['only'])
    expect(headerMain()).toBe('Built-in engine · German, English · no low-confidence words')
  })

  it('on a cropped page, words outside the crop window are neither drawn nor counted', async () => {
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, PAGE]])))
    await render()
    // A window holding only the first line (screen y 82..94): frame y ∈ [690, 720].
    await act(async () => store.setCrop(KEY, { x: 0, y: 690, w: 612, h: 30 }))
    expect(texts()).toEqual(['Hello', 'wrld', 'again'])
    expect(headerMain()).toBe('Built-in engine · German, English · 1 low-confidence word')
    await act(async () => store.setCrop(KEY, null))
    expect(words()).toHaveLength(7)
  })
})

describe('stepping through low-confidence words', () => {
  beforeEach(() => setRecognizedTextShown(true))

  it('] and [ move a focus ring through them in reading order, wrapping', async () => {
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, PAGE]])))
    await render()
    expect(focusedWord()).toBeNull()
    await press(']')
    expect(focusedWord()).toBe('wrld')
    expect(stepText()).toBe('1 of 3')
    expect(header()!.querySelector('[aria-live]')!.textContent).toBe(
      'Low-confidence word 1 of 3: wrld'
    )
    await press(']')
    expect(focusedWord()).toBe('tbe')
    await press(']')
    expect(focusedWord()).toBe('1ine')
    expect(stepText()).toBe('3 of 3')
    await press(']')
    expect(focusedWord()).toBe('wrld')
    await press('[')
    expect(focusedWord()).toBe('1ine')
    await press('[')
    expect(focusedWord()).toBe('tbe')
  })

  it('[ first goes to the last one', async () => {
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, PAGE]])))
    await render()
    await press('[')
    expect(focusedWord()).toBe('1ine')
  })

  it('leaves the keys alone with a modifier, in a text field, or on a page not taking input', async () => {
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, PAGE]])))
    await render()
    await press(']', { ctrlKey: true })
    await press(']', { altKey: true })
    const input = document.createElement('input')
    document.body.appendChild(input)
    await press(']', {}, input)
    input.remove()
    expect(focusedWord()).toBeNull()
    await render({ interactive: false })
    await press(']')
    expect(focusedWord()).toBeNull()
  })

  it('on AltGr layouts: the US bracket keys by code, and a bracket typed with AltGr, also step', async () => {
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, PAGE]])))
    await render()
    // German: the key at the US `]` position types `+`, the one at `[` types `ü`.
    await press('+', { code: 'BracketRight' })
    expect(focusedWord()).toBe('wrld')
    await press('+', { code: 'BracketRight' })
    expect(focusedWord()).toBe('tbe')
    await press('ü', { code: 'BracketLeft' })
    expect(focusedWord()).toBe('wrld')
    // AltGr+9 types `]` and arrives as Ctrl+Alt on Windows, with the AltGraph modifier state.
    await press(']', { code: 'Digit9', ctrlKey: true, altKey: true, modifierAltGraph: true })
    expect(focusedWord()).toBe('tbe')
    await press('[', { code: 'Digit8', ctrlKey: true, altKey: true, modifierAltGraph: true })
    expect(focusedWord()).toBe('wrld')
  })

  it('the bracket codes do not step with a modifier, nor does a real Ctrl+Alt bracket', async () => {
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, PAGE]])))
    await render()
    await press('}', { code: 'BracketRight', shiftKey: true })
    await press('*', { code: 'BracketRight', ctrlKey: true })
    await press('~', { code: 'BracketRight', ctrlKey: true, altKey: true, modifierAltGraph: true })
    await press(']', { code: 'BracketRight', ctrlKey: true, altKey: true })
    await press('ü', { code: 'BracketLeft', altKey: true })
    expect(focusedWord()).toBeNull()
  })

  it('a handled key is consumed', async () => {
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, PAGE]])))
    await render()
    for (const key of [']', '[']) {
      const e = new KeyboardEvent('keydown', { key, cancelable: true })
      await act(async () => void window.dispatchEvent(e))
      expect(e.defaultPrevented).toBe(true)
    }
  })

  it('with no low-confidence word, ] is not consumed', async () => {
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, ocrPage([[['fine', 0.99]]])]])))
    await render()
    const e = new KeyboardEvent('keydown', { key: ']', cancelable: true })
    await act(async () => void window.dispatchEvent(e))
    expect(e.defaultPrevented).toBe(false)
    expect(stepText()).toBe('')
  })

  it('leaves alone a key with Meta, or one an earlier handler already took', async () => {
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, PAGE]])))
    await render()
    await press(']', { metaKey: true })
    expect(focusedWord()).toBeNull()
    const taken = (e: KeyboardEvent): void => e.preventDefault()
    window.addEventListener('keydown', taken, { capture: true })
    try {
      await press(']', {}, document.body)
      expect(focusedWord()).toBeNull()
    } finally {
      window.removeEventListener('keydown', taken, { capture: true })
    }
    await press(']')
    expect(focusedWord()).toBe('wrld')
  })

  it('keeps its place when the supply changes without changing the words (a redacted page)', async () => {
    // A redacted page's filtered words are a new object on every supply change.
    const pages = new Map<string, PackedOcrPage | null>([[KEY, PAGE]])
    const fake = fakeSupply(pages, { fresh: true })
    disconnect = connectRecognizedText(fake)
    await render()
    await press(']')
    await press(']')
    expect(focusedWord()).toBe('tbe')
    expect(stepText()).toBe('2 of 3')
    // An edit elsewhere, another page's result: the same words come back as a new object.
    await act(async () => fake.fire())
    await act(async () => store.setCrop(makePageKey(scan.id, 5), { x: 0, y: 0, w: 10, h: 10 }))
    expect(focusedWord()).toBe('tbe')
    expect(stepText()).toBe('2 of 3')
    // Different low-confidence words: from the top again.
    pages.set(KEY, ocrPage([[['new', LOW]], [['set', LOW]]]))
    await act(async () => fake.fire())
    expect(focusedWord()).toBeNull()
    expect(stepText()).toBe('Press ] or [ to step through them')
  })

  it('pans a zoomed page to bring a word off screen into view', async () => {
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, PAGE]])))
    const panBy = vi.fn()
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      // The focus ring sits far right of a 1024 × 768 window (jsdom's default size).
      if (this.classList.contains('ocr-focus'))
          return { left: 1500, top: 100, right: 1540, bottom: 116, width: 40, height: 16, x: 1500, y: 100, toJSON: () => ({}) } as DOMRect // prettier-ignore
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect // prettier-ignore
    })
    try {
      await render({ zoomed: true, panBy })
      await press(']')
      const vw = document.documentElement.clientWidth || window.innerWidth
      const vh = document.documentElement.clientHeight || window.innerHeight
      expect(panBy).toHaveBeenCalledTimes(1)
      const [dx, dy] = panBy.mock.calls[0]
      expect(dx).toBeCloseTo(vw / 2 - 1520)
      expect(dy).toBeCloseTo(vh / 2 - 108)
    } finally {
      spy.mockRestore()
    }
  })

  it('pans once per step, even though panning re-renders the page with a new panBy', async () => {
    // The real panBy (FullViewPages) is a new function after every view change: the reveal must
    // not run again for it (that looped until React gave up, blanking the app).
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, PAGE]])))
    let calls = 0
    let bump: () => void = () => {}
    function Panning(): ReactNode {
      const [n, setN] = useState(0)
      bump = () => setN((v) => v + 1)
      return createElement(Harness, {
        zoomed: true,
        panBy: () => {
          calls++
          if (calls < 50) bump()
        },
        key: 'h',
        ...{ n }
      } as never)
    }
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ left: 4000, top: 100, right: 4040, bottom: 116, width: 40, height: 16, x: 4000, y: 100, toJSON: () => ({}) }) as DOMRect // prettier-ignore
    )
    try {
      await act(async () => root.render(createElement(Panning)))
      await press(']')
      expect(calls).toBe(1)
      await press(']')
      expect(calls).toBe(2)
    } finally {
      spy.mockRestore()
    }
  })

  it('does not pan for a word already well inside the window', async () => {
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, PAGE]])))
    const panBy = vi.fn()
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ left: 300, top: 300, right: 340, bottom: 316, width: 40, height: 16, x: 300, y: 300, toJSON: () => ({}) }) as DOMRect // prettier-ignore
    )
    try {
      await render({ panBy })
      await press(']')
      expect(panBy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('a reopened file: its saved PDFx OCR layer', () => {
  beforeEach(() => setRecognizedTextShown(true))
  const RUNS = [
    { t: 'saved line one', x: 72, y: 92, w: 84, size: 12, deg: 0 },
    { t: 'saved line two', x: 72, y: 112, w: 84, size: 12, deg: 0 }
  ]

  const redaction = (id = 'red-1'): Overlay => ({
    id,
    pageKey: KEY,
    z: 1,
    createdAt: 1,
    type: 'redaction',
    fill: { r: 0, g: 0, b: 0 },
    geom: { x: 500, y: 20, w: 30, h: 20, rotation: 0, opacity: 1 }
  })

  it('shows its runs without underlines, and says confidence is not kept', async () => {
    savedRuns.value = RUNS
    disconnect = connectRecognizedText(fakeSupply(new Map()))
    await render()
    await act(async () => settle(2))
    expect(texts()).toEqual(['saved line one', 'saved line two'])
    expect(underlined()).toEqual([])
    expect(headerMain()).toBe('Recognized text saved in this file · confidence not kept')
    expect(vi.mocked(readSavedLayer)).toHaveBeenCalledWith(page.source.pdf, 0)
  })

  it('is not shown on a page with a redaction (the export drops it whole), and is again on undo', async () => {
    savedRuns.value = RUNS
    disconnect = connectRecognizedText(fakeSupply(new Map()))
    await render()
    await act(async () => settle(2))
    expect(words()).toHaveLength(2)
    await act(async () => store.addOverlay(redaction()))
    expect(words()).toHaveLength(0)
    expect(headerMain()).toBe('No recognized text on this page')
    await act(async () => store.undo())
    await act(async () => settle(2))
    expect(words()).toHaveLength(2)
  })

  it('is not shown after Remove Recognized Text (an ocrSelect choice)', async () => {
    savedRuns.value = RUNS
    disconnect = connectRecognizedText(fakeSupply(new Map()))
    await render()
    await act(async () => store.selectOcr(KEY, null))
    await act(async () => settle(2))
    expect(words()).toHaveLength(0)
  })

  it('session text wins over the saved layer', async () => {
    savedRuns.value = RUNS
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, PAGE]])))
    await render()
    await act(async () => settle(2))
    expect(words()).toHaveLength(7)
    expect(vi.mocked(readSavedLayer)).not.toHaveBeenCalled()
  })
})

describe('redaction filtering through the real OCR store and Find supply', () => {
  beforeEach(() => setRecognizedTextShown(true))

  let ocr: OcrStore
  let supply: OcrFindSupply
  afterEach(() => {
    supply?.dispose()
    ocr?.dispose()
  })

  /** A redaction over "hello" (x 72..102, baseline 700, 12 pt; recognisedPage's layout). */
  const overHello: Overlay = {
    id: 'red-1',
    pageKey: KEY,
    z: 1,
    createdAt: 1,
    type: 'redaction',
    fill: { r: 0, g: 0, b: 0 },
    geom: { x: 70, y: 695, w: 34, h: 20, rotation: 0, opacity: 1 }
  }

  async function rig(predict: () => Promise<Map<string, never[]>>): Promise<void> {
    scan.pdf = {
      texts: [nativeText(0)],
      getPage: async () => ({ userUnit: 1 })
    } as unknown as PageEntry['source']['pdf']
    const engine = createFindEngine({
      onChange: () => {},
      extract: async (pdf, i) => (pdf as unknown as { texts: PageText[] }).texts[i]
    })
    const port = new FakeOcrPort()
    ocr = createOcrStore({
      port,
      text: engine,
      getSettings: async () => defaultSettings('en'),
      idle: eagerIdle
    })
    supply = createOcrFindSupply({ store: ocr, text: engine, predict, debounceMs: 0 })
    const docs: DocEntry[] = [doc('d', [page])]
    engine.reconcile(docs)
    ocr.reconcile(docs)
    onEdits = (s) => supply.sync(docs, s.editLayer)
    disconnect = connectRecognizedText(supply)
    await render()
    await act(async () => settle())
    // Triage, recognise, answer.
    const src = port.of('open')[0]?.src
    if (src) port.emit({ triaged: { src, pages: [triaged(0, 'scanned')], done: true } })
    await act(async () => settle())
    ocr.recognize([KEY])
    await act(async () => settle())
    const req = port.recognizes().at(-1)!
    port.emit({
      result: {
        jobId: req.jobId,
        src: req.src,
        index: 0,
        page: okResult(recognisedPage(['hello', 'world']))
      }
    })
    port.emit({ jobDone: { jobId: req.jobId, done: 1, failed: 0, cancelled: false } })
    await act(async () => settle())
  }

  it('draws the words Find has; a redaction takes its word away once the pass reports, undo restores it', async () => {
    let release: (r: Map<string, never[]>) => void = () => {}
    let calls = 0
    await rig(() => {
      calls++
      return calls === 1
        ? new Promise((resolve) => (release = resolve))
        : Promise.resolve(new Map([[KEY, []]]))
    })
    expect(texts()).toEqual(['hello', 'world'])
    expect(headerMain()).toBe('Built-in engine · English · no low-confidence words')

    await act(async () => store.addOverlay(overHello))
    await act(async () => settle())
    // Fail-safe: while the pass's report is pending, no recognised word is shown at all, and the
    // header says why rather than claiming the page has no text.
    expect(words()).toHaveLength(0)
    expect(headerMain()).toBe('Updating for redactions…')
    // Pixel redaction applied: nothing removed whole; only the word under the box goes.
    await act(async () => {
      release(new Map([[KEY, []]]))
      await settle()
    })
    expect(texts()).toEqual(['world'])

    await act(async () => store.undo())
    await act(async () => settle())
    expect(texts()).toEqual(['hello', 'world'])
  })

  it('a scan the redaction pass will remove whole takes every word with it (rule 2)', async () => {
    await rig(async () => new Map([[KEY, [{ x: 0, y: 0, w: 612, h: 792 }] as never[]]]))
    await act(async () => store.addOverlay(overHello))
    await act(async () => settle())
    expect(words()).toHaveLength(0)
    expect(headerMain()).toBe('No recognized text on this page')
  })
})

describe('the header inside full view', () => {
  beforeEach(() => setRecognizedTextShown(true))

  /** FullViewPages (the backdrop click closes full view) with the bar's header slot, as FullView. */
  function Pages(props: { runClose: () => void; slot: HTMLElement | null }): ReactNode {
    const s = useEditStore()
    store = s
    const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 })
    const pages = createElement(FullViewPages, {
      scrollRef: { current: null },
      drag: { current: null },
      draggedRef: { current: false },
      docs: [doc('d', [page])],
      viewport: { w: 1200, h: 900 },
      di: 0,
      pi: 0,
      view,
      fit: { w: 612, h: 792 },
      vw: 1200,
      vh: 900,
      zoomed: false,
      interactive: true,
      animating: false,
      flip: null,
      flipTransition: false,
      renderVersion: 0,
      setView,
      resetView: () => {},
      applyZoom: () => {},
      runClose: props.runClose
    })
    return createElement(EditProvider, {
      store: s,
      children: createElement(FullViewHeaderSlot.Provider, { value: props.slot, children: pages })
    })
  }

  it('clicking Hide (or anywhere on the header) does not close full view', async () => {
    const slot = document.createElement('div')
    document.body.appendChild(slot)
    try {
      disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, PAGE]])))
      const runClose = vi.fn()
      await act(async () => root.render(createElement(Pages, { runClose, slot })))
      // The header lands in the bar's slot, not loose in <body>.
      expect(slot.querySelector('.ocr-text-header')).not.toBeNull()
      const fire = (el: Element, type: string): void => {
        const init = { bubbles: true, cancelable: true }
        el.dispatchEvent(
          type.startsWith('pointer') ? new PointerEvent(type, init) : new MouseEvent(type, init)
        )
      }
      const note = slot.querySelector('.ocr-text-header-note')!
      await act(async () => {
        for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick']) fire(note, type)
      })
      expect(runClose).not.toHaveBeenCalled()
      expect(isRecognizedTextShown()).toBe(true)
      const hide = slot.querySelector<HTMLButtonElement>('.ocr-text-header-hide')!
      await act(async () => hide.click())
      expect(runClose).not.toHaveBeenCalled()
      expect(isRecognizedTextShown()).toBe(false)
      // A click on the backdrop itself still closes.
      await act(async () => fire(container.querySelector('.full-scroll')!, 'click'))
      expect(runClose).toHaveBeenCalledTimes(1)
    } finally {
      slot.remove()
    }
  })

  it('the bar gives the header a slot of its own between the title and the close button', async () => {
    let slot: HTMLDivElement | null = null
    await act(async () =>
      root.render(
        createElement(FullViewChrome, {
          chromeOpacity: 1,
          docName: 'Quarterly board meeting minutes - scanned archive copy 2024.pdf',
          pi: 0,
          pageCount: 1,
          runClose: () => {},
          navByKey: () => {},
          headerSlotRef: (el) => void (slot = el)
        })
      )
    )
    const bar = container.querySelector('.full-bar')!
    expect([...bar.children].map((e) => e.className)).toEqual([
      'full-title',
      'full-bar-slot',
      'icon-btn'
    ])
    expect(slot).toBe(bar.children[1])
    // A long title is cut with an ellipsis (styles.css): its full text stays in the tooltip.
    expect(bar.children[0].getAttribute('title')).toMatch(/archive copy 2024\.pdf$/)
  })

  it('renders no header until the bar has given its slot', async () => {
    disconnect = connectRecognizedText(fakeSupply(new Map([[KEY, PAGE]])))
    await act(async () => root.render(createElement(Pages, { runClose: () => {}, slot: null })))
    expect(document.body.querySelector('.ocr-text-header')).toBeNull()
    expect(container.querySelector('svg.ocr-text-layer')).not.toBeNull()
  })
})
