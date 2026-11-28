// Test-only stand-in for '@embedpdf/pdfium' inside a bundled raster thread (threads.node.test.ts):
// the real CJS build, with FPDF_RenderPageBitmap wrapped by the thread's PDFX_TEST_PDFIUM_SHIM
// environment variable:
//   enlarge  PDFium's "Cannot enlarge memory" line goes out through the glue's own `printErr` in the
//            middle of the render call, which then returns normally (the silent-blank case PR0 saw
//            near the 2 GiB cap). This exercises raster-thread.ts's printErr wiring for real.
//   trap     the render throws a WebAssembly.RuntimeError, as a trap inside PDFium does.
// Anything else leaves the module untouched.

import { init as realInit } from '../../../../node_modules/@embedpdf/pdfium/dist/index.cjs'

export const ENLARGE_LINE =
  'Cannot enlarge memory, requested 2147549184 bytes, but the limit is 2147483648 bytes!'

type Overrides = Record<string, unknown> & { printErr?: (line: string) => void }
type Wrapped = Record<string, unknown> & { FPDF_RenderPageBitmap: (...args: number[]) => void }

export async function init(overrides: Overrides): Promise<Wrapped> {
  const mod = (await (realInit as unknown as (o: Overrides) => Promise<Wrapped>)(
    overrides
  )) as Wrapped
  const mode = process.env.PDFX_TEST_PDFIUM_SHIM
  const render = mod.FPDF_RenderPageBitmap
  mod.FPDF_RenderPageBitmap = (...args: number[]): void => {
    if (mode === 'trap') throw new WebAssembly.RuntimeError('unreachable')
    if (mode === 'enlarge') overrides.printErr?.(ENLARGE_LINE)
    render(...args)
  }
  return mod
}
