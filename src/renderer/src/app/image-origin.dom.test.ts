// The image-origin marker reaches PdfSource.origin through EVERY import path (DESIGN.md §3.4.1):
// imageToPdf writes it and loadSource reads it, so no call site carries a flag. Each path runs
// for real here — the hooks and the drop helper with the real converters, imageToPdf, pdf-lib and
// pdf.js (its Node build, in-process worker) — and the pages they hand the collection must say
// `origin: 'image'`; a PDF opened the same way must not.

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PDFDocument } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// pdf.js's worker in-process (its "fake worker" picks up globalThis.pdfjsWorker).
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'

import { useImport } from './useImport'
import { usePaste } from './usePaste'
import type { Collection } from './useCollection'
import type { DocEntry, PageEntry } from '../types'
import type { IncomingFile } from './types'

// The renderer imports the browser build; under Node the legacy build is pdf.js's supported entry.
vi.mock('pdfjs-dist', async () => await import('pdfjs-dist/legacy/build/pdf.mjs'))
// No asset URLs needed: these pages hold one Flate image and no fonts.
vi.mock('../pdfx/pdfjs-assets', () => ({ rendererPdfjsAssetOptions: () => ({}) }))
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A real opaque 1×1 PNG (the embed path's smallest valid input).
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  ),
  (c) => c.charCodeAt(0)
)

let root: Root
let container: HTMLDivElement
let plainPdf: Uint8Array

