import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useExport } from './useExport'
import { makePageKey, type Overlay } from '../edit/model'
import type { EditLayer } from '../pdfx/build'
import type { DocEntry, PageEntry } from '../types'

// Everything past the hook's own wiring is a boundary: assembly (buildPdf/buildPdfx), the WASM
// redaction pre-pass, zipping and the main-process file dialog. mirror.ts stays REAL — the whole
// point of the flash suffix is that its number comes from the function that does the dropping.
vi.mock('../pdfx/format', () => ({
  buildPdf: vi.fn(async () => new Uint8Array([1])),
  buildPdfx: vi.fn(async () => new Uint8Array([2])),
  stripExtension: (name: string) => name.replace(/\.[^.]+$/, '')
}))
// source.ts pulls in pdf.js, which needs DOMMatrix; only the page→export-ref mapping matters here.
vi.mock('../pdfx/source', () => ({
  toExportPage: (p: PageEntry) => ({
    sourceKey: p.source.id,
    bytes: p.source.bytes,
    pageIndex: p.pageIndex
  })
}))
vi.mock('../pdfx/redact-export', () => ({
  buildRedactedSources: vi.fn(async () => new Map()),
  applyRedactedBytes: <T>(pages: T[]) => pages
}))
vi.mock('../pdfx/signature-appearance', () => ({ withSignatureAppearance: vi.fn() }))
vi.mock('../pdfx/dss-info', () => ({ summarizeDss: vi.fn(), dssNote: () => '' }))
vi.mock('fflate', () => ({ zipSync: vi.fn(() => new Uint8Array([3])) }))
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KEY = makePageKey('s1', 0)

const page = (): PageEntry => ({
  id: 'p1',
  source: { id: 's1', bytes: new Uint8Array([0]), pdf: null as never },
  pageIndex: 0,
  width: 612,
  height: 792
})
const oneDoc = (): DocEntry[] => [{ id: 'd1', name: 'A', pages: [page()] }]

const geom = (x: number, y: number, w: number, h: number): Overlay['geom'] => ({
  x,
  y,
  w,
  h,
  rotation: 0,
  opacity: 1
})
const highlight = (z: number, g: Overlay['geom']): Overlay => ({
  id: `h-${z}`,
  pageKey: KEY,
  z,
  createdAt: z,
  geom: g,
  type: 'highlight',
  color: { r: 1, g: 1, b: 0 }
})
const redaction = (z: number): Overlay => ({
  id: `r-${z}`,
  pageKey: KEY,
  z,
  createdAt: z,
  geom: geom(0, 0, 100, 100),
  type: 'redaction',
  fill: { r: 0, g: 0, b: 0 }
})
const layer = (overlays: Overlay[] = []): EditLayer => ({
  overlays: overlays.length ? new Map([[KEY, overlays]]) : new Map(),
  attachments: new Map(),
  rotations: new Map(),
  crops: new Map()
})

