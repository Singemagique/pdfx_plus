// The OCR surfaces (DESIGN.md §3.8) over the REAL store, driven through a scripted port: the page
// badge, the DocHeader chip, the toolbar button and activity pill (with its job popover), the Find
// row, the full-view banner, the summary popover rows, the toasts, the live region and the
// scan-redaction note. Each surface is checked in each of its states.

import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makePageKey } from '../../edit/model'
import { OcrUiProvider, NULL_OCR_ACTIONS, type OcrActions } from '../../ocr/OcrContext'
import type { OcrFindSupply } from '../../ocr/ocr-find-supply'
import { createOcrStore, type OcrStore } from '../../ocr/ocr-store'
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
} from '../../ocr/test-utils/fake-ocr'
import type { PageResult } from '../../../../shared/ocr/protocol'
import { defaultSettings } from '../../../../shared/settings'
import type { DocEntry } from '../../types'
import { FindBar } from '../FindBar'
import type { FindBarState, FindController } from '../../search/find-controller'
import { NULL_FIND_CONTROLLER } from '../../search/FindContext'
import { OcrBanner } from './OcrBanner'
import { OcrDocChip } from './OcrDocChip'
import { OcrFindRow } from './OcrFindRow'
import { BADGE_COPY, OcrPageBadge } from './OcrPageBadge'
import { OcrRedactionNote, REDACTION_NOTE } from './OcrRedactionNote'
import { OcrToasts, type Flash } from './OcrAppParts'
import { OcrToolbarItems, RECOGNIZE_TOOLTIP } from './OcrToolbarItems'
import { OcrExportPrompt } from '../OcrExportPrompt'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const scan = source('scan')
const text = source('text', { bytes: new Uint8Array([9, 9, 9, 9, 9, 9, 9]) })
const keys = [0, 1, 2].map((i) => makePageKey(scan.id, i))
const textKey = makePageKey(text.id, 0)
const docs: DocEntry[] = [
  doc('d1', [pageOf(scan, 0), pageOf(scan, 1), pageOf(scan, 2)]),
  doc('d2', [pageOf(text, 0)])
]

let root: Root
let container: HTMLDivElement
let port: FakeOcrPort
let store: OcrStore
let flash: ReturnType<typeof vi.fn<Flash>>
let actions: OcrActions & Record<string, ReturnType<typeof vi.fn>>

const tick = (ms = 20): Promise<void> =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms))
    await settle()
  })

beforeEach(async () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  port = new FakeOcrPort()
  store = createOcrStore({
    port,
    text: new FakeText(
      new Map([
        ...keys.map((k) => [k, nativeText(0)] as const),
        [textKey, nativeText(400)] as const
      ])
    ),
    getSettings: async () => defaultSettings('en'),
    idle: eagerIdle,
    notifyMs: 0
  })
  store.reconcile(docs)
  await settle()
  // Stage 0 found the scan; triage classes its three pages.
  const src = port.of('open')[0].src
  port.emit({ triaged: { src, pages: [0, 1, 2].map((i) => triaged(i, 'scanned')), done: true } })
  await settle()
  flash = vi.fn<Flash>()
  actions = {
    openDialog: vi.fn(),
    recognizeNow: vi.fn((k: readonly string[]) => void store.recognize(k)),
    openSummary: vi.fn(),
    viewPage: vi.fn(),
    rotatePage: vi.fn()
  }
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  store.dispose()
})

function Surfaces({ children }: { children?: ReactNode }): React.JSX.Element {
  return createElement(OcrUiProvider, {
    value: { store, supply: null, actions },
    docs,
    children: [
      createElement(OcrToolbarItems, { key: 'tb', busy: false }),
      ...docs.map((d) =>
        createElement(
          'div',
          { key: d.id, 'data-doc': d.id },
          createElement(OcrDocChip, { docId: d.id })
        )
      ),
      ...[...keys, textKey].map((k) =>
        createElement('div', { key: k, 'data-key': k }, createElement(OcrPageBadge, { pageKey: k }))
      ),
      createElement(OcrFindRow, { key: 'find' }),
      createElement(OcrToasts, { key: 'toasts', store, flash, onDetails: vi.fn() }),
      createElement('div', { key: 'extra' }, children)
    ]
  } as never)
}

