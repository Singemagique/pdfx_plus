// Synthetic "scanned" pages with exact ground truth (DESIGN.md §3.9.1). Test-only, DOM-free.
//
// Pipeline: pdf-lib draws our own MIT text word by word (so every word's box is known exactly) →
// PDFium WASM rasterises the vector page to 8-bit grey (injected `Rasterizer`; the same pixels on
// every OS) → the preset's seeded degradations (degrade.ts) → the raster is re-wrapped as an
// image-only PDF (one lossless Flate DeviceGray image XObject filling the page; 1 bpc when the
// raster is pure black/white) → `{ pdfBytes, raster, gt, vectorPdf }`.
//
// GROUND-TRUTH FRAMES
// - The "source frame" is the upright vector page pdf-lib drew on: PDF visual frame, bottom-left
//   origin, points. `gt.sourcePage` is its size and each word's `srcBox` is exact there.
// - The "output frame" is the scanned PDF's page, i.e. the degraded image as it lies on the page,
//   also bottom-left origin in points (`gt.page`). For rot90page the content lies sideways in it;
//   for skew2/photoLike it is tilted. This is the frame Find hits, the text layer and an engine's
//   mapped words live in, so it is the PRIMARY frame: `words[].box` is the axis-aligned bounding
//   box of `words[].quad`, the word's exact source rectangle carried through every geometric op.
// - `gt.toOutput` is the affine (PDF `cm` order [a b c d e f]) from source frame to output frame:
//   source pt → source px → every geometric op's pixel map → output px → output pt. Use
//   `toOutputFrame` / `toSourceFrame` to map any box either way (they return the exact quad plus
//   its bounding box). The map is exact for quarter turns and resampling; for a tilt it is the
//   exact inverse of the fixed-point sampling the rotation kernel uses.
// - Word boxes are ADVANCE × FONT ASCENT..DESCENT boxes (what a text layer and Find highlight
//   cover), not ink boxes. `srcInk`/`ink` add the dark-pixel bounds measured on the clean raster,
//   clipped to that box, for comparing against engines that report ink boxes.
// - Reading order is the `words` array order (`order` = index). Lines are in reading order and
//   `line` indexes `gt.lines`; within a line words run left to right (in the source frame), or
//   along a vertical line's reading direction (`GtLine.rotate`, LayoutContext.verticalLine).

import fontkit from '@pdf-lib/fontkit'
import { zlibSync } from 'fflate'
import { decode as jpegDecode, encode as jpegEncode } from 'jpeg-js'
import {
  PDFDocument,
  StandardFonts,
  concatTransformationMatrix,
  degrees,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type PDFFont,
  type PDFPage
} from 'pdf-lib'

import {
  applyAffine,
  background,
  binarize,
  composeAffine,
  createRng,
  gaussianBlur,
  gaussianNoise,
  invertAffine,
  jpegRoundTrip,
  lightingGradient,
  lumaOf,
  resample,
  rotate,
  rotateQuarter,
  saltAndPepper,
  type Affine,
  type GreyImage,
  type JpegCodec,
  type Rng
} from './degrade'
import type { Box } from './metrics'
import type { Rasterizer } from './pdfium-raster'

// ---------------------------------------------------------------------------------------------
// Fonts

export type StandardFontId = 'helvetica' | 'times' | 'courier'
export type DejaVuFontId = 'dejavu-sans' | 'dejavu-serif' | 'dejavu-mono'
export type FontId = StandardFontId | DejaVuFontId

export const STANDARD_FONTS: Record<StandardFontId, StandardFonts> = {
  helvetica: StandardFonts.Helvetica,
  times: StandardFonts.TimesRoman,
  courier: StandardFonts.Courier
}

/** The repo's bundled DejaVu TTFs (devDependency `dejavu-fonts-ttf`, the same family fonts.ts embeds). */
export const DEJAVU_FILES: Record<DejaVuFontId, string> = {
  'dejavu-sans': 'DejaVuSans.ttf',
  'dejavu-serif': 'DejaVuSerif.ttf',
  'dejavu-mono': 'DejaVuSansMono.ttf'
}

const ALL_FONTS: FontId[] = [
  'helvetica',
  'times',
  'courier',
  'dejavu-sans',
  'dejavu-serif',
  'dejavu-mono'
]
/** DejaVu Sans Mono has no precomposed Vietnamese "ở", "ố", "ỗ", so it cannot draw the vi line. */
const DIACRITIC_FONTS: FontId[] = ['dejavu-sans', 'dejavu-serif']

export interface SynthDeps {
  rasterize: Rasterizer
  /** The TTF bytes of a DejaVu font (see `node-deps.ts`). */
  fontBytes(id: DejaVuFontId): Uint8Array
  /** JPEG codec for the `jpeg` op; defaults to jpeg-js 0.4.4. */
  jpeg?: JpegCodec
}

const JPEG_JS: JpegCodec = {
  encode: (img, quality) => jpegEncode(img, quality),
  decode: (bytes, opts) => jpegDecode(bytes, opts)
}