let root: Root
let container: HTMLDivElement
let chooseSavePath: ReturnType<typeof vi.fn>
let writeFile: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  chooseSavePath = vi.fn(async (defaultName: string) => `/out/${defaultName}`)
  writeFile = vi.fn(async (path: string) => path.split('/').pop())
  Object.defineProperty(window, 'api', {
    value: { chooseSavePath, writeFile },
    configurable: true,
    writable: true
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

interface Exports {
  exportCollection: (kind: 'pdfx' | 'pdf') => Promise<void>
  exportZip: () => Promise<void>
}

/** Mount useExport in a throwaway component and hand back the two save entry points. */
async function mountExport(
  docs: DocEntry[],
  edits: EditLayer,
  setBusy: (busy: boolean) => void,
  flash: (message: string) => void
): Promise<Exports> {
  let captured: Exports | null = null
  const Harness = (): null => {
    const api = useExport(docs, edits, setBusy, flash, null, null)
    captured = { exportCollection: api.exportCollection, exportZip: api.exportZip }
    return null
  }
  await act(async () => {
    root.render(createElement(Harness))
  })
  if (!captured) throw new Error('useExport never produced its handles')
  return captured
}

/** A page carrying one highlight under a redaction and, optionally, more of the same. */
const covered = (n: number): Overlay[] => [
  ...Array.from({ length: n }, (_, i) => highlight(i, geom(10 + i, 10, 20, 20))),
  redaction(n)
]

describe('save flash reports the annotations a redaction removed', () => {
  it('names the single removed annotation on the .pdfx path', async () => {
    const flash = vi.fn()
    const { exportCollection } = await mountExport(oneDoc(), layer(covered(1)), vi.fn(), flash)
    await act(async () => {
      await exportCollection('pdfx')
    })
    expect(flash).toHaveBeenCalledWith(
      'Saved untitled.pdfx · 1 annotation under a redaction was removed'
    )
  })

  it('pluralises on the flat-PDF path', async () => {
    const flash = vi.fn()
    const { exportCollection } = await mountExport(oneDoc(), layer(covered(2)), vi.fn(), flash)
    await act(async () => {
      await exportCollection('pdf')
    })
    expect(flash).toHaveBeenCalledWith(
      'Saved untitled.pdf · 2 annotations under a redaction were removed'
    )
  })

  it('reports on the zip path too', async () => {
    const flash = vi.fn()
    const { exportZip } = await mountExport(oneDoc(), layer(covered(2)), vi.fn(), flash)
    await act(async () => {
      await exportZip()
    })
    expect(flash).toHaveBeenCalledWith(
      'Saved untitled.zip · 2 annotations under a redaction were removed'
    )
  })

  it('says nothing extra when no annotation was covered', async () => {
    const flash = vi.fn()
    // A highlight far from the box, plus one painted ON TOP of it: neither is dropped.
    const untouched = [highlight(0, geom(300, 300, 20, 20)), redaction(1), highlight(2, geom(10, 10, 20, 20))] // prettier-ignore
    const { exportCollection, exportZip } = await mountExport(
      oneDoc(),
      layer(untouched),
      vi.fn(),
      flash
    )
    await act(async () => {
      await exportCollection('pdfx')
      await exportZip()
    })
    expect(flash.mock.calls).toEqual([['Saved untitled.pdfx'], ['Saved untitled.zip']])
  })
})

// The three paths run through one shell; these are the invariants App depends on from all of them.
describe('every save path shares the same shell', () => {
  const paths: Array<[string, (e: Exports) => Promise<void>]> = [
    ['pdfx', (e) => e.exportCollection('pdfx')],
    ['pdf', (e) => e.exportCollection('pdf')],
    ['zip', (e) => e.exportZip()]
  ]

  it.each(paths)('%s: raises and clears busy exactly once around the work', async (_name, run) => {
    const busy: boolean[] = []
    const handles = await mountExport(oneDoc(), layer(), (b) => busy.push(b), vi.fn())
    await act(async () => {
      await run(handles)
    })
    expect(busy).toEqual([true, false])
  })

  it.each(paths)(
    '%s: flashes "Nothing to export" and opens no dialog when empty',
    async (_n, run) => {
      const flash = vi.fn()
      const busy: boolean[] = []
      const handles = await mountExport([], layer(), (b) => busy.push(b), flash)
      await act(async () => {
        await run(handles)
      })
      expect(flash).toHaveBeenCalledWith('Nothing to export')
      expect(chooseSavePath).not.toHaveBeenCalled()
      expect(busy).toEqual([]) // never entered, so never cleared
    }
  )

  it.each(paths)('%s: a cancelled dialog writes nothing and leaves busy alone', async (_n, run) => {
    const flash = vi.fn()
    const busy: boolean[] = []
    chooseSavePath.mockResolvedValue(null)
    const handles = await mountExport(oneDoc(), layer(), (b) => busy.push(b), flash)
    await act(async () => {
      await run(handles)
    })
    expect(writeFile).not.toHaveBeenCalled()
    expect(flash).not.toHaveBeenCalled()
    expect(busy).toEqual([])
  })

  it.each(paths)('%s: reports a failure and still clears busy', async (_name, run) => {
    const flash = vi.fn()
    const busy: boolean[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFile.mockRejectedValue(new Error('disk full'))
    const handles = await mountExport(oneDoc(), layer(covered(1)), (b) => busy.push(b), flash)
    await act(async () => {
      await run(handles)
    })
    // The redaction note rides on the SUCCESS flash only — a failed save reports the failure.
    expect(flash).toHaveBeenCalledWith('Export failed: disk full')
    expect(busy).toEqual([true, false])
    consoleError.mockRestore()
  })
})
