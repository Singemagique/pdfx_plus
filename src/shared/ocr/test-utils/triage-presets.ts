// The scan-like synth presets behind the PR4b triage fixtures (DESIGN.md §3.9.1). Test-only,
// DOM-free. Each preset is the SCAN the fixture starts from (its raster, DPI and ground truth come
// from synth.ts as usual); the PDF-level construction that gives the fixture its name (a vector fax
// header, a Bates number, a Form XObject wrapper, strips, a rotated placement, encryption) is
// applied by src/main/ocr/test-utils/triage-fixtures.ts on top of `synthesize`'s raster.
//
// Importing this module registers the presets (once per realm, like synth.ts's own).

import { listPresets, registerPreset, type LayoutContext, type PresetDef } from './synth'

/** Paragraphs of the sample bank filling the page inside `margin` (pt). */
function paragraphs(margin: number, size: number, leading: number): (ctx: LayoutContext) => void {
  return (ctx) => {
    const lines = ctx.wrap(ctx.bankWords(), ctx.width - 2 * margin, size)
    let baseline = ctx.height - margin - ctx.ascent(size)
    for (const words of lines) {
      if (baseline - ctx.descent(size) < margin) break
      ctx.line(words, margin, baseline, size)
      baseline -= leading
    }
  }
}

const LETTER = { width: 612, height: 792 }
const BEIGE: [number, number, number] = [236, 224, 198]

export const TRIAGE_PRESETS: PresetDef[] = [
  {
    id: 'fax-header',
    description:
      'a 200 DPI binarised Letter fax; the fixture adds ~80 chars of vector header in a top band',
    font: 'helvetica',
    page: LETTER,
    renderDpi: 200,
    layout: paragraphs(72, 11, 15),
    ops: [{ op: 'binarize', threshold: 128 }]
  },
  {
    id: 'near-scanned-bates',
    description: 'a 150 DPI Letter scan; the fixture adds a vector Bates number',
    font: 'times',
    page: LETTER,
    renderDpi: 150,
    layout: paragraphs(72, 11, 15),
    ops: []
  },
  {
    id: 'formxobject-scan',
    description: 'a 150 DPI Letter scan; the fixture wraps the image in two nested Form XObjects',
    font: 'helvetica',
    page: LETTER,
    renderDpi: 150,
    layout: paragraphs(72, 11, 15),
    ops: []
  },
  {
    id: 'strip-scan',
    description: 'a 150 DPI Letter scan; the fixture splits it into 4 horizontal image strips',
    font: 'helvetica',
    page: LETTER,
    renderDpi: 150,
    layout: paragraphs(72, 11, 15),
    ops: []
  },
  {
    id: 'rotated-placement',
    description:
      'a 150 DPI landscape Letter scan; the fixture places it on a 90° matrix on a portrait page',
    font: 'helvetica',
    page: { width: 792, height: 612 },
    renderDpi: 150,
    layout: paragraphs(72, 11, 15),
    ops: []
  },
  {
    id: 'encrypted-owner',
    description: 'a 100 DPI Letter scan; the fixture writes it with an owner password (RC4/AES)',
    font: 'helvetica',
    page: LETTER,
    renderDpi: 100,
    layout: paragraphs(72, 11, 15),
    ops: []
  },
  {
    id: 'photo-text',
    description:
      'a 4032×3024 px "phone photo" of large text (beige paper, lighting gradient) for the photo-fit fixtures',
    font: 'helvetica',
    page: { width: 4032, height: 3024 },
    renderDpi: 72,
    layout: paragraphs(240, 96, 130),
    ops: [
      { op: 'background', rgb: BEIGE },
      { op: 'lighting', fromQ8: 256, toQ8: 190 }
    ]
  }
]

for (const def of TRIAGE_PRESETS) if (!listPresets().includes(def.id)) registerPreset(def)