async function embed(doc: PDFDocument, id: FontId, deps: SynthDeps): Promise<PDFFont> {
  if (id in STANDARD_FONTS) return doc.embedFont(STANDARD_FONTS[id as StandardFontId])
  doc.registerFontkit(fontkit)
  // No ligatures, so every drawn glyph is one character of the GT; a fixed name keeps the vector
  // PDF's bytes stable.
  return doc.embedFont(deps.fontBytes(id as DejaVuFontId), {
    subset: true,
    customName: DEJAVU_FILES[id as DejaVuFontId].replace('.ttf', ''),
    features: { liga: false, clig: false, dlig: false }
  })
}

/** How a font is measured for the GT: vertical em metrics and the advance width it is drawn with. */
interface FontMeasure {
  /** Ascent and descent (both positive, pt) at `size`. */
  vMetrics(size: number): { ascent: number; descent: number }
  /** Advance width (pt) of `text` at `size`, exactly as `page.drawText` lays it out. */
  advance(text: string, size: number): number
  /** Throws if the font has no glyph for a character of `text` (it would draw .notdef). */
  assertCovers(text: string): void
}

function measureFont(font: PDFFont, id: FontId, deps: SynthDeps): FontMeasure {
  if (id in STANDARD_FONTS) {
    return {
      // pdf-lib's WinAnsi encoder already throws on a character the font cannot encode.
      assertCovers: () => {},
      // pdf-lib reads the AFM Ascender / Descender correctly for the Standard-14 fonts.
      vMetrics: (size) => {
        const ascent = font.heightAtSize(size, { descender: false })
        return { ascent, descent: font.heightAtSize(size) - ascent }
      },
      // `widthOfTextAtSize` adds the AFM kerning pairs, but `drawText` emits a plain `Tj` that is
      // never kerned, so the drawn advance is the sum of the single-glyph widths.
      advance: (text, size) => {
        let w = 0
        for (const ch of text) w += font.widthOfTextAtSize(ch, size)
        return w
      }
    }
  }
  // pdf-lib's CustomFontEmbedder.heightOfFontAtSize({ descender: false }) subtracts the descent in
  // raw font units from a value already scaled to 1000/em (for DejaVu, 2048 upm, the ascent comes
  // out 0.25 em short), so read the hhea ascent / descent from the font itself. pdf-lib writes the
  // same two numbers into the FontDescriptor.
  const f = fontkit.create(deps.fontBytes(id as DejaVuFontId))
  const asc = f.ascent / f.unitsPerEm
  const desc = Math.abs(f.descent) / f.unitsPerEm
  return {
    // fontkit would silently lay out .notdef (e.g. DejaVu Sans Mono has no "ở"), and the GT
    // would then claim text the page does not show.
    assertCovers: (text) => {
      for (const ch of text)
        if (!f.hasGlyphForCodePoint(ch.codePointAt(0)!))
          throw new Error(`font ${id} has no glyph for "${ch}"`)
    },
    vMetrics: (size) => ({ ascent: asc * size, descent: desc * size }),
    // Sums the laid-out glyphs' advance widths without GPOS kerning: the same glyphs `drawText`
    // encodes, each advancing by its own width.
    advance: (text, size) => font.widthOfTextAtSize(text, size)
  }
}

// ---------------------------------------------------------------------------------------------
// Degradation op descriptors (JSON, recorded in the GT)

export type DegradeOp =
  | { op: 'rotate'; deg: number }
  | { op: 'quarterTurns'; turns: number }
  | { op: 'blur'; sigma: number }
  | { op: 'noise'; sigma: number }
  | { op: 'saltPepper'; p: number }
  | { op: 'jpeg'; quality: number }
  | { op: 'resample'; dpi: number }
  | { op: 'binarize'; threshold: number }
  | { op: 'background'; rgb: [number, number, number] }
  | { op: 'lighting'; fromQ8: number; toQ8: number }

interface OpState {
  image: GreyImage
  dpi: number
  /** Source continuous px → current continuous px. */
  px: Affine
}

function applyOp(st: OpState, op: DegradeOp, rng: Rng, deps: SynthDeps): OpState {
  const keep = (image: GreyImage): OpState => ({ ...st, image })
  switch (op.op) {
    case 'rotate': {
      const r = rotate(st.image, op.deg)
      return { image: r.image, dpi: st.dpi, px: composeAffine(st.px, r.transform) }
    }
    case 'quarterTurns': {
      const r = rotateQuarter(st.image, op.turns)
      return { image: r.image, dpi: st.dpi, px: composeAffine(st.px, r.transform) }
    }
    case 'resample': {
      const w = (st.image.width * op.dpi) / st.dpi
      const h = (st.image.height * op.dpi) / st.dpi
      if (!Number.isInteger(w) || !Number.isInteger(h))
        throw new Error(`resample to ${op.dpi} dpi gives a fractional size ${w}x${h}`)
      const r = resample(st.image, w, h)
      return { image: r.image, dpi: op.dpi, px: composeAffine(st.px, r.transform) }
    }
    case 'blur':
      return keep(gaussianBlur(st.image, op.sigma))
    case 'noise':
      return keep(gaussianNoise(st.image, op.sigma, rng))
    case 'saltPepper':
      return keep(saltAndPepper(st.image, op.p, rng))
    case 'jpeg':
      return keep(jpegRoundTrip(st.image, op.quality, deps.jpeg ?? JPEG_JS).image)
    case 'binarize':
      return keep(binarize(st.image, op.threshold))
    case 'background':
      return keep(background(st.image, lumaOf(...op.rgb)))
    case 'lighting':
      return keep(lightingGradient(st.image, op.fromQ8, op.toQ8))
  }
}