async function mount(children?: ReactNode): Promise<void> {
  await act(async () => root.render(createElement(Surfaces, null, children)))
  await tick()
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel)
const badge = (k: string): HTMLElement | null => q(`[data-key="${k}"] .ocr-badge`)
const chip = (docId = 'd1'): HTMLElement | null => q(`[data-doc="${docId}"] .ocr-chip`)
const buttonByText = (t: string | RegExp): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    typeof t === 'string' ? b.textContent === t : t.test(b.textContent ?? '')
  )
const click = (el: Element | null | undefined): Promise<void> =>
  act(async () => {
    ;(el as HTMLElement).click()
    await settle()
  })

/** Answer page `index` of the latest recognize request. */
function answer(index: number, page: Partial<PageResult> = {}): void {
  const reqs = port.recognizes()
  const r = reqs[reqs.length - 1]
  port.emit({
    result: {
      jobId: r.jobId,
      src: r.src,
      index,
      page: { ...okResult(recognisedPage([`w${index}`])), ...page }
    }
  })
}

describe('before recognition: scanned pages wait', () => {
  it('badges every scanned page (label + tooltip) and no text page', async () => {
    await mount()
    for (const k of keys) {
      expect(badge(k)?.getAttribute('aria-label')).toBe('Scanned page – text not recognized')
      expect(badge(k)?.getAttribute('title')).toBe('Scanned page — its text isn’t searchable yet')
    }
    expect(badge(textKey)).toBeNull()
  })

  it('shows the Recognize Text button (tooltip) and opens the dialog with it', async () => {
    await mount()
    const b = buttonByText(/Recognize Text/)!
    expect(b.title).toBe(RECOGNIZE_TOOLTIP)
    await click(b)
    expect(actions.openDialog).toHaveBeenCalledWith()
    expect(q('.ocr-pill')).toBeNull()
  })

  it('chip "Scanned · Recognize text" recognises the document’s pages in one click', async () => {
    await mount()
    expect(chip()?.textContent).toBe('Scanned · Recognize text')
    expect(chip('d2')).toBeNull()
    await click(chip())
    expect(actions.recognizeNow).toHaveBeenCalledWith(keys)
  })

  it('Find row: "3 scanned pages weren’t searched. [Recognize text]"', async () => {
    await mount()
    expect(q('.findbar-row2')?.textContent).toBe('3 scanned pages weren’t searched.Recognize text')
    await click(buttonByText('Recognize text'))
    expect(actions.recognizeNow).toHaveBeenCalledWith(keys)
  })

  it('the Find bar says "No results · 3 scanned pages not searched"', async () => {
    const state: FindBarState = {
      ...NULL_FIND_CONTROLLER.getBarState(),
      open: true,
      query: 'zebra'
    }
    const ctl: FindController = { ...NULL_FIND_CONTROLLER, getRawQuery: () => 'zebra' }
    await mount(createElement(FindBar, { controller: ctl, state }))
    expect(q('.findbar-count')?.textContent).toBe('No results · 3 scanned pages not searched')
    expect(q('.findbar .findbar-row2')).not.toBeNull()
  })
})

