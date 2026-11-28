// The export wiring with the REAL OCR store and the REAL mid-job prompt (DESIGN.md §3.7.1, §3.8):
// useExport takes the store's OcrExportSource; while recognition runs, the prompt asks before the
// save dialog. "Wait and export" waits (non-modal, busy untouched) and the layer then carries every
// page; "Export now" exports without the pages still running; Cancel (or Esc) exports nothing.
// Assembly, the redaction pass and the file dialog are boundaries, as in useExport.dom.test.ts.

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useExport } from '../app/useExport'
import { OcrExportPrompt } from '../components/OcrExportPrompt'
import { makePageKey } from '../edit/model'
import type { EditLayer } from '../pdfx/build'
import { buildPdf } from '../pdfx/format'
import { defaultSettings } from '../../../shared/settings'
import type { DocEntry } from '../types'
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

vi.mock('../pdfx/format', () => ({
  buildPdf: vi.fn(async () => new Uint8Array([1])),
  buildPdfx: vi.fn(async () => new Uint8Array([2])),
  stripExtension: (name: string) => name.replace(/\.[^.]+$/, '')
}))
vi.mock('../pdfx/source', () => ({
  toExportPage: (p: { source: { id: string; bytes: Uint8Array }; pageIndex: number }) => ({
    sourceKey: p.source.id,
    bytes: p.source.bytes,
    pageIndex: p.pageIndex
  })
}))
vi.mock('../pdfx/redact-export', () => ({
  buildRedactedSources: vi.fn(async () => Object.assign(new Map(), { removed: new Map() })),
  applyRedactedBytes: <T>(pages: T[]) => pages
}))
vi.mock('../pdfx/signature-appearance', () => ({ withSignatureAppearance: vi.fn() }))
vi.mock('../pdfx/dss-info', () => ({ summarizeDss: vi.fn(), dssNote: () => '' }))
vi.mock('fflate', () => ({ zipSync: vi.fn(() => new Uint8Array([3])) }))
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
let chooseSavePath: ReturnType<typeof vi.fn>
let store: OcrStore
let port: FakeOcrPort

const s = source('scan')
const keys = [makePageKey(s.id, 0), makePageKey(s.id, 1)]
const docs: DocEntry[] = [doc('d', [pageOf(s, 0), pageOf(s, 1)])]
const layer: EditLayer = { overlays: new Map(), attachments: new Map() }

/** Wait for the store's (≤ 10 Hz) notifications and React to catch up. */
const tick = (ms = 150): Promise<void> =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })

beforeEach(async () => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  chooseSavePath = vi.fn(async (name: string) => `/out/${name}`)
  Object.defineProperty(window, 'api', {
    value: { chooseSavePath, writeFile: vi.fn(async (p: string) => p.split('/').pop()) },
    configurable: true,
    writable: true
  })
  port = new FakeOcrPort()
  const text = new FakeText(new Map(keys.map((k) => [k, nativeText(0)])))
  store = createOcrStore({
    port,
    text,
    getSettings: async () => defaultSettings('en'),
    idle: eagerIdle
  })
  // Two scanned pages, recognition running.
  store.reconcile(docs)
  await settle()
  const src = port.of('open')[0].src
  port.emit({ triaged: { src, pages: [triaged(0, 'scanned'), triaged(1, 'scanned')], done: true } })
  store.recognize(keys)
  await settle()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  store.dispose()
})

/** Mount useExport (with the store's export source) and the prompt, as App does. */
async function mount(busy: boolean[]): Promise<ReturnType<typeof useExport>> {
  let api: ReturnType<typeof useExport> | null = null
  const Harness = (): React.JSX.Element => {
    api = useExport(docs, layer, (b) => busy.push(b), vi.fn(), null, null, store.exportSource)
    return createElement(OcrExportPrompt, { store })
  }
  await act(async () => root.render(createElement(Harness)))
  return api!
}

const button = (label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label)

function answer(index: number, word: string): void {
  const r = port.recognizes()[0]
  port.emit({
    result: { jobId: r.jobId, src: r.src, index, page: okResult(recognisedPage([word])) }
  })
}

