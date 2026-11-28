import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useExport } from './useExport'
import { makePageKey, type Overlay, type SignaturePlacement } from '../edit/model'
import { buildRedactedSources } from '../pdfx/redact-export'
import { withSignatureAppearance } from '../pdfx/signature-appearance'
import type { EditLayer } from '../pdfx/build'
import { buildPdf, buildPdfx } from '../pdfx/format'
import type { OcrExportSource } from '../ocr/export-source'
import { pack, type PackedOcrPage } from '../../../shared/ocr/types'
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
let signPdf: ReturnType<typeof vi.fn>
let signPdfWithCard: ReturnType<typeof vi.fn>
let signPdfWithWindowsCert: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  chooseSavePath = vi.fn(async (defaultName: string) => `/out/${defaultName}`)
  writeFile = vi.fn(async (path: string) => path.split('/').pop())
  signPdf = vi.fn(async () => new Uint8Array([4]))
  signPdfWithCard = vi.fn(async () => new Uint8Array([5]))
  signPdfWithWindowsCert = vi.fn(async () => new Uint8Array([6]))
  Object.defineProperty(window, 'api', {
    value: {
      chooseSavePath,
      writeFile,
      signPdf,
      signPdfWithCard,
      signPdfWithWindowsCert,
      p12CertInfo: vi.fn(async () => null),
      cardCertInfo: vi.fn(async () => null)
    },
    configurable: true,
    writable: true
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

type Api = ReturnType<typeof useExport>
interface Exports {
  exportCollection: (kind: 'pdfx' | 'pdf') => Promise<void>
  exportZip: () => Promise<void>
  signAndExport: Api['signAndExport']
  signWithCardAndExport: Api['signWithCardAndExport']
  signWithWindowsCertAndExport: Api['signWithWindowsCertAndExport']
  /** Render the same mounted hook again with a new collection / edit layer (no new handles). */
  rerender: (docs: DocEntry[], edits: EditLayer) => Promise<void>
}

/** Mount useExport in a throwaway component and hand back its save and sign entry points. */
async function mountExport(
  docs: DocEntry[],
  edits: EditLayer,
  setBusy: (busy: boolean) => void,
  flash: (message: string) => void,
  ocr?: OcrExportSource,
  placement: SignaturePlacement | null = null
): Promise<Exports> {
  let captured: Omit<Exports, 'rerender'> | null = null
  const Harness = (props: { docs: DocEntry[]; edits: EditLayer }): null => {
    const api = useExport(props.docs, props.edits, setBusy, flash, placement, null, ocr)
    // The FIRST render's handles: what a click made before a later render would call.
    captured ??= {
      exportCollection: api.exportCollection,
      exportZip: api.exportZip,
      signAndExport: api.signAndExport,
      signWithCardAndExport: api.signWithCardAndExport,
      signWithWindowsCertAndExport: api.signWithWindowsCertAndExport
    }
    return null
  }
  const render = async (d: DocEntry[], e: EditLayer): Promise<void> =>
    act(async () => {
      root.render(createElement(Harness, { docs: d, edits: e }))
    })
  await render(docs, edits)
  if (!captured) throw new Error('useExport never produced its handles')
  return { ...(captured as Omit<Exports, 'rerender'>), rerender: render }
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

  // ---- The invisible OCR text layer (DESIGN.md §3.7.1): every path hands its build a `layer`. ----

  /** The four call sites; the Sign path ticks its own "Include recognized text" box. */
  const ocrPaths: Array<[string, (e: Exports) => Promise<unknown>]> = [
    ...paths,
    ['sign', (e) => e.signAndExport(CERT, { passphrase: 'pw', includeRecognizedText: true })]
  ]

  it.each(ocrPaths)(
    '%s: the build receives a layer carrying the recognised text',
    async (name, run) => {
      const ocr = fakeOcr()
      const edits = layer()
      const handles = await mountExport(oneDoc(), edits, vi.fn(), vi.fn(), ocr)
      await act(async () => {
        await run(handles)
      })
      const built = builtLayer(name)
      expect(built.ocr?.get(KEY)).toBe(OCR_PAGE)
      // Layers a reopened source already carries are kept (and marked) too.
      expect(built.ocrPassthrough).toBe('keep')
      // A copy: EditProvider's memoised layer never gains an `ocr`.
      expect(built).not.toBe(edits)
      expect(edits.ocr).toBeUndefined()
      expect(ocr.snapshotFor).toHaveBeenCalledTimes(1)
    }
  )

  it.each(ocrPaths)(
    '%s: the Replace / Remove choices (ocrSelect) reach the snapshot and the build',
    async (name, run) => {
      const ocr = fakeOcr()
      const ocrSelect = new Map<string, string | null>([
        [KEY, 'cfg-b'],
        ['other#0', null]
      ])
      const edits = { ...layer(), ocrSelect }
      const handles = await mountExport(oneDoc(), edits, vi.fn(), vi.fn(), ocr)
      await act(async () => {
        await run(handles)
      })
      // snapshotFor applies them (ocr-select.ts); the bake drops a reopened page's own layer
      // wherever one is recorded (build.ts dropsSourceOcr).
      expect((ocr.snapshotFor.mock.calls[0][1] as EditLayer).ocrSelect).toBe(ocrSelect)
      expect(builtLayer(name).ocrSelect).toBe(ocrSelect)
    }
  )

  it.each(paths)(
    '%s: no recognised text when "Include Recognized Text When Exporting" is off',
    async (name, run) => {
      const ocr = fakeOcr({ include: false })
      const handles = await mountExport(oneDoc(), layer(), vi.fn(), vi.fn(), ocr)
      await act(async () => {
        await run(handles)
      })
      expect(builtLayer(name).ocr).toBeUndefined()
      // ...and the layers a reopened source already carries are dropped (D7).
      expect(builtLayer(name).ocrPassthrough).toBe('drop')
      // Not asked mid-job either (§3.8 "Export mid-job").
      expect(ocr.flushOrConfirm).not.toHaveBeenCalled()
      expect(ocr.snapshotFor).not.toHaveBeenCalled()
    }
  )

  it('sign: no recognised text unless its own box is ticked (D7), whatever the export setting', async () => {
    const ocr = fakeOcr({ include: true })
    const handles = await mountExport(oneDoc(), layer(), vi.fn(), vi.fn(), ocr)
    await act(async () => {
      await handles.signAndExport(CERT, { passphrase: 'pw' })
    })
    expect(builtLayer('sign').ocr).toBeUndefined()
    // The signature never covers machine text unasked, a source's own PDFx layer included.
    expect(builtLayer('sign').ocrPassthrough).toBe('drop')
    expect(ocr.flushOrConfirm).not.toHaveBeenCalled()
    expect(ocr.snapshotFor).not.toHaveBeenCalled()
  })

  it('sign: the box includes the text even with the export setting off, and stays out of the signer options', async () => {
    const ocr = fakeOcr({ include: false })
    const handles = await mountExport(oneDoc(), layer(), vi.fn(), vi.fn(), ocr)
    await act(async () => {
      await handles.signAndExport(CERT, { passphrase: 'pw', includeRecognizedText: true })
    })
    expect(builtLayer('sign').ocr?.get(KEY)).toBe(OCR_PAGE)
    expect(builtLayer('sign').ocrPassthrough).toBe('keep')
    expect(signPdf).toHaveBeenCalledWith(expect.any(Uint8Array), CERT, { passphrase: 'pw' })
  })

  it.each(ocrPaths)(
    '%s: flushOrConfirm → chooseSavePath → busy, then the snapshot',
    async (_n, run) => {
      const events: string[] = []
      const ocr = fakeOcr({ events })
      chooseSavePath.mockImplementation(async (name: string) => {
        events.push('chooseSavePath')
        return `/out/${name}`
      })
      const handles = await mountExport(oneDoc(), layer(), (b) => events.push(`busy=${b}`), vi.fn(), ocr) // prettier-ignore
      await act(async () => {
        await run(handles)
      })
      expect(events).toEqual(['flushOrConfirm', 'chooseSavePath', 'busy=true', 'snapshotFor', 'busy=false']) // prettier-ignore
    }
  )

  it.each(ocrPaths)(
    '%s: Cancel in the mid-job prompt opens no dialog and leaves busy untouched',
    async (_n, run) => {
      const busy: boolean[] = []
      const flash = vi.fn()
      const ocr = fakeOcr({ confirm: false })
      const handles = await mountExport(oneDoc(), layer(), (b) => busy.push(b), flash, ocr)
      await act(async () => {
        await run(handles)
      })
      expect(ocr.flushOrConfirm).toHaveBeenCalledTimes(1)
      expect(chooseSavePath).not.toHaveBeenCalled()
      expect(busy).toEqual([])
      expect(buildPdf).not.toHaveBeenCalled()
      expect(buildPdfx).not.toHaveBeenCalled()
      expect(writeFile).not.toHaveBeenCalled()
      expect(flash).not.toHaveBeenCalled()
    }
  )

  it.each(ocrPaths)(
    '%s: a redaction over the word removes it from the recognised text',
    async (name, run) => {
      const handles = await mountExport(
        oneDoc(),
        layer([redaction(0)]),
        vi.fn(),
        vi.fn(),
        fakeOcr()
      )
      await act(async () => {
        await run(handles)
      })
      expect(builtLayer(name).ocr).toBeUndefined()
    }
  )

  /** A redaction far from OCR_PAGE's only word. */
  const farRedaction = (): Overlay => ({ ...redaction(0), geom: geom(300, 300, 10, 10) })

  it.each(ocrPaths)(
    '%s: the redaction pass reports what it removed, and the layer is filtered against it',
    async (name, run) => {
      const removed = new Map([[KEY, []]])
      vi.mocked(buildRedactedSources).mockImplementationOnce(async () =>
        Object.assign(new Map<string, Uint8Array>(), { removed })
      )
      const handles = await mountExport(oneDoc(), layer([farRedaction()]), vi.fn(), vi.fn(), fakeOcr()) // prettier-ignore
      await act(async () => {
        await run(handles)
      })
      expect(vi.mocked(buildRedactedSources).mock.calls[0][2]).toEqual({ report: true })
      // The word the box does not touch stays, and the build re-checks against the same report.
      const built = builtLayer(name)
      expect(built.ocr?.get(KEY)).toBe(OCR_PAGE)
      expect(built.ocrRemoved).toBe(removed)
    }
  )

  it.each(ocrPaths)(
    '%s: without the removed-object report a redacted page gets no recognised text (fail-safe)',
    async (name, run) => {
      // The pass's default mock returns no `removed`.
      const handles = await mountExport(oneDoc(), layer([farRedaction()]), vi.fn(), vi.fn(), fakeOcr()) // prettier-ignore
      await act(async () => {
        await run(handles)
      })
      expect(builtLayer(name).ocr).toBeUndefined()
    }
  )

  it.each(ocrPaths)(
    '%s: a removed object under the word removes it, wherever the box is',
    async (name, run) => {
      const removed = new Map([[KEY, [{ x: 0, y: 0, w: 612, h: 792 }]]]) // a full-page scan
      vi.mocked(buildRedactedSources).mockImplementationOnce(async () =>
        Object.assign(new Map<string, Uint8Array>(), { removed })
      )
      const handles = await mountExport(oneDoc(), layer([farRedaction()]), vi.fn(), vi.fn(), fakeOcr()) // prettier-ignore
      await act(async () => {
        await run(handles)
      })
      expect(builtLayer(name).ocr).toBeUndefined()
    }
  )

  it.each(ocrPaths)(
    '%s: a redaction drawn while flushOrConfirm waits reaches the redaction pass and the layer',
    async (name, run) => {
      let release: (go: boolean) => void = () => {}
      const ocr = fakeOcr()
      ocr.flushOrConfirm.mockImplementation(() => new Promise<boolean>((r) => (release = r)))
      const handles = await mountExport(oneDoc(), layer(), vi.fn(), vi.fn(), ocr)
      let done: Promise<unknown> = Promise.resolve()
      await act(async () => {
        done = run(handles)
      })
      expect(chooseSavePath).not.toHaveBeenCalled()
      // "Wait and export" is non-modal: the user boxes the page out and adds a document meanwhile.
      const later: DocEntry[] = [...oneDoc(), { id: 'd2', name: 'B', pages: [page()] }]
      await handles.rerender(later, layer([redaction(0)]))
      await act(async () => {
        release(true)
        await done
      })
      const [passLayer, passDocs] = vi.mocked(buildRedactedSources).mock.calls[0]
      expect(passLayer.overlays.get(KEY)?.filter((o) => o.type === 'redaction')).toHaveLength(1)
      expect(passDocs).toHaveLength(2)
      // The fail-safe sees the new redaction too: the page gets no recognised text.
      if (name === 'zip') {
        expect(buildPdf).toHaveBeenCalledTimes(2)
        expect(vi.mocked(buildPdf).mock.calls[0][1]?.ocr).toBeUndefined()
      } else {
        expect(builtLayer(name).ocr).toBeUndefined()
        expect(builtLayer(name).overlays.get(KEY)).toHaveLength(1)
      }
      if (name === 'pdfx') expect(vi.mocked(buildPdfx).mock.calls[0][0]).toHaveLength(2)
      if (name === 'pdf') expect(vi.mocked(buildPdf).mock.calls[0][0]).toHaveLength(2)
    }
  )
})

describe('sign paths', () => {
  const PLACEMENT = { pageKey: KEY, x: 10, y: 10, w: 100, h: 40 } as unknown as SignaturePlacement
  const MARKER = highlight(7, geom(10, 10, 100, 40))

  it.each([true, false])(
    'the build bakes the signature appearance (recognised text included: %s)',
    async (include) => {
      vi.mocked(withSignatureAppearance).mockImplementation(async (edits) => ({
        ...edits,
        overlays: new Map([[KEY, [MARKER]]])
      }))
      const handles = await mountExport(oneDoc(), layer(), vi.fn(), vi.fn(), fakeOcr(), PLACEMENT)
      await act(async () => {
        await handles.signAndExport(CERT, { passphrase: 'pw', includeRecognizedText: include })
      })
      expect(withSignatureAppearance).toHaveBeenCalledTimes(1)
      const built = builtLayer('sign')
      expect(built.overlays.get(KEY)).toEqual([MARKER])
      expect(built.ocr?.get(KEY)).toBe(include ? OCR_PAGE : undefined)
    }
  )

  const CARD = { modulePath: '/lib/p11.so', pin: '1234' }
  const signers: Array<
    [string, (e: Exports, include: boolean) => Promise<unknown>, () => unknown[]]
  > = [
    ['card', (e, include) => e.signWithCardAndExport(CARD, { reason: 'r', includeImage: true, includeRecognizedText: include }), () => signPdfWithCard.mock.calls[0]], // prettier-ignore
    ['windows', (e, include) => e.signWithWindowsCertAndExport('AB12', { reason: 'r', includeImage: true, includeRecognizedText: include }), () => signPdfWithWindowsCert.mock.calls[0]] // prettier-ignore
  ]

  it.each(signers)(
    '%s: the box decides the layer, and the flag never reaches the signer',
    async (_name, run, signerCall) => {
      for (const include of [true, false]) {
        vi.clearAllMocks()
        const handles = await mountExport(oneDoc(), layer(), vi.fn(), vi.fn(), fakeOcr())
        await act(async () => {
          await run(handles, include)
        })
        const built = builtLayer('sign')
        expect(built.ocr?.get(KEY)).toBe(include ? OCR_PAGE : undefined)
        expect(built.ocrPassthrough).toBe(include ? 'keep' : 'drop')
        const options = signerCall()[2] as Record<string, unknown>
        expect(options).toEqual({ reason: 'r' })
      }
    }
  )
})

const CERT = new Uint8Array([9])

/** A one-word recognised page. */
const OCR_PAGE: PackedOcrPage = pack({
  v: 1,
  engineId: 'test/engine',
  dataHashes: {},
  langs: ['eng'],
  pipelineVersion: 1,
  pageClass: 'scanned',
  renderDpi: 300,
  physDpi: 300,
  orientation: 0,
  skewDeg: 0,
  meanConfCal: 0.9,
  confSource: 'word',
  status: 'ok',
  lines: [{ angle: 0, size: 10, words: [{ t: 'hello', x: 10, y: 10, w: 20, conf: 90, confCal: 0.9 }] }] // prettier-ignore
})

type FakeOcr = OcrExportSource & {
  flushOrConfirm: ReturnType<typeof vi.fn>
  snapshotFor: ReturnType<typeof vi.fn>
}

/** An OcrExportSource holding OCR_PAGE for page KEY, recording the order of its calls. */
function fakeOcr(opts: { include?: boolean; confirm?: boolean; events?: string[] } = {}): FakeOcr {
  return {
    flushOrConfirm: vi.fn(async () => {
      opts.events?.push('flushOrConfirm')
      return opts.confirm ?? true
    }),
    snapshotFor: vi.fn(() => {
      opts.events?.push('snapshotFor')
      return new Map([[KEY, OCR_PAGE]])
    }),
    includeInExports: () => opts.include ?? true
  }
}

/** The `layer` argument the path's build step received (the one call it made). */
function builtLayer(path: string): EditLayer {
  if (path === 'pdfx') {
    expect(buildPdfx).toHaveBeenCalledTimes(1)
    return vi.mocked(buildPdfx).mock.calls[0][2] as EditLayer
  }
  expect(buildPdf).toHaveBeenCalledTimes(1)
  return vi.mocked(buildPdf).mock.calls[0][1] as EditLayer
}
