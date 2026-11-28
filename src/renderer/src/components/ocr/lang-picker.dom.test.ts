// The language picker's Included / Installed / Download groups, the download consent, progress,
// the offline wording, Install from file… and the summary's "Needs Russian language data
// [Download]" row (PR9, DESIGN.md §3.2.5, §3.8), over the REAL OCR store and the REAL renderer
// language-pack store, with a scripted `window.api.ocrLangs`. The invariant under test throughout:
// no download request is made before the user presses Download in the consent prompt.

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makePageKey } from '../../edit/model'
import { NULL_OCR_ACTIONS, OcrUiProvider } from '../../ocr/OcrContext'
import { createLangPacks, type LangPacksApi, type LangPacksStore } from '../../ocr/lang-packs'
import { createOcrStore, type OcrStore } from '../../ocr/ocr-store'
import { CJK_NOTE, INSTALL_REFUSED, consentCopy, offlineCopy } from '../../ocr/ocr-ui'
import {
  FakeOcrPort,
  FakeText,
  doc,
  eagerIdle,
  nativeText,
  pageOf,
  settle,
  source,
  triaged
} from '../../ocr/test-utils/fake-ocr'
import type {
  LangDownloadResult,
  LangInstallResult,
  LangPackInfo,
  LangProgress
} from '../../../../shared/ocr/lang-packs'
import { defaultSettings, type Settings } from '../../../../shared/settings'
import type { DocEntry } from '../../types'
import { OcrSummaryPopover } from './OcrSummaryPopover'
import { RecognizeDialog } from './RecognizeDialog'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const scan = source('scan')
const keys = [0, 1].map((i) => makePageKey(scan.id, i))
const docs: DocEntry[] = [doc('d1', [pageOf(scan, 0), pageOf(scan, 1)])]

const HOST = 'cdn.jsdelivr.net'
const lang = (
  code: string,
  name: string,
  nativeName: string,
  bytes: number,
  extra: Partial<LangPackInfo> = {}
): LangPackInfo => ({
  code,
  name,
  nativeName,
  script: 'Latn',
  bytes,
  host: HOST,
  state: 'available',
  ...extra
})

/** A scripted `window.api.ocrLangs`. Downloads stay open until the test finishes them. */
class FakeLangApi implements LangPacksApi {
  items: LangPackInfo[] = [
    lang('rus', 'Russian', 'Русский', 2_679_598, { script: 'Cyrl' }),
    lang('jpn', 'Japanese', '日本語', 2_030_256, { script: 'Jpan' }),
    lang('ita', 'Italian', 'Italiano', 1_660_998, { state: 'installed' }),
    lang('pol', 'Polish', 'Polski', 2_642_356)
  ]
  downloads: string[] = []
  cancels: string[] = []
  installs = 0
  installResult: LangInstallResult = { ok: false, error: 'unknown-file' }
  private finishers = new Map<string, (r: LangDownloadResult) => void>()
  private progressCb: ((p: LangProgress) => void) | null = null

  async list(): Promise<LangPackInfo[]> {
    return this.items.map((l) => ({ ...l }))
  }
  download(code: string): Promise<LangDownloadResult> {
    this.downloads.push(code)
    return new Promise((res) => this.finishers.set(code, res))
  }
  async cancel(code: string): Promise<void> {
    this.cancels.push(code)
    this.finish(code, { ok: false, error: 'cancelled' })
  }
  async installFromFile(): Promise<LangInstallResult> {
    this.installs++
    const r = this.installResult
    if (r.ok)
      this.items = this.items.map((l) => (l.code === r.code ? { ...l, state: 'installed' } : l))
    return r
  }
  onProgress(cb: (p: LangProgress) => void): () => void {
    this.progressCb = cb
    return () => (this.progressCb = null)
  }
  progress(p: LangProgress): void {
    this.progressCb?.(p)
  }
  finish(code: string, r: LangDownloadResult): void {
    if (r.ok)
      this.items = this.items.map((l) => (l.code === code ? { ...l, state: 'installed' } : l))
    this.finishers.get(code)?.(r)
    this.finishers.delete(code)
  }
}

let root: Root
let container: HTMLDivElement
let port: FakeOcrPort
let store: OcrStore
let api: FakeLangApi
let packs: LangPacksStore
let current: Settings

beforeEach(async () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  port = new FakeOcrPort()
  current = defaultSettings('en')
  store = createOcrStore({
    port,
    text: new FakeText(new Map(keys.map((k) => [k, nativeText(0)] as const))),
    getSettings: async () => current,
    setSettings: async (patch) => {
      current = { ...current, ...patch }
      return current
    },
    idle: eagerIdle,
    notifyMs: 0
  })
  store.reconcile(docs)
  await settle()
  const src = port.of('open')[0].src
  port.emit({ triaged: { src, pages: [0, 1].map((i) => triaged(i, 'scanned')), done: true } })
  await settle()
  api = new FakeLangApi()
  packs = createLangPacks(api)
  await settle()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  store.dispose()
  packs.dispose()
  vi.restoreAllMocks()
})

