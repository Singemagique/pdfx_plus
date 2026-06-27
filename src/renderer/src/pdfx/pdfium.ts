// Renderer-side PDFium loader: initializes the WASM module once (fetching the bundled binary) and
// returns the shared instance used by the redaction pipeline (./redact). Kept separate from
// redact.ts so the engine stays pure and unit-testable with a module injected directly.
import { init } from '@embedpdf/pdfium'
import wasmUrl from '@embedpdf/pdfium/dist/pdfium.wasm?url'
import type { PdfiumModule } from './redact'

let instance: Promise<PdfiumModule> | null = null

/** Initialize PDFium once and return the shared module (PDFiumExt_Init already called). */
export function getPdfium(): Promise<PdfiumModule> {
  if (!instance) {
    instance = (async () => {
      const wasmBinary = await (await fetch(wasmUrl)).arrayBuffer()
      const mod = await init({ wasmBinary })
      mod.PDFiumExt_Init()
      return mod as unknown as PdfiumModule
    })()
  }
  return instance
}
