// Control for pdfjs-assets.node.test.ts: the same fixture images, loaded the way source.ts loaded
// them before the asset options existed (no wasmUrl). pdf.js cannot initialise its wasm decoders,
// drops each image, and the page renders blank — the bug the options fix. Kept in its own file
// because pdf.js caches decoder modules (failed or loaded) for the life of the process.

import { describe, expect, it } from 'vitest'
import { ccittPdf, decodeImageRows, jpxPdf } from '../test-utils/pdfjs-images'

describe('pdf.js wasm image decoders without the asset options', () => {
  it('cannot decode a CCITT Group 4 image', async () => {
    expect(await decodeImageRows((await ccittPdf()).pdf, {})).toBeNull()
  })

  it('cannot decode a JPEG 2000 image', async () => {
    expect(await decodeImageRows((await jpxPdf()).pdf, {})).toBeNull()
  })
})