describe('while recognising', () => {
  it('rings on the pages, "Recognizing n / 3 ✕" chip, the pill with its percentage, no button', async () => {
    await mount()
    await act(async () => void store.recognize(keys))
    await tick()
    expect(badge(keys[0])?.getAttribute('aria-label')).toBe(BADGE_COPY.running)
    expect(badge(keys[0])?.querySelector('.ocr-ring')).not.toBeNull()
    expect(chip()?.textContent).toContain('Recognizing 0 / 3')
    expect(q('.ocr-pill')?.textContent).toContain('Recognizing text · 0%')
    expect(buttonByText(/^Recognize Text$/)).toBeUndefined()
    await act(async () => answer(0))
    await tick()
    expect(chip()?.textContent).toContain('Recognizing 1 / 3')
    expect(q('.ocr-pill')?.textContent).toContain('Recognizing text · 33%')
    expect(badge(keys[0])).toBeNull() // done: nothing
  })

  it('✕ on the chip ("Stop recognizing text") stops; the toast says what was kept', async () => {
    await mount()
    await act(async () => void store.recognize(keys))
    await tick()
    await act(async () => answer(0))
    await tick()
    const x = q<HTMLButtonElement>('[aria-label="Stop recognizing text"]')!
    await click(x)
    await tick()
    expect(q('.ocr-pill')).toBeNull()
    expect(flash).toHaveBeenCalledWith('Stopped. 1 of 3 pages recognized.')
    // The two pages never recognised wait again.
    expect(badge(keys[1])?.getAttribute('aria-label')).toBe(BADGE_COPY.label)
  })

  it('the pill opens the job popover: per-document rows and Stop all (Esc closes it)', async () => {
    await mount()
    await act(async () => void store.recognize(keys))
    await tick()
    await click(q('.ocr-pill'))
    const pop = q('.ocr-jobs')!
    expect(pop.getAttribute('role')).toBe('dialog')
    expect(pop.textContent).toContain('d1.pdf')
    expect(pop.textContent).toContain('0 / 3')
    // Focus moved into the popover (keyboard path); Esc closes it.
    expect(pop.contains(document.activeElement)).toBe(true)
    await act(async () => {
      pop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(q('.ocr-jobs')).toBeNull()
    await click(q('.ocr-pill'))
    await click(buttonByText('Stop all'))
    await tick()
    expect(q('.ocr-pill')).toBeNull()
    expect(store.getSnapshot().batches.every((b) => b.state !== 'running')).toBe(true)
  })

  it('a crash: the pill says it stopped, the toast offers Resume, which resumes', async () => {
    await mount()
    await act(async () => void store.recognize(keys))
    await tick()
    await act(async () => port.disconnected('crashed'))
    await tick()
    expect(q('.ocr-pill')?.textContent).toBe('Text recognition stopped')
    const call = flash.mock.calls.find((c) => /stopped unexpectedly/.test(c[0]))!
    expect(call[0]).toBe('Text recognition stopped unexpectedly; 0 of 3 pages done.')
    expect(call[1]!.label).toBe('Resume')
    await act(async () => call[1]!.run())
    await tick()
    expect(store.getSnapshot().running).toBe(true)
  })
})

describe('finished', () => {
  it('toast, nothing on fine pages, a dot for Low confidence, and "1 page needs attention"', async () => {
    await mount()
    await act(async () => void store.recognize(keys))
    await tick()
    await act(async () => {
      answer(0)
      answer(1, { status: 'low-confidence' })
      answer(2)
    })
    await tick()
    expect(flash).toHaveBeenCalledWith('Text recognized on 3 pages — now searchable')
    expect(badge(keys[0])).toBeNull()
    expect(badge(keys[1])?.classList.contains('dot')).toBe(true)
    expect(badge(keys[1])?.getAttribute('aria-label')).toBe(BADGE_COPY.low)
    expect(chip()?.textContent).toBe('1 page needs attention')
    expect(q('.findbar-row2')).toBeNull()
    expect(q('.sr-only[role="status"]')?.textContent).toBe(
      'Text recognized on 3 pages — now searchable'
    )
  })

  it('the summary popover: Low confidence row with [View] [Replace…], and its footer', async () => {
    await mount()
    await act(async () => void store.recognize(keys))
    await tick()
    await act(async () => {
      answer(0)
      answer(1, { status: 'low-confidence' })
      answer(2)
    })
    await tick()
    await click(chip())
    const pop = q('.ocr-summary')!
    expect(pop.textContent).toContain('Page 2')
    expect(pop.textContent).toContain('Low confidence — check the language or scan quality')
    expect(pop.textContent).toContain('Recognized with the built-in engine (Tesseract)')
    await click(buttonByText('View'))
    expect(actions.viewPage).toHaveBeenCalledWith('d1', 'scan-p1')
    await click(chip())
    await click(buttonByText('Replace…'))
    expect(actions.openDialog).toHaveBeenCalledWith({ mode: 'replace', keys: [keys[1]] })
  })

  it('Sideways — rotate the page? [Rotate] uses the undoable rotate; the row goes once turned', async () => {
    await mount()
    await act(async () => void store.recognize(keys))
    await tick()
    await act(async () => {
      answer(0, { rotateBy: 90 })
      answer(1)
      answer(2)
    })
    await tick()
    await click(chip())
    expect(q('.ocr-summary')?.textContent).toContain('Sideways — rotate the page?')
    await click(buttonByText('Rotate'))
    expect(actions.rotatePage).toHaveBeenCalledWith(keys[0], 90)
    // What App's rotatePage does: the edit history's rotation, synced into the store.
    await act(async () => store.syncEdits({ rotations: new Map([[keys[0], 90]]) }))
    await tick()
    expect(chip()).toBeNull()
  })

  it('Took too long and was skipped [Try again] / out of memory [Try again] ask again', async () => {
    await mount()
    await act(async () => void store.recognize(keys))
    await tick()
    await act(async () => {
      answer(0, { status: 'timeout', recognition: null })
      answer(1, { status: 'failed', reason: 'heap', recognition: null })
      answer(2)
    })
    await tick()
    expect(flash).toHaveBeenCalledWith(
      'Text recognized on 1 of 3 pages · 2 need attention',
      expect.objectContaining({ label: 'Details' })
    )
    expect(chip()?.textContent).toBe('2 pages need attention')
    await click(chip())
    const text = q('.ocr-summary')!.textContent!
    expect(text).toContain('Took too long and was skipped')
    expect(text).toContain('Couldn’t recognize (out of memory)')
    const before = port.recognizes().length
    await click(buttonByText('Try again'))
    await tick()
    expect(port.recognizes().length).toBe(before + 1)
  })

  it('a protected PDF and a too-large page get their rows', async () => {
    await mount()
    const src = port.of('open')[0].src
    await act(async () => {
      port.emit({
        triaged: {
          src,
          pages: [triaged(0, 'protected'), { ...triaged(1, null), failure: 'too-large' as const }],
          done: true
        }
      })
      await settle()
      store.recognize(keys)
    })
    await tick()
    // The third page is recognised: the chip turns to the pages that need attention.
    await act(async () => answer(2))
    await tick()
    expect(store.getPageState(keys[0])?.skip).toBe('protected')
    await click(chip())
    const text = q('.ocr-summary')!.textContent!
    expect(text).toContain('This PDF is protected; PDFx can’t add searchable text to it.')
    expect(text).toContain('This page is too large for text recognition.')
  })
})

describe('automatic recognition of an imported image (D4)', () => {
  it('runs with the pill (Stop all) and says when done', async () => {
    const img = source('photo', {
      origin: 'image',
      bytes: new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7])
    })
    const imgKey = makePageKey(img.id, 0)
    const withImage: DocEntry[] = [...docs, doc('d3', [pageOf(img, 0)])]
    store.reconcile(withImage)
    await act(async () =>
      root.render(
        createElement(OcrUiProvider, {
          value: { store, supply: null, actions },
          docs: withImage,
          children: [
            createElement(OcrToolbarItems, { key: 'tb', busy: false }),
            createElement(OcrToasts, { key: 't', store, flash, onDetails: vi.fn() })
          ]
        } as never)
      )
    )
    await tick(40)
    const src = port.of('open').find((o) => o.bytes.length === 8)!.src
    await act(async () => {
      port.emit({ triaged: { src, pages: [triaged(0, 'scanned')], done: true } })
    })
    await tick()
    expect(q('.ocr-pill')?.textContent).toContain('Recognizing text')
    await click(q('.ocr-pill'))
    expect(buttonByText('Stop all')).toBeDefined()
    await act(async () => {
      const r = port.recognizes().find((x) => x.src === src)!
      port.emit({
        result: { jobId: r.jobId, src, index: 0, page: okResult(recognisedPage(['photo'])) }
      })
    })
    await tick()
    expect(store.getPageState(imgKey)?.hasText).toBe(true)
    expect(flash).toHaveBeenCalledWith('Text recognized on 1 page — now searchable')
  })
})

