import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePaste } from './usePaste'
import { imageToPdf } from '../pdfx/images'
import { importIntoDocs } from '../pdfx/source'
import type { Collection } from './useCollection'

vi.mock('../pdfx/images', () => ({ imageToPdf: vi.fn() }))
vi.mock('../pdfx/source', () => ({
  importIntoDocs: vi.fn(),
  loadIncomingPages: vi.fn(),
  loadSource: vi.fn(),
  pagesFromSource: vi.fn()
}))
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

/** An empty collection with nothing selected, so the paste takes the "new document" branch. */
const emptyCollection = () =>
  ({
    docs: [],
    selected: null,
    setDocs: vi.fn(),
    insertPagesAfter: vi.fn(),
    pasteAfterSelected: vi.fn()
  }) as unknown as Collection

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  Object.defineProperty(window, 'api', {
    value: {
      readClipboardFiles: vi.fn(async () => []),
      readClipboardImage: vi.fn(async () => PNG)
    },
    configurable: true,
    writable: true
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

/** Mount usePaste in a throwaway component and hand back its handlePaste. */
async function mountPaste(
  setBusy: (busy: boolean) => void,
  flash: (message: string) => void
): Promise<() => Promise<void>> {
  let captured: (() => Promise<void>) | null = null
  const Harness = (): null => {
    captured = usePaste(
      emptyCollection(),
      vi.fn(async () => {}),
      setBusy,
      flash
    ).handlePaste
    return null
  }
  await act(async () => {
    root.render(createElement(Harness))
  })
  if (!captured) throw new Error('handlePaste was never produced')
  return captured
}

describe('pasteImage holds `busy` like its pasteFiles sibling', () => {
  it('raises and clears busy around a clipboard-image paste', async () => {
    const busyCalls: boolean[] = []
    vi.mocked(imageToPdf).mockResolvedValue(new Uint8Array([1]))
    vi.mocked(importIntoDocs).mockResolvedValue({
      docs: [],
      mirror: null,
      integrity: { tampered: false, changedPages: [] }
    })

    const handlePaste = await mountPaste((b) => busyCalls.push(b), vi.fn())
    await act(async () => {
      await handlePaste()
    })

    expect(importIntoDocs).toHaveBeenCalled()
    // Not just "busy was touched": it must go up before the work and come back down after.
    expect(busyCalls).toEqual([true, false])
  })

  it('still clears busy when the image paste fails', async () => {
    const busyCalls: boolean[] = []
    const flash = vi.fn()
    vi.mocked(imageToPdf).mockRejectedValue(new Error('bad png'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const handlePaste = await mountPaste((b) => busyCalls.push(b), flash)
    await act(async () => {
      await handlePaste()
    })

    expect(flash).toHaveBeenCalledWith('Could not paste image')
    expect(busyCalls).toEqual([true, false])
    consoleError.mockRestore()
  })
})
