// Node-side loaders for the synth harness: PDFium WASM and the DejaVu TTFs straight from
// node_modules (no network, no bundler), the same way src/renderer/src/test-utils/pdfium.ts and
// fonts.ts do. Test-only. Kept apart from synth.ts so the generator itself stays free of `node:fs`.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { init } from '@embedpdf/pdfium'

import { createPdfiumRasterizer, type PdfiumRenderModule } from './pdfium-raster'
import { DEJAVU_FILES, type SynthDeps } from './synth'

const ROOT = '../../../../'

function repoFile(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(ROOT + rel, import.meta.url))))
}

let pdfium: Promise<PdfiumRenderModule> | null = null

/** Boot PDFium once per worker (it is ~4 MB of WASM). */
export function loadNodePdfium(): Promise<PdfiumRenderModule> {
  pdfium ??= (async () => {
    const mod = await init({
      wasmBinary: repoFile('node_modules/@embedpdf/pdfium/dist/pdfium.wasm')
    })
    mod.PDFiumExt_Init()
    return mod as unknown as PdfiumRenderModule
  })()
  return pdfium
}

/** Synth dependencies for vitest's Node project. */
export async function loadNodeSynthDeps(): Promise<SynthDeps> {
  const rasterize = createPdfiumRasterizer(await loadNodePdfium())
  const cache = new Map<string, Uint8Array>()
  return {
    rasterize,
    fontBytes: (id) => {
      const file = DEJAVU_FILES[id]
      let bytes = cache.get(file)
      if (!bytes) {
        bytes = repoFile('node_modules/dejavu-fonts-ttf/ttf/' + file)
        cache.set(file, bytes)
      }
      return bytes
    }
  }
}