// ---------------------------------------------------------------------------------------------
// Ground truth

export interface Point {
  x: number
  y: number
}

export interface GtWord {
  /** NFC text as drawn (punctuation included). */
  t: string
  /** Index into `gt.lines`. */
  line: number
  /** Reading-order index (= index in `gt.words`). */
  order: number
  /** Output frame (scanned page), bottom-left origin, pt: bounding box of `quad`. */
  box: Box
  /** Output frame: the source box's corners (lower-left, lower-right, upper-right, upper-left). */
  quad: [Point, Point, Point, Point]
  /** Source frame (upright vector page): advance width × ascent..descent. */
  srcBox: Box
  /** Dark-pixel (< 128) bounds on the clean raster, clipped to `srcBox`; source / output frame. */
  srcInk: Box | null
  ink: Box | null
}

export interface GtLine {
  /** Word indices, left to right. */
  words: number[]
  /** Words joined by single spaces. */
  text: string
  /**
   * Font size (pt) and baseline in the source frame: its y, or for a vertical line (`rotate`) its
   * x.
   */
  size: number
  baseline: number
  font: FontId
  /**
   * A vertical line (LayoutContext.verticalLine): 90 = turned counter-clockwise, reading bottom to
   * top; −90 = clockwise, top to bottom. Absent for horizontal lines.
   */
  rotate?: 90 | -90
}

export interface SynthGt {
  v: 1
  preset: string
  seed: number
  font: FontId
  /** DPI of the output raster and of the scanned page's image (pixels per inch of page). */
  dpi: number
  /** DPI the vector page was rasterised at before degradation. */
  renderDpi: number
  /** Output (scanned) page size, pt. */
  page: { width: number; height: number }
  /** Upright source (vector) page size, pt. */
  sourcePage: { width: number; height: number }
  raster: { width: number; height: number }
  /** Source frame → output frame (PDF `cm` order). */
  toOutput: Affine
  ops: DegradeOp[]
  /** The copy text: line texts joined by "\n". */
  text: string
  lines: GtLine[]
  words: GtWord[]
}

export interface SynthResult {
  /** The image-only "scanned" PDF (one page). */
  pdfBytes: Uint8Array
  /** The degraded raster, exactly the pixels embedded in `pdfBytes`. */
  raster: GreyImage
  /** The clean raster of the vector page at `renderDpi` (before any op). */
  clean: GreyImage
  /** The born-digital vector page (a control case, and the rasteriser's input). */
  vectorPdf: Uint8Array
  gt: SynthGt
}

/** Map a box through an affine: the exact quad and its bounding box. */
export function mapBox(m: Affine, b: Box): { quad: [Point, Point, Point, Point]; box: Box } {
  const corners: [number, number][] = [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h]
  ]
  const quad = corners.map(([x, y]) => {
    const [px, py] = applyAffine(m, x, y)
    return { x: px, y: py }
  }) as [Point, Point, Point, Point]
  const xs = quad.map((p) => p.x)
  const ys = quad.map((p) => p.y)
  const x0 = Math.min(...xs)
  const y0 = Math.min(...ys)
  return { quad, box: { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 } }
}

/** A source-frame box (upright vector page) → the output frame (scanned page). */
export function toOutputFrame(gt: Pick<SynthGt, 'toOutput'>, b: Box): ReturnType<typeof mapBox> {
  return mapBox(gt.toOutput, b)
}

/** An output-frame box (scanned page; e.g. an engine word or a Find hit) → the source frame. */
export function toSourceFrame(gt: Pick<SynthGt, 'toOutput'>, b: Box): ReturnType<typeof mapBox> {
  return mapBox(invertAffine(gt.toOutput), b)
}

// ---------------------------------------------------------------------------------------------
// Layout