describe('OCR unavailable', () => {
  it('says "Text recognition couldn’t start." once, with the error code behind Details', async () => {
    await mount()
    await act(async () => void store.recognize(keys))
    await tick()
    await act(async () => port.disconnected('crash-loop'))
    await tick()
    const call = flash.mock.calls.find((c) => c[0] === 'Text recognition couldn’t start.')!
    expect(call[1]!.label).toBe('Details')
    call[1]!.run()
    expect(flash).toHaveBeenLastCalledWith('Error code: crash-loop · nothing was sent anywhere')
  })
})

describe('full-view banner', () => {
  const banner = (
    pageKey: string,
    seen: Set<string>,
    onShown = vi.fn(),
    onDone = vi.fn()
  ): ReactNode =>
    createElement(OcrBanner, {
      docId: pageKey === textKey ? 'd2' : 'd1',
      pageKey,
      seen,
      onShown,
      onDone
    })

  it('offers "Recognize 3 pages / Just this page / Not now" on an unrecognised scan', async () => {
    const onShown = vi.fn()
    const onDone = vi.fn()
    await mount(banner(keys[1], new Set(), onShown, onDone))
    const b = q('.ocr-banner')!
    expect(b.getAttribute('role')).toBe('status')
    expect(b.textContent).toContain(
      'This page is a scanned image. Recognize its text to search it and to make exported PDFs searchable.'
    )
    expect(onShown).toHaveBeenCalledWith('d1')
    await click(buttonByText('Just this page'))
    expect(actions.recognizeNow).toHaveBeenLastCalledWith([keys[1]])
    await tick()
    // Running: "Recognizing text… page 1 of 1 [Stop]".
    expect(q('.ocr-banner')?.textContent).toContain('Recognizing text… page 1 of 1')
    await click(buttonByText('Stop'))
    expect(onDone).toHaveBeenCalledWith('d1')
  })

  it('Recognize 3 pages and Not now', async () => {
    const onDone = vi.fn()
    await mount(banner(keys[0], new Set(), vi.fn(), onDone))
    await click(buttonByText('Not now'))
    expect(onDone).toHaveBeenCalledWith('d1')
    await click(buttonByText('Recognize 3 pages'))
    expect(actions.recognizeNow).toHaveBeenLastCalledWith(keys)
  })

  it('is not shown again for a document already seen, nor on a text page', async () => {
    await mount(banner(keys[0], new Set(['d1'])))
    expect(q('.ocr-banner')).toBeNull()
    await act(async () => root.render(createElement(Surfaces, null, banner(textKey, new Set()))))
    expect(q('.ocr-banner')).toBeNull()
  })
})

