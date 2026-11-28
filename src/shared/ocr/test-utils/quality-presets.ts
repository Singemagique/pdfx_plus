// The PR6 synth presets (DESIGN.md §3.9.1, §3.4): what the quality pipeline needs beyond PR1's
// set. Test-only, DOM-free; importing this module registers them (once per realm).
//
// - rot270page: the other quarter turn (orientation must pick 270 vs 90 from the band test).
// - skew5: a skew well past the 1° snap, inside the ±7° deskew range.
// - border-scan: a dark scanner frame and binder shadow along the page edges (border removal).
// - bilevel300: the clean page binarised at its own 300 DPI, so the image is placed exactly 1:1:
//   PR0b's bilevel codec case and part of the codec outcome gate. (PR0b measured PDFium 97.8%
//   exact on a 1:1 A4 placement with fractional pt sizes; on this exact integer placement PDFium
//   copies the bits with or without smoothing [measured, raster-core.node.test.ts].) The image is 1-bit Flate; CCITT and
//   JBIG2 decode to the same bits (PR0b), and PDFium smooths after decoding whatever the codec.
// - bilevel240: the same at 240 DPI, so the scan renders at 300 DPI = 1.25× native: inside the
//   NO_SMOOTHIMAGE rule's ≤ 1.5× range, where (unlike an exact 1:1 placement, which PDFium copies
//   bit for bit either way [measured, raster-core.node.test.ts]) smoothing changes the raster.
// - letter10pt: a full Letter page of 10 pt body text at 300 DPI (2550 × 3300 px): the §3.9.4 time
//   row's page (the design names A4; Letter is the same 8.4–8.7 MP class) and a full-page check.
// - smallprint6pt-blur / smallprint6pt-fax: 6 pt text degraded, where the adaptive pass has
//   something to win (§3.4.3: "PR6 measures what the pass gains on smallprint6pt + degradations").

import { listPresets, registerPreset, type LayoutContext, type PresetDef } from './synth'

const PAGE = { width: 432, height: 180 }

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

const body = paragraphs(24, 11, 15)
const small = paragraphs(24, 6, 7.5)

/** Body text inside a dark frame: thick rules on all four edges and a wide shadow on the left. */
function framed(ctx: LayoutContext): void {
  body(ctx)
  const w = ctx.width
  const h = ctx.height
  ctx.rule(0, 3, w, 3, 6)
  ctx.rule(0, h - 3, w, h - 3, 6)
  ctx.rule(w - 3, 0, w - 3, h, 6)
  ctx.rule(5, 0, 5, h, 10)
}

export const QUALITY_PRESETS: PresetDef[] = [
  {
    id: 'rot270page',
    description: 'content turned 90° clockwise',
    font: 'helvetica',
    page: PAGE,
    renderDpi: 300,
    layout: body,
    ops: [{ op: 'quarterTurns', turns: 3 }]
  },
  {
    id: 'skew5',
    description: '+5° tilt (counter-clockwise)',
    font: 'helvetica',
    page: PAGE,
    renderDpi: 300,
    layout: body,
    ops: [{ op: 'rotate', deg: 5 }]
  },
  {
    id: 'border-scan',
    description: 'body text inside a dark scanner frame and binder shadow',
    font: 'helvetica',
    page: PAGE,
    renderDpi: 300,
    layout: framed,
    ops: [{ op: 'noise', sigma: 6 }]
  },
  {
    id: 'bilevel300',
    description: '300 DPI binarised at 50%, placed 1:1 (1-bit image, the codec case)',
    font: 'helvetica',
    page: PAGE,
    renderDpi: 300,
    layout: body,
    ops: [{ op: 'binarize', threshold: 128 }]
  },
  {
    id: 'letter10pt',
    description: 'a full Letter page of 10 pt body text at 300 DPI',
    font: 'helvetica',
    page: { width: 612, height: 792 },
    renderDpi: 300,
    layout: paragraphs(54, 10, 13),
    ops: []
  },
  {
    id: 'bilevel240',
    description: '240 DPI binarised at 50% (1-bit, rendered at 1.25× native)',
    font: 'helvetica',
    page: PAGE,
    renderDpi: 300,
    layout: body,
    ops: [
      { op: 'resample', dpi: 240 },
      { op: 'binarize', threshold: 128 }
    ]
  },
  {
    id: 'smallprint6pt-blur',
    description: '6 pt body text at 300 DPI, Gaussian blur σ = 0.8 px',
    font: 'helvetica',
    page: PAGE,
    renderDpi: 300,
    layout: small,
    ops: [{ op: 'blur', sigma: 0.8 }]
  },
  {
    id: 'smallprint6pt-fax',
    description: '6 pt body text resampled to 200 DPI and binarised (fax small print)',
    font: 'helvetica',
    page: PAGE,
    renderDpi: 300,
    layout: small,
    ops: [
      { op: 'resample', dpi: 200 },
      { op: 'binarize', threshold: 128 }
    ]
  }
]

for (const def of QUALITY_PRESETS) if (!listPresets().includes(def.id)) registerPreset(def)