beforeEach(async () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const doc = await PDFDocument.create()
  doc.addPage([200, 300])
  plainPdf = await doc.save()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

/** A one-page document whose page is a 200 × 300 pt reference (the neighbour images fit to). */
function existingDoc(): DocEntry {
  return {
    id: 'd1',
    name: 'existing',
    pages: [
      {
        id: 'p1',
        source: { id: 'src-1', bytes: plainPdf, pdf: null as never },
        pageIndex: 0,
        width: 200,
        height: 300
      }
    ]
  }
}

interface Captured {
  /** Every page handed to the collection, by the method that got it. */
  pages: Array<{ via: string; page: PageEntry }>
  collection: Collection
}

function fakeCollection(
  docs: DocEntry[],
  selected: { docId: string; pageId: string } | null
): Captured {
  const pages: Captured['pages'] = []
  const take = (via: string, list: PageEntry[]): void => {
    for (const page of list) pages.push({ via, page })
  }
  const collection = {
    docs,
    docsRef: { current: docs },
    selected,
    setDocs: vi.fn((update: (prev: DocEntry[]) => DocEntry[]) => {
      for (const d of update([])) take('setDocs', d.pages)
    }),
    appendPagesToDoc: vi.fn((_id: string, list: PageEntry[]) => take('appendPagesToDoc', list)),
    insertPagesIntoDoc: vi.fn((_id: string, _i: number, list: PageEntry[]) =>
      take('insertPagesIntoDoc', list)
    ),
    insertPagesAfter: vi.fn((_t: unknown, list: PageEntry[]) => take('insertPagesAfter', list)),
    spliceDocsAfter: vi.fn((_a: string | null, list: DocEntry[]) => {
      for (const d of list) take('spliceDocsAfter', d.pages)
    }),
    pasteAfterSelected: vi.fn()
  } as unknown as Collection
  return { pages, collection }
}

function stubApi(over: Record<string, unknown> = {}): void {
  Object.defineProperty(window, 'api', {
    value: {
      onFilesOpened: () => () => {},
      rendererReady: async () => {},
      confirmIntegrity: async () => 0,
      openFiles: async () => [],
      readClipboardFiles: async () => [],
      readClipboardImage: async () => null,
      ...over
    },
    configurable: true,
    writable: true
  })
}

async function mountImport(c: Collection): Promise<ReturnType<typeof useImport>> {
  let api: ReturnType<typeof useImport> | null = null
  const Harness = (): null => {
    api = useImport(c, vi.fn(), vi.fn(), vi.fn())
    return null
  }
  await act(async () => root.render(createElement(Harness)))
  return api!
}

async function mountPaste(c: Collection, addFiles: (f: IncomingFile[]) => Promise<void>) {
  let handle: (() => Promise<void>) | null = null
  const Harness = (): null => {
    handle = usePaste(c, addFiles, vi.fn(), vi.fn()).handlePaste
    return null
  }
  await act(async () => root.render(createElement(Harness)))
  return handle!
}

const origins = (c: Captured): Array<[string, string | undefined]> =>
  c.pages.map(({ via, page }) => [via, page.source.origin])

describe('every import path carries the image-origin marker', () => {
  it('addFiles (open / onFilesOpened): the image converter, and a PDF control', async () => {
    stubApi()
    const c = fakeCollection([], null)
    const { addFiles } = await mountImport(c.collection)
    await act(async () => {
      await addFiles([
        { name: 'photo.png', data: PNG },
        { name: 'plain.pdf', data: plainPdf }
      ])
    })
    expect(origins(c)).toEqual([
      ['setDocs', 'image'],
      ['setDocs', undefined]
    ])
  })

  it('addPagesToDoc (append): fitted to the last page, still marked', async () => {
    stubApi({ openFiles: async () => [{ name: 'photo.png', data: PNG }] })
    const c = fakeCollection([existingDoc()], null)
    const { addPagesToDoc } = await mountImport(c.collection)
    await act(async () => addPagesToDoc('d1'))
    expect(origins(c)).toEqual([['appendPagesToDoc', 'image']])
    // Fitted to the 200 × 300 pt reference, not 1 px = 1 pt.
    expect(c.pages[0].page).toMatchObject({ width: 200, height: 300 })
  })

  it('paste: clipboard files next to the selected page', async () => {
    stubApi({ readClipboardFiles: async () => [{ name: 'photo.png', data: PNG }] })
    const c = fakeCollection([existingDoc()], { docId: 'd1', pageId: 'p1' })
    const paste = await mountPaste(c.collection, vi.fn())
    await act(async () => paste())
    expect(origins(c)).toEqual([['insertPagesAfter', 'image']])
  })

  it('paste: a clipboard image next to the selected page', async () => {
    stubApi({ readClipboardImage: async () => PNG })
    const c = fakeCollection([existingDoc()], { docId: 'd1', pageId: 'p1' })
    const paste = await mountPaste(c.collection, vi.fn())
    await act(async () => paste())
    expect(origins(c)).toEqual([['insertPagesAfter', 'image']])
    expect(c.pages[0].page).toMatchObject({ width: 200, height: 300 })
  })

  it('paste: a clipboard image with nothing selected (a new document, 1 px = 1 pt)', async () => {
    stubApi({ readClipboardImage: async () => PNG })
    const c = fakeCollection([], null)
    const paste = await mountPaste(c.collection, vi.fn())
    await act(async () => paste())
    expect(origins(c)).toEqual([['setDocs', 'image']])
    expect(c.pages[0].page).toMatchObject({ width: 1, height: 1 })
  })

  it('drop: into a document (fitted) and between documents (new docs)', async () => {
    stubApi()
    const c = fakeCollection([existingDoc()], null)
    const { handleExternalDropFiles } = await mountImport(c.collection)
    await act(async () =>
      handleExternalDropFiles([{ name: 'photo.png', data: PNG }], {
        kind: 'into',
        docId: 'd1',
        index: 1
      } as never)
    )
    await act(async () =>
      handleExternalDropFiles(
        [
          { name: 'a.png', data: PNG },
          { name: 'b.pdf', data: plainPdf }
        ],
        { kind: 'between', docIndex: 1 } as never
      )
    )
    expect(origins(c)).toEqual([
      ['insertPagesIntoDoc', 'image'],
      ['spliceDocsAfter', 'image'],
      ['spliceDocsAfter', undefined]
    ])
  })
})