describe('scan-redaction note', () => {
  const supply = (outcome: 'unknown' | 'pixels' | 'whole'): OcrFindSupply =>
    ({
      redactionOutcome: () => outcome,
      onChange: () => () => {}
    }) as unknown as OcrFindSupply

  async function note(
    key: string,
    outcome: 'unknown' | 'pixels' | 'whole'
  ): Promise<string | null> {
    await act(async () =>
      root.render(
        createElement(OcrUiProvider, {
          value: { store, supply: supply(outcome), actions: NULL_OCR_ACTIONS },
          docs,
          children: createElement(OcrRedactionNote, { pageKey: key })
        } as never)
      )
    )
    return q('.ocr-redaction-note')?.textContent ?? null
  }

  it('D3: the covered pixels; the whole image when the pass removes it; nothing on text pages', async () => {
    expect(await note(keys[0], 'unknown')).toBe(
      'Redacting removes the covered pixels and any recognized words under them.'
    )
    expect(await note(keys[0], 'pixels')).toBe(REDACTION_NOTE.pixels)
    expect(await note(keys[0], 'whole')).toBe(
      'Redacting part of a scanned page removes the whole scan image and its recognized text.'
    )
    expect(await note(textKey, 'whole')).toBeNull()
  })
})

describe('signed-source note in the export confirm', () => {
  it('the mid-job prompt carries the note when a source is signed, and not otherwise', async () => {
    store.recognize(keys)
    await settle()
    let answer: Promise<boolean> = Promise.resolve(false)
    for (const signedNote of [true, false]) {
      await act(async () => root.render(createElement(OcrExportPrompt, { store, signedNote })))
      await act(async () => {
        answer = store.exportSource.flushOrConfirm(docs)
        await settle()
      })
      const text = q('[role="dialog"]')!.textContent!
      expect(text).toContain('Text recognition is still running (0 of 3 pages)')
      expect(text.includes('the source’s digital signature won’t be valid in it')).toBe(signedNote)
      await act(async () => {
        store.answerPrompt('cancel')
        await answer
      })
    }
  })
})