async function render(child: React.ReactElement): Promise<void> {
  await act(async () =>
    root.render(
      createElement(OcrUiProvider, {
        value: { store, supply: null, actions: NULL_OCR_ACTIONS, langs: packs },
        docs,
        children: child
      } as never)
    )
  )
  await act(async () => settle())
}

const openDialog = (): Promise<void> =>
  render(
    createElement(RecognizeDialog, {
      mode: 'recognize',
      focusDocId: 'd1',
      focusPageKey: keys[0],
      inFullView: true,
      docs,
      onClose: vi.fn()
    })
  )

const q = <T extends Element = HTMLElement>(sel: string): T | null =>
  container.querySelector<T>(sel)
const button = (t: string | RegExp): HTMLButtonElement | undefined =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    typeof t === 'string' ? b.textContent === t : t.test(b.textContent ?? '')
  )
const click = (el: Element | null | undefined): Promise<void> =>
  act(async () => {
    ;(el as HTMLElement).click()
    await settle()
  })
const type = (el: HTMLInputElement, value: string): Promise<void> =>
  act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  })

/** The picker's groups and their options' text, in order. */
function groups(): Array<[string, string[]]> {
  const out: Array<[string, string[]]> = []
  for (const el of q('.ocr-picker-list')?.children ?? []) {
    if (el.classList.contains('ocr-picker-group')) out.push([el.textContent!, []])
    else if (el.getAttribute('role') === 'option') out.at(-1)![1].push(el.textContent!)
  }
  return out
}

const chips = (): string[] =>
  [...container.querySelectorAll('.ocr-lang-chip')].map((c) => c.textContent!)

describe('the picker’s groups', () => {
  it('Included, Installed and Download, with native names, sizes, host and the CJK label', async () => {
    await openDialog()
    await click(button('+ Add language'))
    expect(groups()).toEqual([
      ['Included', ['Deutsch — German', 'Français — French', 'Español — Spanish']],
      ['Installed', ['Italiano — Italian']],
      [
        'Download',
        [
          `日本語 — Japanese ${CJK_NOTE}2.0 MB from ${HOST}`,
          `Polski — Polish2.6 MB from ${HOST}`,
          `Русский — Russian2.7 MB from ${HOST}`
        ]
      ]
    ])
    expect(button('Install from file…')).toBeDefined()
    expect(api.downloads).toEqual([])
  })

  it('search covers every group, by native or English name', async () => {
    await openDialog()
    await click(button('+ Add language'))
    const search = q<HTMLInputElement>('input[aria-label="Search languages"]')!
    await type(search, 'russ')
    expect(groups()).toEqual([['Download', [`Русский — Russian2.7 MB from ${HOST}`]]])
    await type(search, 'русс')
    expect(groups()).toEqual([['Download', [`Русский — Russian2.7 MB from ${HOST}`]]])
    await type(search, 'ital')
    expect(groups()).toEqual([['Installed', ['Italiano — Italian']]])
    await type(search, 'klingon')
    expect(groups()).toEqual([])
    expect(q('.ocr-picker-list')?.textContent).toBe('No other languages')
  })

  it('an installed language is added like an included one', async () => {
    await openDialog()
    await click(button('+ Add language'))
    await click(button('Italiano — Italian'))
    expect(chips()).toEqual(['English', 'Italiano — Italian'])
  })
})

