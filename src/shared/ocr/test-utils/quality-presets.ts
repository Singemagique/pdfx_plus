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
// - photoLike-fit-letter (PR11 review): photoLike fitted onto a white Letter page, the way PDFx
//   imports a photo next to a Letter page (D4).

import { getPreset, listPresets, registerPreset, type LayoutContext, type PresetDef } from './synth'

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

/** A short letter: ten lines of 11 pt body under a 54 pt top margin, the rest of the page empty. */
function shortLetter(ctx: LayoutContext): void {
  const size = 11
  const lines = ctx.wrap(ctx.bankWords(), ctx.width - 2 * 54, size)
  let baseline = ctx.height - 54 - ctx.ascent(size)
  for (const words of lines.slice(0, 10)) {
    ctx.line(words, 54, baseline, size)
    baseline -= 15
  }
}

/** A solid logo across the middle of the page and two lines of 11 pt text under it. */
function logoAndFooter(ctx: LayoutContext): void {
  const size = 11
  ctx.rule(ctx.width / 2 - 90, ctx.height / 2 + 10, ctx.width / 2 + 90, ctx.height / 2 + 10, 110)
  const lines = ctx.wrap(ctx.bankWords(), ctx.width - 48, size)
  ctx.line(lines[0], 24, 44, size)
  ctx.line(lines[1], 24, 28, size)
}

/** A till receipt: nine 9 pt lines of `Item 3.37` (seeded amounts) at the top of a narrow slip. */
function receipt(ctx: LayoutContext): void {
  const size = 9
  let baseline = ctx.height - 24 - ctx.ascent(size)
  for (let i = 0; i < 9; i++) {
    const amount = `${1 + (ctx.rng() % 9)}.${String(ctx.rng() % 100).padStart(2, '0')}`
    ctx.line(['Item', amount], 24, baseline, size)
    baseline -= 13
  }
}

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
  },
  // PR6 review: orientation cases whose text is not where a fixed central band looks, or whose
  // short lines fool the 90° profile test, and a quarter turn together with a skew.
  {
    id: 'rot180-short-letter',
    description: 'a Letter page upside down, ten lines of text in its (now bottom) third only',
    font: 'helvetica',
    page: { width: 612, height: 792 },
    renderDpi: 300,
    layout: shortLetter,
    ops: [{ op: 'quarterTurns', turns: 2 }]
  },
  {
    id: 'rot180-logo',
    description: 'upside down: a solid logo across the middle, two text lines under it',
    font: 'helvetica',
    page: { width: 432, height: 288 },
    renderDpi: 300,
    layout: logoAndFooter,
    ops: [{ op: 'quarterTurns', turns: 2 }]
  },
  {
    id: 'receipt90',
    description: 'a narrow till receipt (nine short 9 pt lines) turned 90° counter-clockwise',
    font: 'helvetica',
    page: { width: 144, height: 360 },
    renderDpi: 300,
    layout: receipt,
    ops: [{ op: 'quarterTurns', turns: 1 }]
  },
  {
    id: 'rot90-skew2',
    description: 'content turned 90° counter-clockwise and tilted by a further 2°',
    font: 'helvetica',
    page: PAGE,
    renderDpi: 300,
    layout: body,
    ops: [
      { op: 'quarterTurns', turns: 1 },
      { op: 'rotate', deg: 2 }
    ]
  },
  // PR11 review: photoLike as PDFx imports a photo next to a Letter page (imageToPdf fits it onto
  // 612 × 792 pt, centred, D4): a tinted, unevenly lit photo inside a white margin. The whole-page
  // photo test read the margin as paper and skipped normalisation: 4 words of 116.
  {
    ...getPreset('photoLike'),
    id: 'photoLike-fit-letter',
    description: 'photoLike fitted onto a white Letter page (an imported photo, D4)',
    place: { width: 612, height: 792 }
  }
]

for (const def of QUALITY_PRESETS) if (!listPresets().includes(def.id)) registerPreset(def)
