// The Recognize Text… / Replace Recognized Text… dialog (DESIGN.md §3.8 "Dialog", "Language
// picker") over the REAL store: scopes and counts, language chips and picker, the settings it saves
// (only on Recognize), the copy (privacy, D7, D8, signed sources), and the modal keyboard path.

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makePageKey } from '../../edit/model'
import { NULL_OCR_ACTIONS, OcrUiProvider } from '../../ocr/OcrContext'
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
import { defaultSettings, type Settings } from '../../../../shared/settings'
import type { DocEntry } from '../../types'
import {
  DIALOG_COPY,
  RecognizeDialog,
  tabStops,
  type RecognizeDialogProps
} from './RecognizeDialog'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const scan = source('scan')
const other = source('other', { bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7]) })
const keys = [0, 1, 2].map((i) => makePageKey(scan.id, i))
const otherKey = makePageKey(other.id, 0)
const docs: DocEntry[] = [
  doc('d1', [pageOf(scan, 0), pageOf(scan, 1), pageOf(scan, 2)]),
  doc('d2', [pageOf(other, 0)])
]

let root: Root
let container: HTMLDivElement
let port: FakeOcrPort
let store: OcrStore
let saved: Array<Partial<Settings>>

beforeEach(async () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  port = new FakeOcrPort()
  saved = []
  let current = defaultSettings('en')
  store = createOcrStore({
    port,
    text: new FakeText(new Map([...keys, otherKey].map((k) => [k, nativeText(0)] as const))),
    getSettings: async () => current,
    setSettings: async (patch) => {
      saved.push(patch)
      current = { ...current, ...patch }
      return current
    },
    idle: eagerIdle,
    notifyMs: 0
  })
  store.reconcile(docs)
  await settle()
  for (const o of port.of('open')) {
    const n = o.bytes.length === 7 ? 1 : 3
    port.emit({
      triaged: {
        src: o.src,
        pages: [...Array(n).keys()].map((i) => triaged(i, 'scanned')),
        done: true
      }
    })
  }
  await settle()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  store.dispose()
})

async function open(props: Partial<RecognizeDialogProps> = {}): Promise<RecognizeDialogProps> {
  const all: RecognizeDialogProps = {
    mode: 'recognize',
    focusDocId: 'd1',
    focusPageKey: keys[1],
    inFullView: true,
    docs,
    onClose: vi.fn(),
    ...props
  }
  await act(async () =>
    root.render(
      createElement(OcrUiProvider, {
        value: { store, supply: null, actions: NULL_OCR_ACTIONS },
        docs,
        children: createElement(RecognizeDialog, all)
      } as never)
    )
  )
  await act(async () => settle())
  return all
}

const dialog = (): HTMLElement => container.querySelector<HTMLElement>('[role="dialog"]')!
const button = (t: string | RegExp): HTMLButtonElement | undefined =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    typeof t === 'string' ? b.textContent === t : t.test(b.textContent ?? '')
  )
const radios = (): string[] =>
  [...container.querySelectorAll('input[type="radio"]')].map((r) => r.parentElement!.textContent!)
const checked = (label: string): boolean =>
  [...container.querySelectorAll('label')]
    .find((l) => l.textContent?.startsWith(label))!
    .querySelector('input')!.checked
const key = (el: Element, k: string, extra: KeyboardEventInit = {}): Promise<void> =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }))
  })