/** What a preset's layout function draws with. Everything it draws through `line` becomes GT. */
export interface LayoutContext {
  page: PDFPage
  width: number
  height: number
  font: PDFFont
  fontId: FontId
  /** The layout's own seeded stream (independent of the degradation streams). */
  rng: Rng
  /** The seed-shuffled sample sentences, split into words. */
  bankWords(): string[]
  /** Greedy word wrap to `maxWidth` pt at `size`. */
  wrap(words: readonly string[], maxWidth: number, size: number): string[][]
  /** Draw one GT line of words starting at x (pt) on `baseline`, one space between words. */
  line(words: readonly string[], x: number, baseline: number, size: number): void
  /**
   * Draw one GT line turned by `rotate` (90: counter-clockwise, reading bottom to top from y; −90:
   * clockwise, reading top to bottom from y) on the vertical baseline x = `baselineX`. Each word's
   * box is its advance × ascent..descent, turned with it (still axis-aligned).
   */
  verticalLine(
    words: readonly string[],
    baselineX: number,
    y: number,
    size: number,
    rotate: 90 | -90
  ): void
  /** Draw a ruling (not text: not in the GT). */
  rule(x1: number, y1: number, x2: number, y2: number, thickness?: number): void
  ascent(size: number): number
  descent(size: number): number
}

export interface PresetDef {
  id: string
  description: string
  /** Default font; a spec may pick any font in `fonts`. */
  font: FontId
  /** Fonts whose glyph coverage the preset's text fits (default: all six). */
  fonts?: FontId[]
  /** Source page, pt. Use multiples of 36 so the page is a whole number of pixels at 150/200/300. */
  page: { width: number; height: number }
  renderDpi: number
  layout(ctx: LayoutContext): void
  ops: DegradeOp[]
  /**
   * Put the degraded scan on a white page of this size (pt), scaled to fit and centred, the way
   * `imageToPdf` fits an imported photo onto a page (renderer `images.ts`, D4). The GT, `gt.page`
   * and `gt.dpi` then describe the placed page; `raster` is still the image itself.
   */
  place?: { width: number; height: number }
}

const REGISTRY = new Map<string, PresetDef>()

/** Add a preset (later PRs register triage/redaction/photo-fit/codec presets the same way). */
export function registerPreset(def: PresetDef): void {
  if (REGISTRY.has(def.id)) throw new Error(`preset ${def.id} already registered`)
  REGISTRY.set(def.id, def)
}

export function getPreset(id: string): PresetDef {
  const def = REGISTRY.get(id)
  if (!def) throw new Error(`unknown preset ${id}`)
  return def
}

export function listPresets(): string[] {
  return [...REGISTRY.keys()]
}

/** Sample text, written for this corpus (MIT, like the repo). */
export const SAMPLE_SENTENCES = [
  'The harbour office opens at seven and closes when the last ferry has docked.',
  'Please return the signed form to the front desk before Friday afternoon.',
  'Our survey counted forty boats, nine cranes and one very patient heron.',
  'A quiet printer in the corner produced three copies of the quarterly report.',
  'Mira found the missing invoice folded inside an old atlas of the coast.',
  'The committee will review every proposal that arrives before the deadline.',
  'Fresh bread, cold milk and a jar of honey waited on the kitchen table.',
  'Each volunteer receives a map, a whistle and a bright yellow jacket.',
  'The bridge was painted green in spring and repaired again in autumn.',
  'Keep this receipt; it proves the parcel was posted on the right day.',
  'Several readers asked why the library moved the atlases to the top floor.',
  'Turn left at the bakery, cross the square and ring the second bell.',
  'The new schedule adds an early train and removes the late night bus.',
  'Our gardener planted tulips along the fence and herbs beside the gate.',
  'Every page of the manual explains one small task in plain language.',
  'The museum lends its lanterns to schools during the winter festival.',
  'Two engineers measured the tunnel and wrote their numbers in pencil.',
  'Rain delayed the match, so the players drank tea under the stands.',
  'The clerk stamped the passport, smiled and wished us a pleasant journey.',
  'A short letter from the council thanked residents for their patience.',
  'Wind turbines on the ridge turned slowly above the sleeping village.',
  'Bring a warm coat, sturdy boots and enough water for the whole hike.',
  'The orchestra rehearsed the final movement twice before the concert.',
  'Customers may exchange unused tickets at any station within a week.',
  'An old clock above the market still chimes a little after each hour.',
  'The weather station logs temperature, humidity and wind every minute.',
  'Students built a model lighthouse from paper, glue and a tiny lamp.',
  'Our neighbour repairs bicycles in a shed that smells of oil and pine.',
  'The ledger lists every delivery, the driver and the time of arrival.',
  'Lunch is served in the courtyard when the sun is warm enough.',
  'A careful reader will notice that the second chapter starts mid sentence.',
  'The archive keeps maps, photographs and letters in labelled boxes.'
]

function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng() % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Fill a single-column block: greedy wrap of the bank, as many lines as fit. */
function paragraphLayout(opts: {
  margin: number
  top: number
  size: number
  leading: number
}): (ctx: LayoutContext) => void {
  return (ctx) => {
    const { margin, top, size, leading } = opts
    const lines = ctx.wrap(ctx.bankWords(), ctx.width - 2 * margin, size)
    let baseline = ctx.height - top - ctx.ascent(size)
    for (const words of lines) {
      if (baseline - ctx.descent(size) < margin) break
      ctx.line(words, margin, baseline, size)
      baseline -= leading
    }
  }
}

