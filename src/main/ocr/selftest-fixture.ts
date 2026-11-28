// The packaged self-test's page (`pdfx --ocr-selftest`, DESIGN.md §3.9.3 tier 1c): the `clean300`
// synth preset (seed 1) as its image-only scanned PDF, and the exact packed result the pipeline must
// produce from it. Both are written by `yarn ocr:record` (selftest.ocr.test.ts), which runs this very
// page through the real coordinator and threads under Node; the packaged app (Electron's Node) must
// reproduce the digest exactly, which catches the glue or the JS pipeline drifting between runtimes.

import fixture from './selftest-clean300.json'

export interface SelftestFixture {
  preset: string
  seed: number
  /** The scanned PDF, base64. */
  pdfBase64: string
  /** The page frame (pt) and the DPI it is recognised at. */
  page: { width: number; height: number }
  dpi: number
  langs: string[]
  expected: {
    status: string
    words: number
    /** SHA-256 of the packed page's arrays and text (`packedDigest`). */
    digest: string
    /** The recognised copy text (our own MIT sample text). */
    text: string
  }
}

export const SELFTEST: SelftestFixture = fixture as SelftestFixture

export function selftestPdf(): Uint8Array {
  return Uint8Array.from(Buffer.from(SELFTEST.pdfBase64, 'base64'))
}