describe('RecognizeDialog', () => {
  it('asks the store to triage the collection when it opens (Stage 0 gate b)', async () => {
    const prepare = vi.spyOn(store, 'prepare')
    await open()
    expect(prepare).toHaveBeenCalledWith([...keys, otherKey])
  })

  it('offers the scopes with their counts, the page in view, and "Recognize 3 pages"', async () => {
    await open()
    expect(dialog().getAttribute('aria-modal')).toBe('true')
    expect(dialog().querySelector('h2')?.textContent).toBe('Recognize Text')
    expect(radios()).toEqual([
      'Scanned pages in this document (3)',
      'Scanned pages in all documents (4)',
      'This page'
    ])
    expect(button(/^Recognize \d/)?.textContent).toBe('Recognize 3 pages')
    // The primary button has the focus.
    expect(document.activeElement?.textContent).toBe('Recognize 3 pages')
    await act(async () =>
      (container.querySelectorAll('input[type="radio"]')[2] as HTMLElement).click()
    )
    expect(button(/^Recognize \d/)?.textContent).toBe('Recognize 1 page')
  })

  it('says "Selected page" in the collection', async () => {
    await open({ inFullView: false })
    expect(radios()[2]).toBe('Selected page')
  })

  it('has the final copy: languages hint, privacy, layer, D7 and D8', async () => {
    await open()
    const t = dialog().textContent!
    for (const s of [
      'Pick every language on these pages. Fewer is faster.',
      'Recognize imported photos automatically',
      'Recognize scanned pages when I open PDFs',
      'Runs on this computer. Nothing is uploaded.',
      'The page images are not changed; an invisible text layer is added when you export.',
      'Include recognized text when exporting',
      'Recognition is kept while the file is open. Export or save as .pdfx to keep it.'
    ])
      expect(t).toContain(s)
    // The remembered settings: imports on, opened PDFs off, exports on (D4, D7).
    expect(checked(DIALOG_COPY.autoImports)).toBe(true)
    expect(checked(DIALOG_COPY.autoOpened)).toBe(false)
    expect(checked(DIALOG_COPY.include)).toBe(true)
    expect(t).not.toContain('digital signature')
  })

  it('offers no orientation box the engine would ignore (it always reads the page upright)', async () => {
    await open()
    expect(dialog().textContent).not.toContain('Fix page orientation')
    expect(dialog().textContent).not.toContain('never changes how the page looks')
    await act(async () => button('Recognize 3 pages')!.click())
    await act(async () => settle())
    expect(saved).toHaveLength(1)
    expect(saved[0]).not.toHaveProperty('ocr.fixOrientation')
  })

  it('shows the signed-source note when a source carries a signature', async () => {
    const signed = source('signed', {
      bytes: new TextEncoder().encode('%PDF-1.7 << /Type /Sig /ByteRange [0 1 2 3] >>')
    })
    await open({ docs: [...docs, doc('d3', [pageOf(signed, 0)])] })
    expect(dialog().textContent).toContain(
      'Exporting creates a new file; the source’s digital signature won’t be valid in it. You can sign the new copy with Sign.'
    )
  })

  it('languages: chips, a searchable picker with the Included group, at most 3', async () => {
    await open()
    expect(container.querySelector('.ocr-lang-chip')?.textContent).toBe('English')
    // The only language cannot be removed.
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Remove English"]')!.disabled
    ).toBe(true)
    await act(async () => button('+ Add language')!.click())
    const picker = container.querySelector('.ocr-picker')!
    expect(picker.querySelector('.ocr-picker-group')?.textContent).toBe('Included')
    expect([...picker.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual([
      'Deutsch — German',
      'Français — French',
      'Español — Spanish'
    ])
    const search = picker.querySelector('input')!
    expect(document.activeElement).toBe(search)
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(search, 'germ')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect([...picker.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual([
      'Deutsch — German'
    ])
    await key(search, 'Enter')
    expect([...container.querySelectorAll('.ocr-lang-chip')].map((c) => c.textContent)).toEqual([
      'English',
      'Deutsch — German'
    ])
    await act(async () => button('+ Add language')!.click())
    await act(async () => button('Español — Spanish')!.click())
    // Three is the limit: no more "+ Add language".
    expect(button('+ Add language')).toBeUndefined()
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Remove English"]')!.click()
    )
    expect([...container.querySelectorAll('.ocr-lang-chip')].map((c) => c.textContent)).toEqual([
      'Deutsch — German',
      'Español — Spanish'
    ])
  })

  it('Recognize saves the settings and recognises the scope with the chosen languages', async () => {
    const recognize = vi.spyOn(store, 'recognize')
    const props = await open()
    await act(async () => button('+ Add language')!.click())
    await act(async () => button('Français — French')!.click())
    const include = [...container.querySelectorAll('label')]
      .find((l) => l.textContent === DIALOG_COPY.include)!
      .querySelector('input')!
    await act(async () => include.click())
    await act(async () => button('Recognize 3 pages')!.click())
    await act(async () => settle())
    expect(saved).toEqual([
      {
        'ocr.languages': ['eng', 'fra'],
        'ocr.autoRecognizeImports': true,
        'ocr.autoRecognizeOpened': false,
        'ocr.includeInExports': false
      }
    ])
    expect(recognize).toHaveBeenCalledWith(keys, { langs: ['eng', 'fra'] })
    expect(props.onClose).toHaveBeenCalled()
    expect(store.settings()['ocr.includeInExports']).toBe(false)
  })

  it('Cancel, Esc and a click outside close it without saving anything', async () => {
    const props = await open()
    await act(async () => button('Cancel')!.click())
    await key(dialog(), 'Escape')
    await act(async () => {
      container
        .querySelector('.sign-overlay')!
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(props.onClose).toHaveBeenCalledTimes(3)
    expect(saved).toEqual([])
  })

  it('traps Tab inside, and keys never reach window shortcuts', async () => {
    const onWindowKey = vi.fn()
    window.addEventListener('keydown', onWindowKey)
    await open()
    const focusables = tabStops(dialog())
    expect(focusables[0]).toBe(container.querySelector('input[type="radio"]:checked'))
    expect(focusables[focusables.length - 1].textContent).toBe('Recognize 3 pages')
    focusables[focusables.length - 1].focus()
    await key(document.activeElement!, 'Tab')
    expect(document.activeElement).toBe(focusables[0])
    await key(document.activeElement!, 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe(focusables[focusables.length - 1])
    await key(document.activeElement!, 'Delete')
    expect(onWindowKey).not.toHaveBeenCalled()
    window.removeEventListener('keydown', onWindowKey)
  })

  it('Esc in the language picker closes the picker only, and focus goes to "+ Add language"', async () => {
    const props = await open()
    await act(async () => button('+ Add language')!.click())
    const search = container.querySelector<HTMLInputElement>('.ocr-picker input')!
    expect(document.activeElement).toBe(search)
    await key(search, 'Escape')
    expect(container.querySelector('.ocr-picker')).toBeNull()
    expect(dialog()).not.toBeNull()
    expect(props.onClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(button('+ Add language'))
    // A second Esc closes the dialog.
    await key(document.activeElement!, 'Escape')
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('focus never falls to <body> when the picker or a chip unmounts', async () => {
    const onWindowKey = vi.fn()
    window.addEventListener('keydown', onWindowKey)
    try {
      await open()
      // Choosing a language (Enter in the search) closes the picker: "+ Add language" gets focus.
      await act(async () => button('+ Add language')!.click())
      await key(container.querySelector('.ocr-picker input')!, 'Enter')
      expect(document.activeElement).toBe(button('+ Add language'))
      // Clicking an option (mouse or keyboard) closes it too; with three languages the "+ Add
      // language" button is gone, so the last chip's ✕ gets it.
      await act(async () => button('+ Add language')!.click())
      await act(async () => button('Français — French')!.click())
      expect(button('+ Add language')).toBeUndefined()
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Remove Français — French')
      // Removing a chip: the chip that takes its place.
      const x = container.querySelector<HTMLButtonElement>('[aria-label="Remove English"]')!
      x.focus()
      await act(async () => x.click())
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Remove Deutsch — German')
      expect(document.activeElement).not.toBe(document.body)
      await key(document.activeElement!, 'Delete')
      expect(onWindowKey).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', onWindowKey)
    }
  })

  it('a key that still lands outside the box is the dialog’s: Delete never reaches the app, Esc closes', async () => {
    const onWindowKey = vi.fn()
    window.addEventListener('keydown', onWindowKey)
    try {
      const props = await open()
      ;(document.activeElement as HTMLElement).blur()
      expect(document.activeElement).toBe(document.body)
      await key(document.body, 'Delete')
      await key(document.body, 'Backspace')
      expect(onWindowKey).not.toHaveBeenCalled()
      // Tab from outside comes back in.
      await key(document.body, 'Tab')
      expect(dialog().contains(document.activeElement)).toBe(true)
      ;(document.activeElement as HTMLElement).blur()
      await key(document.body, 'Escape')
      expect(props.onClose).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', onWindowKey)
    }
  })

  it('focus moved to the app behind is pulled back into the box', async () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    try {
      await open()
      await act(async () => outside.focus())
      expect(dialog().contains(document.activeElement)).toBe(true)
    } finally {
      outside.remove()
    }
  })

  it('Shift+Tab from the checked radio wraps when it is not the first radio (radio group = one stop)', async () => {
    await open()
    const rs = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
    await act(async () => rs[1].click()) // "all documents": not the first radio
    rs[1].focus()
    // The stops in document order, one per radio group: the checked radio is the first stop.
    const stops = tabStops(dialog())
    expect(stops[0]).toBe(rs[1])
    expect(stops.filter((s) => s instanceof HTMLInputElement && s.type === 'radio')).toEqual([
      rs[1]
    ])
    expect(stops[stops.length - 1].textContent).toBe('Recognize 4 pages')
    await key(rs[1], 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe(stops[stops.length - 1]) // wrapped to the last stop
    // And Tab from the last comes back to the checked radio, not the first radio.
    await key(document.activeElement!, 'Tab')
    expect(document.activeElement).toBe(rs[1])
  })

  it('offers only scopes with pages, and no page scope once the page has left', async () => {
    // d2's only page is recognised: "this document (0)" is not offered.
    store.recognize([otherKey])
    await settle()
    const r = port.recognizes().at(-1)!
    port.emit({
      result: { jobId: r.jobId, src: r.src, index: 0, page: okResult(recognisedPage(['x'])) }
    })
    await settle()
    await open({ focusDocId: 'd2', focusPageKey: otherKey, inFullView: false })
    expect(radios()).toEqual(['Scanned pages in all documents (3)', 'Selected page'])
    // The selected page is deleted behind the dialog: its scope goes with it.
    await open({ focusDocId: 'd2', focusPageKey: 'gone#0', inFullView: false })
    expect(radios()).toEqual(['Scanned pages in all documents (3)'])
  })

  it('closing after its opener is gone puts focus on the activity pill, not <body>', async () => {
    const opener = document.createElement('button')
    const pill = document.createElement('button')
    pill.className = 'ocr-pill'
    document.body.append(opener, pill)
    try {
      opener.focus()
      await open()
      opener.remove()
      await act(async () => root.render(null))
      expect(document.activeElement).toBe(pill)
    } finally {
      pill.remove()
    }
  })

  it('Replace mode for fixed pages: "Replace text on 1 page" records the choice and re-recognises', async () => {
    const replace = vi.spyOn(store, 'replace')
    const props = await open({ mode: 'replace', fixedKeys: [keys[0]] })
    expect(dialog().querySelector('h2')?.textContent).toBe('Replace Recognized Text')
    expect(radios()).toEqual(['This page'])
    await act(async () => button('Replace text on 1 page')!.click())
    await act(async () => settle())
    expect(replace).toHaveBeenCalledWith([keys[0]], ['eng'])
    expect(props.onClose).toHaveBeenCalled()
  })
})