function twoColumnLayout(ctx: LayoutContext): void {
  const margin = 24
  const gutter = 18
  const size = 10
  const leading = 13
  const colW = (ctx.width - 2 * margin - gutter) / 2
  const lines = ctx.wrap(ctx.bankWords(), colW, size)
  const first = ctx.height - margin - ctx.ascent(size)
  const perCol = Math.floor((first - ctx.descent(size) - margin) / leading) + 1
  let k = 0
  for (let col = 0; col < 2; col++)
    for (let r = 0; r < perCol && k < lines.length; r++, k++)
      ctx.line(lines[k], margin + col * (colW + gutter), first - r * leading, size)
}

/** Zero-pad to `n` digits. */
const pad = (v: number, n: number): string => String(v).padStart(n, '0')

/** Thousands grouping without Intl (locale-independent): 1234567 → "1,234,567". */
function group(v: number, sep: string): string {
  const s = String(v)
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += sep
    out += s[i]
  }
  return out
}

function numbersTableLayout(ctx: LayoutContext): void {
  const cols = 4
  const rows = 7
  const cellW = 96
  const cellH = 24
  const x0 = (ctx.width - cols * cellW) / 2
  const yTop = ctx.height - 24
  const size = 10
  const r = ctx.rng
  // Characters OCR confuses: 0/O, 1/l/I.
  const confusable = '0O1lI23456789'
  const code = (n: number): string =>
    Array.from({ length: n }, () => confusable[r() % confusable.length]).join('')
  const cell = (row: number, col: number): string => {
    if (row === 0) return ['Invoice', 'Date', 'Amount', 'Code'][col]
    switch (col) {
      case 0:
        return `INV-${code(5)}`
      case 1: {
        const y = 2019 + (r() % 8)
        const m = 1 + (r() % 12)
        const d = 1 + (r() % 28)
        const style = r() % 3
        return style === 0
          ? `${y}-${pad(m, 2)}-${pad(d, 2)}`
          : style === 1
            ? `${pad(d, 2)}.${pad(m, 2)}.${y}`
            : `${pad(m, 2)}/${pad(d, 2)}/${y}`
      }
      case 2: {
        const whole = r() % 200000
        const cents = pad(r() % 100, 2)
        return r() % 2 ? `$${group(whole, ',')}.${cents}` : `€ ${group(whole, '.')},${cents}`
      }
      default:
        return `${code(2)}-${code(3)} ${code(1)}`
    }
  }
  for (let i = 0; i <= rows; i++)
    ctx.rule(x0, yTop - i * cellH, x0 + cols * cellW, yTop - i * cellH)
  for (let j = 0; j <= cols; j++)
    ctx.rule(x0 + j * cellW, yTop, x0 + j * cellW, yTop - rows * cellH)
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const baseline = yTop - (row + 1) * cellH + 8
      ctx.line(cell(row, col).split(' '), x0 + col * cellW + 6, baseline, size)
    }
}

/** One line per language (de, fr, es, pl, cs, vi), our own sentences; order shuffled by seed. */
export const DIACRITIC_LINES: Record<string, string> = {
  de: 'Jürgen übergibt Größe und Maß der Brücke an Frau Köhler.',
  fr: "Noël, l'élève, préfère le cœur de la forêt où ça brûle.",
  es: '¿Qué añadió el niño? Azúcar, limón y un café pequeño.',
  pl: 'Łucja kupiła świeże jabłka; źrebię żuje trawę nad rzeką.',
  cs: 'Řidič přivezl čtyři žluté švestky a ještě dvě růže.',
  vi: 'Người dân ở đây uống nước chè và đọc sách mỗi ngày.'
}

function diacriticsLayout(ctx: LayoutContext): void {
  const margin = 24
  const size = 11
  const leading = 18
  let baseline = ctx.height - margin - ctx.ascent(size)
  for (const lang of shuffled(Object.keys(DIACRITIC_LINES), ctx.rng))
    for (const words of ctx.wrap(DIACRITIC_LINES[lang].split(' '), ctx.width - 2 * margin, size)) {
      ctx.line(words, margin, baseline, size)
      baseline -= leading
    }
}

const PAGE = { width: 432, height: 180 }
const body = paragraphLayout({ margin: 24, top: 24, size: 11, leading: 15 })
const BEIGE: [number, number, number] = [236, 224, 198]