describe('export while recognition runs (real store)', () => {
  it('Wait and export: no dialog and no busy while waiting; the layer then has every page', async () => {
    const busy: boolean[] = []
    const api = await mount(busy)
    let done: Promise<void> = Promise.resolve()
    await act(async () => {
      done = api.exportCollection('pdf')
    })
    await tick()
    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Text recognition is still running (0 of 2 pages)')
    // The primary action has the focus (focus trap), and nothing else happened yet.
    expect(document.activeElement?.textContent).toBe('Wait and export')
    expect(chooseSavePath).not.toHaveBeenCalled()
    await act(async () => button('Wait and export')!.click())
    await tick()
    // Non-modal while waiting: a status card, no scrim.
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('0 of 2 pages')
    expect(busy).toEqual([])
    await act(async () => answer(0, 'first'))
    await tick()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('1 of 2 pages')
    expect(chooseSavePath).not.toHaveBeenCalled()
    await act(async () => {
      answer(1, 'second')
      await done
    })
    expect(chooseSavePath).toHaveBeenCalledTimes(1)
    expect(busy).toEqual([true, false])
    const built = vi.mocked(buildPdf).mock.calls[0][1]!
    expect([...(built.ocr?.keys() ?? [])].sort()).toEqual([...keys].sort())
    expect(built.ocr?.get(keys[1])?.text).toBe('second')
    await tick()
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('turning "Include recognized text" off while waiting: the export bakes none', async () => {
    const api = await mount([])
    let done: Promise<void> = Promise.resolve()
    await act(async () => {
      done = api.exportCollection('pdf')
    })
    await tick()
    await act(async () => button('Wait and export')!.click())
    await tick()
    // The waiting card is non-modal: the menu stays usable and the user switches the setting off.
    await act(async () => store.setSettings({ 'ocr.includeInExports': false }))
    await act(async () => {
      answer(0, 'first')
      answer(1, 'second')
      await done
    })
    expect(store.settings()['ocr.includeInExports']).toBe(false)
    const built = vi.mocked(buildPdf).mock.calls[0][1]!
    expect(built.ocr).toBeUndefined()
    expect(built.ocrPassthrough).toBe('drop')
  })

  it('Export now: the pages still running are left out', async () => {
    const api = await mount([])
    await act(async () => answer(0, 'ready'))
    let done: Promise<void> = Promise.resolve()
    await act(async () => {
      done = api.exportCollection('pdf')
    })
    await tick()
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('(1 of 2 pages)')
    await act(async () => {
      button('Export now')!.click()
      await done
    })
    const built = vi.mocked(buildPdf).mock.calls[0][1]!
    expect([...(built.ocr?.keys() ?? [])]).toEqual([keys[0]])
  })

  it('Cancel (button or Esc) exports nothing and leaves busy alone', async () => {
    const busy: boolean[] = []
    const api = await mount(busy)
    for (const how of ['button', 'escape'] as const) {
      let done: Promise<void> = Promise.resolve()
      await act(async () => {
        done = api.exportCollection('pdf')
      })
      await tick()
      const dialog = container.querySelector('[role="dialog"]')!
      await act(async () => {
        if (how === 'button') button('Cancel')!.click()
        else
          dialog.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
          )
        await done
      })
      await tick()
      expect(container.querySelector('[role="dialog"]')).toBeNull()
    }
    expect(chooseSavePath).not.toHaveBeenCalled()
    expect(buildPdf).not.toHaveBeenCalled()
    expect(busy).toEqual([])
  })

  it('Tab stays inside the prompt', async () => {
    const api = await mount([])
    await act(async () => {
      void api.exportCollection('pdf')
    })
    await tick()
    const dialog = container.querySelector('[role="dialog"]')!
    const tab = (shift: boolean): void => {
      dialog.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: shift,
          bubbles: true,
          cancelable: true
        })
      )
    }
    // Focus is on the last button (the primary): Tab wraps to the first, Shift+Tab back.
    await act(async () => tab(false))
    expect(document.activeElement?.textContent).toBe('Cancel')
    await act(async () => tab(true))
    expect(document.activeElement?.textContent).toBe('Wait and export')
    await act(async () => button('Cancel')!.click())
  })
})
