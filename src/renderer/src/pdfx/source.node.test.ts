// loadSource must open every PDF with pdf.js's asset options: without `wasmUrl` pdf.js cannot load
// its CCITT/JBIG2/JPX decoders and those scans render blank (pdfjs-assets.node.test.ts proves the
// decode itself); without standardFontDataUrl / cMapUrl non-embedded standard fonts and CJK
// predefined CMaps fail. This pins the wiring, resolved the way the packaged file:// page does it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDocument } from 'pdfjs-dist'
import { loadSource } from './source'

vi.mock('pdfjs-dist', () => ({ getDocument: vi.fn() }))

const RENDERER = 'file:///C:/Program%20Files/PDFx/resources/app.asar/out/renderer/'

beforeEach(() => {
  vi.stubGlobal('document', { baseURI: `${RENDERER}index.html` })
  vi.stubEnv('BASE_URL', './') // what the built renderer gets (electron-vite's base: './')
  vi.mocked(getDocument).mockReturnValue({
    promise: Promise.resolve({ numPages: 0 })
  } as unknown as ReturnType<typeof getDocument>)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.mocked(getDocument).mockReset()
})

describe('loadSource', () => {
  it('passes pdf.js the wasm, standard-font and CMap directories beside the renderer', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    await loadSource(bytes)
    expect(getDocument).toHaveBeenCalledTimes(1)
    const params = vi.mocked(getDocument).mock.calls[0][0] as Record<string, unknown>
    expect(params).toMatchObject({
      wasmUrl: `${RENDERER}pdfjs/wasm/`,
      standardFontDataUrl: `${RENDERER}pdfjs/standard_fonts/`,
      cMapUrl: `${RENDERER}pdfjs/cmaps/`,
      cMapPacked: true,
      useWorkerFetch: false
    })
    // pdf.js transfers (detaches) the buffer it is given, so it must get a copy.
    expect(params.data).toEqual(bytes)
    expect(params.data).not.toBe(bytes)
  })
})