const SINGLE_COLUMN: Pick<PresetDef, 'id' | 'description' | 'ops'>[] = [
  { id: 'clean300', description: '300 DPI, no degradation', ops: [] },
  { id: 'skew2', description: '+2° tilt (counter-clockwise)', ops: [{ op: 'rotate', deg: 2 }] },
  { id: 'blur1', description: 'Gaussian blur σ = 1 px', ops: [{ op: 'blur', sigma: 1 }] },
  {
    id: 'noise',
    description: 'Gaussian noise σ = 12 + 0.5% salt-and-pepper',
    ops: [
      { op: 'noise', sigma: 12 },
      { op: 'saltPepper', p: 0.005 }
    ]
  },
  { id: 'jpeg35', description: 'JPEG q = 35 (jpeg-js)', ops: [{ op: 'jpeg', quality: 35 }] },
  {
    id: 'fax200',
    description: '200 DPI, binarised at 50%',
    ops: [
      { op: 'resample', dpi: 200 },
      { op: 'binarize', threshold: 128 }
    ]
  },
  {
    id: 'low150',
    description: '150 DPI + slight blur (σ = 0.5 px)',
    ops: [
      { op: 'resample', dpi: 150 },
      { op: 'blur', sigma: 0.5 }
    ]
  },
  {
    id: 'rot90page',
    description: 'content turned 90° counter-clockwise (upright under /Rotate 90)',
    ops: [{ op: 'quarterTurns', turns: 1 }]
  },
  {
    id: 'rot180page',
    description: 'content upside down',
    ops: [{ op: 'quarterTurns', turns: 2 }]
  },
  {
    id: 'photoLike',
    description: '3° tilt + beige paper + lighting gradient (×1.0 → ×0.7), no warp',
    ops: [
      { op: 'rotate', deg: 3 },
      { op: 'background', rgb: BEIGE },
      { op: 'lighting', fromQ8: 256, toQ8: 179 }
    ]
  }
]

const BUILTIN: PresetDef[] = SINGLE_COLUMN.map((p) => ({
  ...p,
  font: 'helvetica',
  page: PAGE,
  renderDpi: 300,
  layout: body
}))

BUILTIN.push(
  {
    id: 'twocol',
    description: 'two columns, 10 pt (read column 1, then column 2)',
    font: 'helvetica',
    page: { width: 432, height: 216 },
    renderDpi: 300,
    layout: twoColumnLayout,
    ops: []
  },
  {
    id: 'smallprint6pt',
    description: '6 pt body text at 300 DPI',
    font: 'helvetica',
    page: PAGE,
    renderDpi: 300,
    layout: paragraphLayout({ margin: 24, top: 24, size: 6, leading: 7.5 }),
    ops: []
  },
  {
    id: 'numbers-table',
    description: 'amounts, dates, IDs with 0/O and 1/l/I in a ruled 4×7 grid',
    font: 'helvetica',
    page: { width: 432, height: 216 },
    renderDpi: 300,
    layout: numbersTableLayout,
    ops: []
  },
  {
    id: 'latin-diacritics',
    description: 'de/fr/es/pl/cs/vi sentences in DejaVu Sans or Serif',
    font: 'dejavu-sans',
    fonts: DIACRITIC_FONTS,
    page: PAGE,
    renderDpi: 300,
    layout: diacriticsLayout,
    ops: []
  }
)

// PR5 review: geometry the PR1 set never exercised. A residual skew below the 1° angle snap (scans
// commonly carry 0.3–0.9°): each word must keep its own baseline. And an upright page with a
// vertical label in each margin (hOCR `textangle` lines on a page whose orientation is fine).
for (const deg of [0.6, -0.6])
  BUILTIN.push({
    id: deg > 0 ? 'skew0p6' : 'skewm0p6',
    description: `${deg > 0 ? '+' : '−'}${Math.abs(deg)}° tilt (below the 1° angle snap)`,
    font: 'helvetica',
    page: PAGE,
    renderDpi: 300,
    layout: body,
    ops: [{ op: 'rotate', deg }]
  })

/**
 * 11 pt body between 48 pt margins; a 9 pt label up the left margin and down the right one. GT
 * order is left label, body, right label: the order Tesseract 5 (PSM 3) emits the three blocks in.
 * (It reads the right label as `textangle 90` too, i.e. upside down: garbage text, right place.)
 */
function marginLabelLayout(ctx: LayoutContext): void {
  const size = 11
  const leading = 15
  const side = 48
  const edge = 24
  const label = 9
  const body = ctx.wrap(ctx.bankWords(), ctx.width - 2 * side, size)
  const labels = ctx.wrap(ctx.bankWords(), ctx.height - 2 * edge, label)
  // Mirror images of each other: the left box spans [20 − ascent, 20 + descent].
  ctx.verticalLine(labels[0], 20, edge, label, 90)
  let baseline = ctx.height - edge - ctx.ascent(size)
  for (const words of body) {
    if (baseline - ctx.descent(size) < edge) break
    ctx.line(words, side, baseline, size)
    baseline -= leading
  }
  ctx.verticalLine(labels[1], ctx.width - 20, ctx.height - edge, label, -90)
}

BUILTIN.push({
  id: 'margin-label',
  description: 'upright 11 pt body with 9 pt vertical labels in both margins (up left, down right)',
  font: 'helvetica',
  page: { width: 432, height: 216 },
  renderDpi: 300,
  layout: marginLabelLayout,
  ops: []
})
for (const def of BUILTIN) registerPreset(def)

// ---------------------------------------------------------------------------------------------
// Synthesis

export interface SynthSpec {
  preset: string
  /** Any integer in [0, 2^32): picks the text order and seeds every noise stream. */
  seed: number
  font?: FontId
}

/** The image's rectangle on the page, pt (bottom-left origin). */
interface Placement {
  page: { width: number; height: number }
  x: number
  y: number
  w: number
  h: number
}