describe('download consent', () => {
  it('asks first, in the design’s words; Cancel makes no request', async () => {
    await openDialog()
    await click(button('+ Add language'))
    await click(button(/Русский/))
    expect(q('.ocr-lang-prompt-text')?.textContent).toBe(
      'Download Russian language data (2.7 MB) from cdn.jsdelivr.net? It’s stored on this computer and used offline after that.'
    )
    expect(consentCopy({ name: 'Russian', bytes: 2_679_598, host: HOST })).toBe(
      q('.ocr-lang-prompt-text')?.textContent
    )
    expect(api.downloads).toEqual([])
    await click(button('Cancel'))
    expect(q('.ocr-lang-prompt')).toBeNull()
    expect(groups().map((g) => g[0])).toEqual(['Included', 'Installed', 'Download'])
    expect(api.downloads).toEqual([])
  })

  it('Download → progress → installed: the language becomes a chip', async () => {
    await openDialog()
    await click(button('+ Add language'))
    await click(button(/Русский/))
    await click(button('Download'))
    expect(api.downloads).toEqual(['rus'])
    await act(async () => {
      api.progress({ code: 'rus', received: 1_339_799, total: 2_679_598 })
      await settle()
    })
    expect(q('.ocr-lang-prompt [role="status"]')?.textContent).toBe(
      'Downloading Russian language data… 50%'
    )
    expect(q('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50')
    await act(async () => {
      api.finish('rus', { ok: true, code: 'rus' })
      await settle()
    })
    expect(chips()).toEqual(['English', 'Русский — Russian'])
    expect(q('.ocr-picker')).toBeNull()
    // The picker now lists it as installed.
    await click(button('+ Add language'))
    expect(
      groups()
        .find((g) => g[0] === 'Download')?.[1]
        .some((o) => o.includes('Русский'))
    ).toBe(false)
  })

  it('Stop cancels the download', async () => {
    await openDialog()
    await click(button('+ Add language'))
    await click(button(/Polski/))
    await click(button('Download'))
    await click(button('Stop'))
    expect(api.cancels).toEqual(['pol'])
    expect(chips()).toEqual(['English'])
  })

  it('offline: the design’s offline wording, before any request and after a failed one', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await openDialog()
    await click(button('+ Add language'))
    await click(button(/Русский/))
    expect(q('.ocr-lang-prompt-text')?.textContent).toBe(
      'Connect to the internet once to add Russian, or choose a language that’s already installed.'
    )
    expect(offlineCopy('Russian')).toBe(q('.ocr-lang-prompt-text')?.textContent)
    expect(api.downloads).toEqual([])
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    await click(button('Try anyway'))
    await act(async () => {
      api.finish('rus', { ok: false, error: 'offline' })
      await settle()
    })
    expect(q('.ocr-lang-prompt [role="alert"]')?.textContent).toBe(offlineCopy('Russian'))
    expect(button('Try again')).toBeDefined()
  })
})

describe('Install from file…', () => {
  it('a refused file says so in the design’s words; nothing is added', async () => {
    await openDialog()
    await click(button('+ Add language'))
    await click(button('Install from file…'))
    expect(api.installs).toBe(1)
    expect(q('.ocr-picker-footer [role="status"]')?.textContent).toBe(INSTALL_REFUSED)
    expect(INSTALL_REFUSED).toBe(
      'This file isn’t one of the language files PDFx knows. PDFx 1.1.4 only installs its own language files.'
    )
    expect(chips()).toEqual(['English'])
  })

  it('an accepted file adds its language', async () => {
    api.installResult = { ok: true, code: 'pol' }
    await openDialog()
    await click(button('+ Add language'))
    await click(button('Install from file…'))
    expect(chips()).toEqual(['English', 'Polski — Polish'])
    expect(api.downloads).toEqual([])
  })
})

describe('summary: "Needs Russian language data [Download]"', () => {
  it('names the language, asks, downloads, then recognises the pages again with their languages', async () => {
    // Recognition asked for English + Russian, which is not installed: needs-language.
    store.recognize(keys, { langs: ['eng', 'rus'] })
    await settle()
    const r = port.recognizes().at(-1)!
    for (const i of [0, 1])
      port.emit({
        result: {
          jobId: r.jobId,
          src: r.src,
          index: i,
          page: { status: 'needs-language', renderDpi: null, raster: null, recognition: null }
        }
      })
    port.emit({ jobDone: { jobId: r.jobId, done: 2, failed: 0, cancelled: false } })
    await settle()
    await render(createElement(OcrSummaryPopover, { anchor: null, docId: 'd1', onClose: vi.fn() }))
    const rows = [...document.querySelectorAll('.ocr-summary-text')].map((e) => e.textContent)
    expect(rows).toEqual(['Needs Russian language data', 'Needs Russian language data'])
    const before = port.recognizes().length
    await act(async () => {
      ;[...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent === 'Download')!
        .click()
      await settle()
    })
    expect(document.querySelector('.ocr-lang-prompt-text')?.textContent).toBe(
      consentCopy({ name: 'Russian', bytes: 2_679_598, host: HOST })
    )
    expect(api.downloads).toEqual([])
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.ocr-lang-prompt .primary')!.click()
      await settle()
    })
    expect(api.downloads).toEqual(['rus'])
    await act(async () => {
      api.finish('rus', { ok: true, code: 'rus' })
      await settle()
    })
    const again = port.recognizes().slice(before)
    expect(again).toHaveLength(1)
    expect(again[0].opts.langs).toEqual(['eng', 'rus'])
    expect(again[0].pages.map((p) => p.index).sort()).toEqual([0, 1])
  })
})
