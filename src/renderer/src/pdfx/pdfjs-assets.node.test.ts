// pdf.js 5.x decodes CCITTFax, JBIG2 and JPX images with WebAssembly modules it fetches from the
// getDocument `wasmUrl`; without it those images decode to nothing and scans render blank. These
// tests run the real pdfjs-dist decoder against tiny fixture images, configured exactly as the app
// configures it (pdfjsAssetOptions), resolved against node_modules/pdfjs-dist — whose layout the
// emitted `pdfjs/` directory mirrors (see the pdfx-pdfjs-assets plugin in electron.vite.config.ts).
// The without-options control lives in pdfjs-assets-missing.node.test.ts (pdf.js caches decoder
// modules per process, so the two cases cannot share a file).

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  PDFJS_ASSET_SUBDIRS,
  PDFJS_WASM_FILES,
  pdfjsAssetBase,
  pdfjsAssetOptions
} from './pdfjs-assets'
import { PDFJS_DIST_DIR, ccittPdf, decodeImageRows, jpxPdf } from '../test-utils/pdfjs-images'

describe('pdf.js asset URLs', () => {
  it('resolves the dev-server base', () => {
    expect(pdfjsAssetBase('http://localhost:5173/', '/')).toBe('http://localhost:5173/pdfjs/')
  })

  it('resolves the packaged file:// base next to index.html (Vite base "./")', () => {
    const page = 'file:///C:/Program%20Files/PDFx/resources/app.asar/out/renderer/index.html'
    expect(pdfjsAssetBase(page, './')).toBe(
      'file:///C:/Program%20Files/PDFx/resources/app.asar/out/renderer/pdfjs/'
    )
    expect(pdfjsAssetBase(page, '.')).toBe(pdfjsAssetBase(page, './'))
  })

  it('builds directory URLs for every option and routes the loads via the main thread', () => {
    expect(pdfjsAssetOptions('file:///app/out/renderer/pdfjs/')).toEqual({
      wasmUrl: 'file:///app/out/renderer/pdfjs/wasm/',
      standardFontDataUrl: 'file:///app/out/renderer/pdfjs/standard_fonts/',
      cMapUrl: 'file:///app/out/renderer/pdfjs/cmaps/',
      cMapPacked: true,
      useWorkerFetch: false
    })
  })

  it('rejects a base that is not a directory URL (pdf.js appends file names to it)', () => {
    expect(() => pdfjsAssetOptions('file:///app/out/renderer/pdfjs')).toThrow(/must end with/)
  })

  it('names subdirectories and files that exist in pdfjs-dist', () => {
    for (const dir of Object.values(PDFJS_ASSET_SUBDIRS)) {
      expect(existsSync(PDFJS_DIST_DIR + dir), dir).toBe(true)
    }
    for (const file of PDFJS_WASM_FILES) {
      expect(existsSync(PDFJS_DIST_DIR + PDFJS_ASSET_SUBDIRS.wasm + file), file).toBe(true)
    }
    // A packed CJK CMap (cMapPacked: true) and a standard-font file pdf.js asks for by name.
    expect(existsSync(`${PDFJS_DIST_DIR}${PDFJS_ASSET_SUBDIRS.cMaps}UniJIS-UCS2-H.bcmap`)).toBe(
      true
    )
    expect(existsSync(`${PDFJS_DIST_DIR}${PDFJS_ASSET_SUBDIRS.standardFonts}FoxitSerif.pfb`)).toBe(
      true
    )
  })
})

describe('pdf.js wasm image decoders with the app asset options', () => {
  it('decodes a CCITT Group 4 image (jbig2.wasm)', async () => {
    const { pdf, expected } = await ccittPdf()
    expect(await decodeImageRows(pdf, pdfjsAssetOptions(PDFJS_DIST_DIR))).toEqual(expected)
  })

  it('decodes a JPEG 2000 image (openjpeg.wasm)', async () => {
    const { pdf, expected } = await jpxPdf()
    expect(await decodeImageRows(pdf, pdfjsAssetOptions(PDFJS_DIST_DIR))).toEqual(expected)
  })
})