/**
 * Build the image-only PDF: one DeviceGray Flate XObject filling the page, or drawn at `place` on
 * a larger white page.
 */
async function scannedPdf(raster: GreyImage, dpi: number, place?: Placement): Promise<Uint8Array> {
  const { width: w, height: h, data } = raster
  const doc = await PDFDocument.create({ updateMetadata: false })
  const pw = place ? place.w : (w * 72) / dpi
  const ph = place ? place.h : (h * 72) / dpi
  const page = doc.addPage(place ? [place.page.width, place.page.height] : [pw, ph])
  let bits = 8
  let samples = data
  if (data.every((v) => v === 0 || v === 255)) {
    // 1 bpc rows, MSB first, 1 = white (DeviceGray), padded to a byte per row.
    bits = 1
    const rowBytes = (w + 7) >> 3
    samples = new Uint8Array(rowBytes * h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (data[y * w + x]) samples[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7)
  }
  const stream = doc.context.stream(zlibSync(samples, { level: 6 }), {
    Type: 'XObject',
    Subtype: 'Image',
    Width: w,
    Height: h,
    ColorSpace: 'DeviceGray',
    BitsPerComponent: bits,
    Filter: 'FlateDecode'
  })
  const name = page.node.newXObject('Im', doc.context.register(stream))
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(pw, 0, 0, ph, place?.x ?? 0, place?.y ?? 0),
    drawObject(name),
    popGraphicsState()
  )
  return doc.save()
}

/** Dark-pixel bounds (< 128) of `img` inside `srcBox` (source pt), in source pt; null if none. */
function inkBox(img: GreyImage, srcBox: Box, pageH: number, s: number): Box | null {
  const x0 = Math.max(0, Math.floor(srcBox.x * s))
  const x1 = Math.min(img.width, Math.ceil((srcBox.x + srcBox.w) * s))
  const y0 = Math.max(0, Math.floor((pageH - srcBox.y - srcBox.h) * s))
  const y1 = Math.min(img.height, Math.ceil((pageH - srcBox.y) * s))
  let minX = Infinity
  let minY = Infinity
  let maxX = -1
  let maxY = -1
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      if (img.data[y * img.width + x] < 128) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
  if (maxX < 0) return null
  const bx = Math.max(srcBox.x, minX / s)
  const by = Math.max(srcBox.y, pageH - (maxY + 1) / s)
  const bx1 = Math.min(srcBox.x + srcBox.w, (maxX + 1) / s)
  const by1 = Math.min(srcBox.y + srcBox.h, pageH - minY / s)
  return { x: bx, y: by, w: bx1 - bx, h: by1 - by }
}

/** Generate one synthetic scanned page and its ground truth. */
export async function synthesize(spec: SynthSpec, deps: SynthDeps): Promise<SynthResult> {
  const def = getPreset(spec.preset)
  if (!Number.isInteger(spec.seed) || spec.seed < 0 || spec.seed > 0xffffffff)
    throw new Error('seed must be an integer in [0, 2^32)')
  const fontId = spec.font ?? def.font
  if (!(def.fonts ?? ALL_FONTS).includes(fontId))
    throw new Error(`preset ${def.id} does not support font ${fontId}`)

  // 1. Vector page.
  const doc = await PDFDocument.create({ updateMetadata: false })
  const { width: W, height: H } = def.page
  const page = doc.addPage([W, H])
  const font = await embed(doc, fontId, deps)
  const { vMetrics, advance, assertCovers } = measureFont(font, fontId, deps)
  const rng = createRng(spec.seed, 'layout')
  const srcWords: { t: string; line: number; srcBox: Box }[] = []
  const lines: GtLine[] = []
  const ctx: LayoutContext = {
    page,
    width: W,
    height: H,
    font,
    fontId,
    rng,
    bankWords: () => shuffled(SAMPLE_SENTENCES, rng).join(' ').split(' '),
    wrap: (ws, maxWidth, size) => {
      // The same measure `line` advances by: each word's own width plus one space between words.
      const space = advance(' ', size)
      const out: string[][] = []
      let cur: string[] = []
      let curW = 0
      for (const w of ws) {
        const ww = advance(w.normalize('NFC'), size)
        if (cur.length > 0 && curW + space + ww > maxWidth) {
          out.push(cur)
          cur = [w]
          curW = ww
        } else {
          curW = cur.length > 0 ? curW + space + ww : ww
          cur = [...cur, w]
        }
      }
      if (cur.length > 0) out.push(cur)
      return out
    },
    line: (ws, x, baseline, size) => {
      const { ascent, descent } = vMetrics(size)
      const space = advance(' ', size)
      const li = lines.length
      const idx: number[] = []
      let cx = x
      for (const raw of ws) {
        const t = raw.normalize('NFC')
        assertCovers(t)
        const w = advance(t, size)
        page.drawText(t, { x: cx, y: baseline, size, font, color: rgb(0, 0, 0) })
        idx.push(srcWords.length)
        srcWords.push({
          t,
          line: li,
          srcBox: { x: cx, y: baseline - descent, w, h: ascent + descent }
        })
        cx += w + space
      }
      lines.push({
        words: idx,
        text: ws.map((s) => s.normalize('NFC')).join(' '),
        size,
        baseline,
        font: fontId
      })
    },
    verticalLine: (ws, bx, y, size, rotate) => {
      const { ascent, descent } = vMetrics(size)
      const space = advance(' ', size)
      const li = lines.length
      const idx: number[] = []
      let cy = y
      for (const raw of ws) {
        const t = raw.normalize('NFC')
        assertCovers(t)
        const w = advance(t, size)
        page.drawText(t, { x: bx, y: cy, size, font, color: rgb(0, 0, 0), rotate: degrees(rotate) })
        idx.push(srcWords.length)
        // Turned +90°, glyph tops point to −x and the advance runs up; turned −90°, the reverse.
        srcWords.push({
          t,
          line: li,
          srcBox:
            rotate === 90
              ? { x: bx - ascent, y: cy, w: ascent + descent, h: w }
              : { x: bx - descent, y: cy - w, w: ascent + descent, h: w }
        })
        cy += rotate === 90 ? w + space : -(w + space)
      }
      lines.push({
        words: idx,
        text: ws.map((s) => s.normalize('NFC')).join(' '),
        size,
        baseline: bx,
        font: fontId,
        rotate
      })
    },
    rule: (x1, y1, x2, y2, thickness = 0.75) =>
      page.drawLine({
        start: { x: x1, y: y1 },
        end: { x: x2, y: y2 },
        thickness,
        color: rgb(0, 0, 0)
      }),
    ascent: (size) => vMetrics(size).ascent,
    descent: (size) => vMetrics(size).descent
  }
  def.layout(ctx)
  const vectorPdf = await doc.save()

  // 2. Rasterise.
  const clean = deps.rasterize(vectorPdf, def.renderDpi)
  const s = def.renderDpi / 72
  const ew = (W * def.renderDpi) / 72
  const eh = (H * def.renderDpi) / 72
  if (!Number.isInteger(ew) || !Number.isInteger(eh))
    throw new Error(`page ${W}x${H} pt is not a whole number of pixels at ${def.renderDpi} dpi`)
  if (clean.width !== ew || clean.height !== eh)
    throw new Error(`raster is ${clean.width}x${clean.height}, expected ${ew}x${eh}`)

  // 3. Degrade, tracking the pixel map.
  let st: OpState = { image: clean, dpi: def.renderDpi, px: [1, 0, 0, 1, 0, 0] }
  def.ops.forEach((op, i) => {
    st = applyOp(st, op, createRng(spec.seed, `op${i}:${op.op}`), deps)
  })
  const raster = st.image
  const t = 72 / st.dpi
  const imagePage = { width: (raster.width * 72) / st.dpi, height: (raster.height * 72) / st.dpi }
  // source pt (bottom-left) → source px (top-left) → … → output px → output pt (bottom-left).
  const toPx: Affine = [s, 0, 0, -s, 0, eh]
  const fromPx: Affine = [t, 0, 0, -t, 0, imagePage.height]
  let toOutput = composeAffine(composeAffine(toPx, st.px), fromPx)
  let pageOut = imagePage
  let dpiOut = st.dpi
  let placement: Placement | undefined
  if (def.place) {
    // imageToPdf's fit: scale = min(page / image) on both axes, centred.
    const k = Math.min(def.place.width / imagePage.width, def.place.height / imagePage.height)
    const w = imagePage.width * k
    const h = imagePage.height * k
    placement = {
      page: def.place,
      x: (def.place.width - w) / 2,
      y: (def.place.height - h) / 2,
      w,
      h
    }
    toOutput = composeAffine(toOutput, [k, 0, 0, k, placement.x, placement.y])
    pageOut = { ...def.place }
    dpiOut = st.dpi / k
  }

  // 4. GT.
  const words: GtWord[] = srcWords.map((w, order) => {
    const mapped = mapBox(toOutput, w.srcBox)
    const srcInk = inkBox(clean, w.srcBox, H, s)
    return {
      t: w.t,
      line: w.line,
      order,
      box: mapped.box,
      quad: mapped.quad,
      srcBox: w.srcBox,
      srcInk,
      ink: srcInk ? mapBox(toOutput, srcInk).box : null
    }
  })
  const gt: SynthGt = {
    v: 1,
    preset: def.id,
    seed: spec.seed,
    font: fontId,
    dpi: dpiOut,
    renderDpi: def.renderDpi,
    page: pageOut,
    sourcePage: { width: W, height: H },
    raster: { width: raster.width, height: raster.height },
    toOutput,
    ops: def.ops.map((op) => ({ ...op })) as DegradeOp[],
    text: lines.map((l) => l.text).join('\n'),
    lines,
    words
  }

  // 5. Re-wrap as a scan.
  const pdfBytes = await scannedPdf(raster, st.dpi, placement)
  return { pdfBytes, raster, clean, vectorPdf, gt }
}
