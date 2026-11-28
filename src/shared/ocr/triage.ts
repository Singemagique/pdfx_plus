// Page triage, the pure half (DESIGN.md §3.4.1, §3.4.3): the page classifier over the per-page
// signals the raster thread gathers with PDFium (src/main/ocr/process/triage-pdfium.ts), the render
// DPI table, the JPX `SIZ` pre-check and the small geometry helpers they share. No PDFium here, no
// I/O: every rule is a function of plain numbers, so the thresholds are unit-tested exactly.
//
// DOM-free and Electron-free (src/shared): the utility process's raster thread, the renderer and
// vitest Node import the same file.

import type { OcrRect } from './types'
import type { PageClass } from './types'

// ---------------------------------------------------------------------------------------------
// The image-origin marker (§3.4.1): imageToPdf (renderer pdfx/images.ts) writes both parts itself,
// so every import path carries it.

/** The document Producer of a PDF that PDFx made from an imported image. */
export const IMAGE_IMPORT_PRODUCER = 'PDFx image import'
/** The marked-content tag the imported image is drawn inside (`/PDFxImportedImage BMC … EMC`). */
export const IMPORTED_IMAGE_MARK = 'PDFxImportedImage'

// ---------------------------------------------------------------------------------------------
// The result the raster thread sends back for one page (crosses the port; see protocol.ts).

/** A visible native word on a `near-scanned` or `ocr-ours` page, for Find merging (§3.6.1). */
export interface NativeWord {
  /** The word's text (PDFium's Unicode for its chars; never empty). */
  t: string
  /** Union of its char boxes, overlay frame (pt, bottom-left origin, intrinsic /Rotate applied). */
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Why a page cannot be recognised as it stands (machine-readable; the UI picks the copy). */
export type JpxRefusal =
  | 'jpx-malformed' // no readable SIZ marker
  | 'jpx-subsampled' // a component has XRsiz/YRsiz ≠ 1 (PDFium decodes these wrongly, PR0)
  | 'jpx-components' // component count ≠ the colour space's (PDFium traps on these, PR0)
  | 'jpx-no-colour-space' // neither the PDF nor the JP2 header names a colour space
  // More objects, or deeper Form nesting, than triage walks: its images were not all checked, and
  // PDFium would still parse and decode them.
  | 'too-complex'

/** Why triage could not classify a page (see `TriagePage.failure`). */
export type TriageFailure = 'page-missing' | 'render' | 'too-large' | 'raster-crash'

export interface TriagePage {
  /** 0-based page index in the source. */
  index: number
  /** The §3.4.1 class; null when triage could not read the page at all (`failure` says why). */
  pageClass: PageClass | null
  /**
   * Set when the page could not be triaged: 'page-missing'; 'render' (PDFium refused the page, or
   * the thread's result failed validation); 'too-large' (the pixel caps would leave it under 1 DPI:
   * a recognize request for it ends `too-large` without a render); 'raster-crash' (it killed the
   * raster thread twice, or its source's triage was cut off).
   */
  failure?: TriageFailure
  /** Set when the page must not be rendered by PDFium (the JPX pre-check refused an image). */
  refused?: JpxRefusal
  /** The final render DPI after every cap (§3.4.3), or null for protected / failed pages. */
  renderDpi: number | null
  /** The raster size at `renderDpi` (px), or null. */
  raster: { width: number; height: number } | null
  /** The dominant image's effective density `d_eff` (px per inch of page), or null if none. */
  effectiveDpi: number | null
  /** The dominant image's bits per pixel (FPDFImageObj_GetImageMetadata), when read; else null. */
  bitsPerPixel: number | null
  /** An image on the page carries the `/PDFxImportedImage` mark (PDFx made it from a photo). */
  imageOrigin: boolean
  /** Visible native words, on `near-scanned` and `ocr-ours` pages only. */
  nativeWords?: NativeWord[]
}

// ---------------------------------------------------------------------------------------------
// The classifier (§3.4.1).

/** How broken the page's text looks: counts over every counted (non-whitespace) character. */
export interface TextQuality {
  /** Chars PDFium flags with FPDFText_HasUnicodeMapError (= 1): no Unicode for the char code. */
  mapErrors: number
  /** Chars that are no real text: U+0000, U+FFFD, C0/C1 controls, private use. */
  badChars: number
  /** Letters (\p{L}) among the counted chars. */
  letters: number
  /** Basic Latin letters (A–Z, a–z) among them. */
  latinLetters: number
  /** Latin vowels (a e i o u y, either case) among those. */
  latinVowels: number
}

export interface PageSignals {
  /** FPDF_GetSecurityHandlerRevision ≠ −1: the source is encrypted (every page `protected`). */
  encrypted: boolean
  /** Painted non-whitespace chars (render mode ≠ 3/7, not a glyphless OCR font, not generated). */
  visible: number
  /** Unpainted non-whitespace chars (render mode 3 or 7, or a GlyphLessFont/Occulta font). */
  invisible: number
  /** Union of the image bounds ∩ the page, over the page area (0..1). */
  cov: number
  /** Union of the visible char boxes ∩ the page, over the page area (0..1). */
  textArea: number
  /** Height of the smallest horizontal band holding every visible char, over the page height. */
  band: number
  /** A text object carries our `/PDFxOCR` marked-content tag. */
  pdfxOcrMark: boolean
  /** A char's font is our `PDFxOCR-GlyphLess`. */
  pdfxOcrFont: boolean
  quality: TextQuality
}

/** Every threshold of the classifier, in one place (tuned on the PR4b fixtures). */
export const TRIAGE_THRESHOLDS = {
  /** Image coverage that makes a text-free page `scanned` rather than `blank`. */
  scannedCov: 0.05,
  /** Share of invisible chars, and coverage, that make a page `ocr-foreign`. */
  foreignInvisibleShare: 0.8,
  foreignCov: 0.5,
  /** Coverage of a `near-scanned` page, and its three "the text is only a stamp" tests. */
  nearScannedCov: 0.75,
  nearScannedTextArea: 0.03,
  nearScannedVisible: 40,
  nearScannedBand: 0.1,
  /**
   * A page that passes the near-scanned tests but carries at least this many invisible chars is
   * another tool's OCR under a stamp or header (`ocr-foreign`, D5), not a scan to recognise again.
   */
  nearScannedForeignInvisible: 40,
  /** Coverage below which a page with text is plain `text` rather than `mixed`. */
  mixedCov: 0.1,
  /** Broken text: judged only with at least this many counted chars. */
  brokenMinChars: 20,
  /** Share of FPDFText_HasUnicodeMapError chars, or of bad chars, that makes text broken. */
  brokenMapErrorShare: 0.1,
  brokenBadCharShare: 0.1,
  /** The vowel test runs only on mostly-Latin text with at least this many Latin letters. */
  brokenMinLatinLetters: 40,
  brokenLatinShare: 0.8,
  /** Natural Latin-script text sits far inside this vowel ratio (English ≈ 0.38–0.42). */
  brokenVowelMin: 0.15,
  brokenVowelMax: 0.75
} as const

const T = TRIAGE_THRESHOLDS

/**
 * Does the page's text layer look broken (a bad ToUnicode, a font with garbage code points)? The
 * vowel ratio is script-gated: it only judges text that is mostly basic Latin letters, since other
 * scripts (and numbers, codes) have no vowels to count.
 */
export function isBrokenText(s: Pick<PageSignals, 'visible' | 'invisible' | 'quality'>): boolean {
  const n = s.visible + s.invisible
  if (n < T.brokenMinChars) return false
  const q = s.quality
  if (q.mapErrors >= T.brokenMapErrorShare * n) return true
  if (q.badChars >= T.brokenBadCharShare * n) return true
  if (
    q.latinLetters >= T.brokenMinLatinLetters &&
    q.latinLetters >= T.brokenLatinShare * q.letters
  ) {
    const r = q.latinVowels / q.latinLetters
    if (r < T.brokenVowelMin || r > T.brokenVowelMax) return true
  }
  return false
}

/** The §3.4.1 page class, exactly in the design's order. */
export function classifyPage(s: PageSignals): PageClass {
  if (s.encrypted) return 'protected'
  if (s.pdfxOcrMark || s.pdfxOcrFont) return 'ocr-ours'
  const total = s.visible + s.invisible
  if (total === 0) return s.cov >= T.scannedCov ? 'scanned' : 'blank'
  if (s.invisible >= T.foreignInvisibleShare * total && s.cov >= T.foreignCov) return 'ocr-foreign'
  if (isBrokenText(s)) return 'broken-text'
  if (
    s.cov >= T.nearScannedCov &&
    (s.textArea < T.nearScannedTextArea ||
      s.visible < T.nearScannedVisible ||
      s.band <= T.nearScannedBand)
  )
    // Bates no., fax header, DMS stamp. The visible text being only a stamp says nothing about an
    // invisible layer under it: a substantial one is already searchable text (D5), and OCR on top
    // would make Find return every word twice. (An addition to the §3.4.1 pseudo-code.)
    return s.invisible >= T.nearScannedForeignInvisible ? 'ocr-foreign' : 'near-scanned'
  if (s.cov >= T.mixedCov) return 'mixed'
  return 'text'
}

/** Pages whose visible native words triage returns for Find merging (§3.4.1). */
export const wantsNativeWords = (c: PageClass | null): boolean =>
  c === 'near-scanned' || c === 'ocr-ours'

/** Base font names (subset prefix "ABCDEF+" stripped) of glyphless OCR fonts from other tools. */
const FOREIGN_GLYPHLESS = /^(?:GlyphLessFont|Occulta)/i

/** Strip a font subset tag ("ABCDEF+Name" → "Name"). */
export function baseFontCore(name: string): string {
  return /^[A-Z]{6}\+/.test(name) ? name.slice(7) : name
}

/** A font that paints nothing even in render mode 0: Tesseract's GlyphLessFont, OCRmyPDF's Occulta. */
export const isForeignGlyphlessFont = (name: string): boolean =>
  FOREIGN_GLYPHLESS.test(baseFontCore(name))

/** What counts as a bad (non-text) char for `TextQuality.badChars`. */
export function isBadChar(cp: number): boolean {
  return (
    cp === 0 ||
    cp === 0xfffd ||
    (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0xe000 && cp <= 0xf8ff) ||
    cp >= 0xf0000
  )
}

const LETTER = /\p{L}/u
const LATIN = /[A-Za-z]/
const VOWEL = /[aeiouyAEIOUY]/

/** Add one counted (non-whitespace) char to a quality tally. */
export function tallyChar(q: TextQuality, cp: number, mapError: boolean): void {
  if (mapError) q.mapErrors++
  if (isBadChar(cp)) {
    q.badChars++
    return
  }
  const ch = String.fromCodePoint(cp)
  if (!LETTER.test(ch)) return
  q.letters++
  if (LATIN.test(ch)) {
    q.latinLetters++
    if (VOWEL.test(ch)) q.latinVowels++
  }
}

export const emptyQuality = (): TextQuality => ({
  mapErrors: 0,
  badChars: 0,
  letters: 0,
  latinLetters: 0,
  latinVowels: 0
})

/** Unicode whitespace (and the zero-width ones PDFium and pdf.js emit between words). */
export function isSpaceChar(cp: number): boolean {
  return (
    cp === 0x20 ||
    (cp >= 0x09 && cp <= 0x0d) ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200b) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000 ||
    cp === 0xfeff
  )
}

// ---------------------------------------------------------------------------------------------
// Geometry.

/** PDF matrix [a b c d e f] (row vectors: [x y 1] · M). */
export type Matrix6 = [number, number, number, number, number, number]

export const IDENTITY: Matrix6 = [1, 0, 0, 1, 0, 0]

/** m then n: the matrix of applying `m` first, then `n` (PDF row-vector order, m × n). */
export function mulMatrix(m: Matrix6, n: Matrix6): Matrix6 {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5]
  ]
}

/** The axis-aligned bounds of the unit square under `m` (an image's placement). */
export function unitSquareBounds(m: Matrix6): OcrRect {
  const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]]
  const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]]
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

/** Placed area (pt²) of the unit square under `m`: |det|. */
export const placedArea = (m: Matrix6): number => Math.abs(m[0] * m[3] - m[1] * m[2])

/**
 * The effective pixel density of an image of `px` pixels placed by the full CTM `m` (§3.4.1):
 * `max(pxW / (|placedW| / 72), pxH / (|placedH| / 72))`, where placedW/H are the lengths of the
 * transformed unit-square edges in pt. Max of x and y, so a 200×100 dpi fax gives 200. Null for a
 * degenerate placement.
 */
export function effectiveDpi(px: { width: number; height: number }, m: Matrix6): number | null {
  const placedW = Math.hypot(m[0], m[1])
  const placedH = Math.hypot(m[2], m[3])
  if (!(placedW > 0) || !(placedH > 0) || !(px.width > 0) || !(px.height > 0)) return null
  const d = Math.max(px.width / (placedW / 72), px.height / (placedH / 72))
  return Number.isFinite(d) ? d : null
}

function clip(r: OcrRect, c: OcrRect | undefined): OcrRect | null {
  const x0 = c ? Math.max(r.x0, c.x0) : r.x0
  const y0 = c ? Math.max(r.y0, c.y0) : r.y0
  const x1 = c ? Math.min(r.x1, c.x1) : r.x1
  const y1 = c ? Math.min(r.y1, c.y1) : r.y1
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null
}

/**
 * The exact area of the union of `rects` (optionally clipped to `clipTo`), by a sweep over x with a
 * segment tree over the compressed y coordinates (covered length per node). O(n log n) whatever
 * the layout: a crafted page of millions of overlapping char boxes costs no more than a plain one.
 */
export function unionArea(rects: readonly OcrRect[], clipTo?: OcrRect): number {
  const rs: OcrRect[] = []
  for (const r of rects) {
    const c = clip(r, clipTo)
    if (c) rs.push(c)
  }
  const n = rs.length
  if (n === 0) return 0
  const ysAll = new Float64Array(2 * n)
  for (let i = 0; i < n; i++) {
    ysAll[2 * i] = rs[i].y0
    ysAll[2 * i + 1] = rs[i].y1
  }
  ysAll.sort()
  let m = 0
  for (let i = 0; i < ysAll.length; i++)
    if (i === 0 || ysAll[i] !== ysAll[m - 1]) ysAll[m++] = ysAll[i]
  const ys = ysAll.subarray(0, m)
  const segs = m - 1 // elementary y intervals [ys[k], ys[k + 1])
  if (segs <= 0) return 0
  const yIndex = (y: number): number => {
    let lo = 0
    let hi = m - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (ys[mid] < y) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  const count = new Int32Array(4 * segs)
  const covered = new Float64Array(4 * segs)
  const update = (node: number, l: number, r: number, a: number, b: number, d: number): void => {
    if (b <= l || r <= a) return
    if (a <= l && r <= b) count[node] += d
    else {
      const mid = (l + r) >> 1
      update(2 * node, l, mid, a, b, d)
      update(2 * node + 1, mid, r, a, b, d)
    }
    covered[node] =
      count[node] > 0 ? ys[r] - ys[l] : r - l === 1 ? 0 : covered[2 * node] + covered[2 * node + 1]
  }
  // Events: rect i opens at x0 (+1) and closes at x1 (−1), sorted by x.
  const order = new Uint32Array(2 * n)
  for (let i = 0; i < 2 * n; i++) order[i] = i
  const xOf = (e: number): number => (e & 1 ? rs[e >> 1].x1 : rs[e >> 1].x0)
  order.sort((p, q) => xOf(p) - xOf(q))
  const lo = new Int32Array(n)
  const hi = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    lo[i] = yIndex(rs[i].y0)
    hi[i] = yIndex(rs[i].y1)
  }
  let area = 0
  let prevX = xOf(order[0])
  for (let k = 0; k < order.length; ) {
    const x = xOf(order[k])
    area += covered[1] * (x - prevX)
    for (; k < order.length && xOf(order[k]) === x; k++) {
      const e = order[k]
      const i = e >> 1
      update(1, 0, segs, lo[i], hi[i], e & 1 ? -1 : 1)
    }
    prevX = x
  }
  return area
}

/** The unit square under `m` as a quadrilateral (user space). */
function placedQuad(m: Matrix6): [number, number][] {
  return [
    [m[4], m[5]],
    [m[0] + m[4], m[1] + m[5]],
    [m[0] + m[2] + m[4], m[1] + m[3] + m[5]],
    [m[2] + m[4], m[3] + m[5]]
  ]
}

/** Sutherland–Hodgman: a convex polygon clipped to an axis-aligned rectangle. */
function clipToRect(poly: [number, number][], c: OcrRect): [number, number][] {
  let out = poly
  const edges: Array<[(p: [number, number]) => number, number, 0 | 1]> = [
    [(p) => p[0] - c.x0, c.x0, 0],
    [(p) => c.x1 - p[0], c.x1, 0],
    [(p) => p[1] - c.y0, c.y0, 1],
    [(p) => c.y1 - p[1], c.y1, 1]
  ]
  for (const [inside, at, axis] of edges) {
    const src = out
    out = []
    for (let i = 0; i < src.length; i++) {
      const p = src[i]
      const q = src[(i + 1) % src.length]
      const ip = inside(p) >= 0
      const iq = inside(q) >= 0
      if (ip) out.push(p)
      if (ip !== iq) {
        const t = (at - p[axis]) / (q[axis] - p[axis])
        out.push(axis === 0 ? [at, p[1] + t * (q[1] - p[1])] : [p[0] + t * (q[0] - p[0]), at])
      }
    }
    if (out.length === 0) break
  }
  return out
}

function polygonArea(poly: [number, number][]): number {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i]
    const [x1, y1] = poly[(i + 1) % poly.length]
    a += x0 * y1 - x1 * y0
  }
  return Math.abs(a) / 2
}

/**
 * The page area (pt²) the images placed by `placements` cover inside `box` (§3.4.1's
 * union(image bounds) ∩ page). "Image bounds" are the placed parallelograms, not their axis-aligned
 * boxes, which would overstate a 45° image twofold: exact for axis-aligned images (their union) and
 * for images that do not overlap (the sum of the clipped parallelograms); for overlapping rotated
 * or skewed images, the smaller of those two upper bounds.
 */
export function imageCoverage(placements: readonly Matrix6[], box: OcrRect): number {
  const boxes: OcrRect[] = []
  let exactSum = 0
  let allAligned = true
  for (const m of placements) {
    const b = clip(unitSquareBounds(m), box)
    if (!b) continue
    boxes.push(b)
    const aligned = (m[1] === 0 && m[2] === 0) || (m[0] === 0 && m[3] === 0)
    if (aligned) exactSum += (b.x1 - b.x0) * (b.y1 - b.y0)
    else {
      allAligned = false
      exactSum += polygonArea(clipToRect(placedQuad(m), box))
    }
  }
  if (boxes.length === 0) return 0
  const union = unionArea(boxes)
  return allAligned ? union : Math.min(union, exactSum)
}

/**
 * Two placed areas closer than this (relative) are a tie for the dominant image: float32 matrices
 * make two full-page layers differ by a few ulps.
 */
export const DOMINANT_TIE = 0.02

/**
 * The dominant image (§3.4.1: the largest placed area). A near-tie goes to the higher effective
 * density, so on a mixed-raster-content scan (a low-resolution colour or grey background and a
 * full-resolution 1-bit foreground, both full-page) the foreground's density and bit depth drive
 * the render, whichever layer is drawn first. Ties after that go to the first drawn. `density` is
 * asked only for the tied candidates (it reads pixel sizes).
 */
export function pickDominant<T>(
  images: readonly T[],
  area: (im: T) => number,
  density: (im: T) => number | null
): T | null {
  if (images.length === 0) return null
  const areas = images.map(area)
  let max = 0
  for (const a of areas) if (a > max) max = a
  let best: T | null = null
  let bestDensity = -Infinity
  let tied = 0
  for (let i = 0; i < images.length; i++) {
    if (!(areas[i] >= max * (1 - DOMINANT_TIE))) continue
    if (best === null) best = images[i]
    // Bound the pixel-size reads on a crafted page of thousands of identical full-page images.
    if (++tied > 64) break
    const d = density(images[i]) ?? -1
    if (d > bestDensity) {
      bestDensity = d
      best = images[i]
    }
  }
  return best
}

/** The page's view box (CropBox ∩ MediaBox) in user space and its intrinsic quarter turns. */
export interface PageFrame {
  box: OcrRect
  /** Clockwise quarter turns of /Rotate (FPDFPage_GetRotation: 0..3). */
  quarterTurns: number
}

/**
 * A user-space rectangle → the overlay frame (§3.5.1: intrinsic /Rotate applied, origin at the
 * view box's lower-left corner, y up, pt). /Rotate turns the page clockwise.
 */
export function toOverlayFrame(r: OcrRect, f: PageFrame): OcrRect {
  const { x0: L, y0: B, x1: R, y1: T } = f.box
  const pts: [number, number][] = [
    [r.x0, r.y0],
    [r.x1, r.y1]
  ]
  const mapped = pts.map(([x, y]): [number, number] => {
    switch (((f.quarterTurns % 4) + 4) % 4) {
      case 1:
        return [y - B, R - x]
      case 2:
        return [R - x, T - y]
      case 3:
        return [T - y, x - L]
      default:
        return [x - L, y - B]
    }
  })
  return {
    x0: Math.min(mapped[0][0], mapped[1][0]),
    y0: Math.min(mapped[0][1], mapped[1][1]),
    x1: Math.max(mapped[0][0], mapped[1][0]),
    y1: Math.max(mapped[0][1], mapped[1][1])
  }
}

/**
 * Height of the smallest horizontal band (in the overlay frame, i.e. as the page is shown) that
 * holds every rectangle, over the shown page height. 0 when there is nothing.
 */
export function bandFraction(rects: readonly OcrRect[], f: PageFrame): number {
  if (rects.length === 0) return 0
  let lo = Infinity
  let hi = -Infinity
  for (const r of rects) {
    const o = toOverlayFrame(r, f)
    lo = Math.min(lo, o.y0)
    hi = Math.max(hi, o.y1)
  }
  const turned = ((f.quarterTurns % 4) + 4) % 4
  const shownH = turned % 2 === 1 ? f.box.x1 - f.box.x0 : f.box.y1 - f.box.y0
  if (!(shownH > 0)) return 0
  return Math.min(1, Math.max(0, (Math.min(hi, shownH) - Math.max(lo, 0)) / shownH))
}

// ---------------------------------------------------------------------------------------------
// DPI selection (§3.4.3).

export interface PixelCaps {
  /** Long side of the raster, px (A4 at 600 DPI is 7,016). */
  maxLongSide: number
  /** Raster area, px. */
  maxPixels: number
}

export const PIXEL_CAPS: PixelCaps = { maxLongSide: 7200, maxPixels: 36_000_000 }

export const DPI_RULES = {
  /** Scanned and near-scanned pages: clamp(d_eff, 300, 400). */
  scan: { min: 300, max: 400 },
  /** Pages with the /PDFxImportedImage mark: clamp(d_eff, 300, 600), then the upsample cap. */
  imageOrigin: { min: 300, max: 600 },
  /** No dominant image (a vector-only "scan"). */
  fallback: 300,
  /** Image-origin pages never render the image above this many times its native pixels. */
  maxUpsample: 2
} as const

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * The DPI and size a page renders at once the pixel caps are applied (DPI only ever goes down).
 * The same function the raster thread renders with (raster-core.ts re-exports it).
 */
export function fitRaster(
  widthPt: number,
  heightPt: number,
  dpi: number,
  limits: PixelCaps
): { dpi: number; width: number; height: number } {
  const size = (d: number): { width: number; height: number } => ({
    width: Math.max(1, Math.round((widthPt * d) / 72)),
    height: Math.max(1, Math.round((heightPt * d) / 72))
  })
  let d = dpi
  let s = size(d)
  const over = (): boolean =>
    Math.max(s.width, s.height) > limits.maxLongSide || s.width * s.height > limits.maxPixels
  if (over()) {
    const k = Math.min(
      limits.maxLongSide / Math.max(s.width, s.height),
      Math.sqrt(limits.maxPixels / (s.width * s.height))
    )
    d = Math.floor(dpi * k * 100) / 100
    s = size(d)
    // Rounding can land one pixel over; step down until it fits.
    while (over() && d > 1) {
      d = Math.floor((d - 0.01) * 100) / 100
      s = size(d)
    }
  }
  return { dpi: d, ...s }
}

export interface DpiInput {
  /** The render frame (the PDFium page size, intrinsic /Rotate applied), pt. */
  page: { width: number; height: number }
  /** The dominant image's effective density, or null when the page has no image. */
  dEff: number | null
  /** The page carries the /PDFxImportedImage mark. */
  imageOrigin: boolean
  caps?: PixelCaps
}

export interface DpiChoice {
  /** The FINAL DPI after every cap: what goes into user_defined_dpi, the mapping and OcrPage. */
  renderDpi: number
  width: number
  height: number
  rule: 'scan' | 'image-origin' | 'fallback'
  /** Which caps lowered it. */
  capped: Array<'upsample' | 'pixels'>
}

/**
 * The render DPI of §3.4.3, always from the dominant image's effective density, never from how the
 * page was made: `clamp(d_eff, 300, 400)` for scans; `clamp(d_eff, 300, 600)` capped at 2 × d_eff
 * for image-origin pages (so pixels are neither thrown away nor invented beyond 2×); 300 without an
 * image; then the pixel caps. DPIs are kept to 0.01.
 */
export function selectRenderDpi(input: DpiInput): DpiChoice {
  const caps = input.caps ?? PIXEL_CAPS
  const capped: DpiChoice['capped'] = []
  const dEff =
    input.dEff !== null && Number.isFinite(input.dEff) && input.dEff > 0 ? input.dEff : null
  let rule: DpiChoice['rule']
  let dpi: number
  if (dEff === null) {
    rule = 'fallback'
    dpi = DPI_RULES.fallback
  } else if (input.imageOrigin) {
    rule = 'image-origin'
    dpi = clamp(dEff, DPI_RULES.imageOrigin.min, DPI_RULES.imageOrigin.max)
    const limit = DPI_RULES.maxUpsample * dEff
    if (dpi > limit) {
      dpi = limit
      capped.push('upsample')
    }
  } else {
    rule = 'scan'
    dpi = clamp(dEff, DPI_RULES.scan.min, DPI_RULES.scan.max)
  }
  dpi = Math.round(dpi * 100) / 100
  const fit = fitRaster(input.page.width, input.page.height, dpi, caps)
  if (fit.dpi < dpi) capped.push('pixels')
  return { renderDpi: fit.dpi, width: fit.width, height: fit.height, rule, capped }
}

// ---------------------------------------------------------------------------------------------
// JPX pre-check (§3.4.1, from PR0's codec results).

export interface JpxInfo {
  /** Csiz: the codestream's component count. */
  components: number
  width: number
  height: number
  /** Bit depth of component 0 (Ssiz & 0x7f) + 1. */
  bitsPerComponent: number
  /** Every component's (XRsiz, YRsiz). */
  subsampling: Array<[number, number]>
  /** The JP2 `colr` box's colour space component count, when the data is a JP2 file with one. */
  jp2ColourComponents: number | null
}

const be16 = (d: Uint8Array, i: number): number => (d[i] << 8) | d[i + 1]
const be32 = (d: Uint8Array, i: number): number =>
  ((d[i] << 24) >>> 0) + (d[i + 1] << 16) + (d[i + 2] << 8) + d[i + 3]

/** ICC profile colour space signature → component count. */
const ICC_COMPONENTS: Record<string, number> = {
  GRAY: 1,
  'RGB ': 3,
  'Lab ': 3,
  'XYZ ': 3,
  YCbr: 3,
  CMYK: 4
}

/** JP2 `colr` EnumCS → component count (ISO 15444-1 Table I.10, plus the 15444-2 common ones). */
const ENUMCS_COMPONENTS: Record<number, number> = {
  12: 4, // CMYK
  14: 3, // CIELab
  16: 3, // sRGB
  17: 1, // greyscale
  18: 3, // sYCC
  20: 3, // e-sRGB
  21: 3, // ROMM-RGB
  24: 3 // e-sYCC
}

function parseSiz(d: Uint8Array, at: number): Omit<JpxInfo, 'jp2ColourComponents'> | null {
  if (at + 42 > d.length) return null
  if (be16(d, at) !== 0xff4f || be16(d, at + 2) !== 0xff51) return null
  const lsiz = be16(d, at + 4)
  const width = be32(d, at + 8) - be32(d, at + 16)
  const height = be32(d, at + 12) - be32(d, at + 20)
  const csiz = be16(d, at + 40)
  if (csiz < 1 || csiz > 16384 || lsiz !== 38 + 3 * csiz) return null
  if (at + 42 + 3 * csiz > d.length) return null
  const subsampling: Array<[number, number]> = []
  for (let i = 0; i < csiz; i++) {
    const p = at + 42 + 3 * i
    subsampling.push([d[p + 1], d[p + 2]])
  }
  return {
    components: csiz,
    width,
    height,
    bitsPerComponent: (d[at + 42] & 0x7f) + 1,
    subsampling
  }
}

interface Box {
  type: string
  start: number // payload start
  end: number
}

function boxes(d: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = []
  let p = from
  while (p + 8 <= to && out.length < 256) {
    let len = be32(d, p)
    const type = String.fromCharCode(d[p + 4], d[p + 5], d[p + 6], d[p + 7])
    let start = p + 8
    if (len === 1) {
      if (p + 16 > to) break
      // XLBox: 64-bit; anything over 2^53 is not a real file here.
      len = be32(d, p + 8) * 2 ** 32 + be32(d, p + 12)
      start = p + 16
    } else if (len === 0) len = to - p
    if (len < start - p || p + len > to) break
    out.push({ type, start, end: p + len })
    p += len
  }
  return out
}

/** Read the codestream's SIZ (from a raw `.j2k` stream or a JP2 file) and the JP2 colour space. */
export function readJpx(data: Uint8Array): JpxInfo | null {
  const isJp2 =
    data.length >= 12 &&
    be32(data, 0) === 12 &&
    data[4] === 0x6a &&
    data[5] === 0x50 &&
    data[6] === 0x20 &&
    data[7] === 0x20
  if (!isJp2) {
    const siz = parseSiz(data, 0)
    return siz ? { ...siz, jp2ColourComponents: null } : null
  }
  let colour: number | null = null
  let siz: Omit<JpxInfo, 'jp2ColourComponents'> | null = null
  for (const b of boxes(data, 0, data.length)) {
    if (b.type === 'jp2h') {
      for (const c of boxes(data, b.start, b.end)) {
        if (c.type !== 'colr' || colour !== null || c.end - c.start < 3) continue
        const meth = data[c.start]
        if (meth === 1 && c.end - c.start >= 7)
          colour = ENUMCS_COMPONENTS[be32(data, c.start + 3)] ?? null
        else if ((meth === 2 || meth === 3) && c.end - c.start >= 3 + 20) {
          const p = c.start + 3 + 16
          const sig = String.fromCharCode(data[p], data[p + 1], data[p + 2], data[p + 3])
          colour = ICC_COMPONENTS[sig] ?? null
        }
      }
    } else if (b.type === 'jp2c') {
      siz = parseSiz(data.subarray(0, b.end), b.start)
      break
    }
  }
  return siz ? { ...siz, jp2ColourComponents: colour } : null
}

export type JpxCheck = { ok: true; info: JpxInfo } | { ok: false; reason: JpxRefusal }

/**
 * The SIZ pre-check: refuse a JPX image PDFium would decode wrongly (any component subsampled) or
 * trap on (component count ≠ the colour space's). The colour space is the PDF image's /ColorSpace
 * (`pdfColourComponents`, null when the dictionary has none) or else the JP2 `colr` box; with
 * neither, the image is refused.
 */
export function jpxPrecheck(data: Uint8Array, pdfColourComponents: number | null): JpxCheck {
  const info = readJpx(data)
  if (!info) return { ok: false, reason: 'jpx-malformed' }
  if (info.subsampling.some(([x, y]) => x !== 1 || y !== 1))
    return { ok: false, reason: 'jpx-subsampled' }
  const want = pdfColourComponents ?? info.jp2ColourComponents
  if (want === null) return { ok: false, reason: 'jpx-no-colour-space' }
  if (want !== info.components) return { ok: false, reason: 'jpx-components' }
  return { ok: true, info }
}

// ---------------------------------------------------------------------------------------------
// The image's /ColorSpace from the file bytes (PDFium has no accessor that does not decode the
// image, and decoding is exactly what traps; §3.4.1).

/** A byte-search over the source: index of `needle` at or after `from`, or −1. */
export type ByteFind = (needle: Uint8Array, from: number) => number

/** A plain `ByteFind` over `file` (native indexOf for the first byte, then a compare). */
export function makeByteFind(file: Uint8Array): ByteFind {
  return (needle, from) => {
    const n = needle.length
    if (n === 0) return from <= file.length ? from : -1
    const first = needle[0]
    for (let i = file.indexOf(first, from); i >= 0 && i + n <= file.length; ) {
      let j = 1
      while (j < n && file[i + j] === needle[j]) j++
      if (j === n) return i
      i = file.indexOf(first, i + 1)
    }
    return -1
  }
}

const latin1 = (d: Uint8Array, a: number, b: number): string => {
  let s = ''
  for (let i = a; i < b; i++) s += String.fromCharCode(d[i])
  return s
}

const isWs = (c: number): boolean =>
  c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00

/** The stream dictionary text that precedes stream data starting at `dataStart`, or null. */
export function streamDictBefore(file: Uint8Array, dataStart: number): string | null {
  let p = dataStart
  // `stream` EOL: CRLF or LF (a lone CR is tolerated too).
  if (p > 0 && file[p - 1] === 0x0a) p--
  if (p > 0 && file[p - 1] === 0x0d) p--
  if (p < 6 || latin1(file, p - 6, p) !== 'stream') return null
  p -= 6
  while (p > 0 && isWs(file[p - 1])) p--
  if (p < 2 || file[p - 1] !== 0x3e || file[p - 2] !== 0x3e) return null
  const end = p
  let depth = 0
  const floor = Math.max(0, end - 65536)
  for (let i = end - 1; i > floor; i--) {
    if (file[i] === 0x3e && file[i - 1] === 0x3e) {
      depth++
      i--
    } else if (file[i] === 0x3c && file[i - 1] === 0x3c) {
      depth--
      i--
      if (depth === 0) return latin1(file, i, end)
    }
  }
  return null
}

const FAMILY_COMPONENTS: Record<string, number> = {
  DeviceGray: 1,
  CalGray: 1,
  G: 1,
  DeviceRGB: 3,
  CalRGB: 3,
  RGB: 3,
  Lab: 3,
  DeviceCMYK: 4,
  CMYK: 4,
  Indexed: 1,
  I: 1,
  Separation: 1,
  Pattern: 1
}

type Tok = { k: 'name'; v: string } | { k: 'num'; v: number } | { k: 'R' } | { k: '[' } | { k: ']' }

/**
 * The tokens of ONE PDF value starting at `from`: a name, an `n g R` reference, or an array (up to
 * its closing bracket). Dictionaries and strings inside an array end the scan early, which is fine:
 * only the family name and the leading operands are ever read.
 */
function tokens(s: string, from: number, limit = 64): Tok[] {
  const out: Tok[] = []
  let i = from
  let depth = 0
  const complete = (): boolean => {
    if (out.length === 0) return false
    if (out[0].k === '[') return depth === 0
    if (out[0].k === 'num') return out.length >= 3
    return true
  }
  while (i < s.length && out.length < limit && !complete()) {
    const c = s[i]
    if (/\s/.test(c)) {
      i++
    } else if (c === '/') {
      let j = i + 1
      while (j < s.length && !/[\s/[\]<>()%]/.test(s[j])) j++
      out.push({ k: 'name', v: s.slice(i + 1, j) })
      i = j
    } else if (/[-+.\d]/.test(c)) {
      let j = i + 1
      while (j < s.length && /[\d.]/.test(s[j])) j++
      out.push({ k: 'num', v: Number(s.slice(i, j)) })
      i = j
    } else if (c === 'R' && !/[A-Za-z]/.test(s[i + 1] ?? ' ')) {
      out.push({ k: 'R' })
      i++
    } else if (c === '[') {
      out.push({ k: '[' })
      depth++
      i++
    } else if (c === ']') {
      out.push({ k: ']' })
      depth--
      i++
    } else break
  }
  return out
}

/** Where the bytes of indirect object `n g` start (after `n g obj`), or −1. */
function findObject(find: ByteFind, file: Uint8Array, n: number, g: number): number {
  const needle = new TextEncoder().encode(`${n} ${g} obj`)
  let from = 0
  for (let tries = 0; tries < 64; tries++) {
    const at = find(needle, from)
    if (at < 0) return -1
    const before = at === 0 ? 0x0a : file[at - 1]
    if (isWs(before)) return at + needle.length
    from = at + 1
  }
  return -1
}

/**
 * Component count of a colour space value (`tokens` from just after `/ColorSpace`), resolving
 * indirect references and ICCBased /N through `find`. 'unknown' when it cannot be told.
 */
function colourComponents(
  toks: Tok[],
  file: Uint8Array,
  find: ByteFind,
  depth = 0
): number | 'unknown' {
  if (depth > 3 || toks.length === 0) return 'unknown'
  const t0 = toks[0]
  if (t0.k === 'name') return FAMILY_COMPONENTS[t0.v] ?? 'unknown'
  if (t0.k === 'num' && toks[1]?.k === 'num' && toks[2]?.k === 'R') {
    const at = findObject(find, file, t0.v, (toks[1] as { v: number }).v)
    if (at < 0) return 'unknown'
    const text = latin1(file, at, Math.min(file.length, at + 4096))
    const trimmed = text.replace(/^\s+/, '')
    if (trimmed.startsWith('<<')) {
      // An ICC profile stream dictionary.
      const nm = /\/N\s+(\d+)/.exec(trimmed)
      return nm ? Number(nm[1]) : 'unknown'
    }
    return colourComponents(tokens(text, 0), file, find, depth + 1)
  }
  if (t0.k === '[') {
    const fam = toks[1]
    if (!fam || fam.k !== 'name') return 'unknown'
    if (fam.v === 'ICCBased') return colourComponents(toks.slice(2), file, find, depth + 1)
    if (fam.v === 'DeviceN') {
      // [/DeviceN [/A /B …] alt tint]: the names array's length.
      if (toks[2]?.k !== '[') return 'unknown'
      let n = 0
      for (let i = 3; i < toks.length && toks[i].k === 'name'; i++) n++
      return n > 0 ? n : 'unknown'
    }
    return FAMILY_COMPONENTS[fam.v] ?? 'unknown'
  }
  return 'unknown'
}

/**
 * The /ColorSpace component count of the image stream whose raw (undecoded) data is `raw`, read
 * from the source file: the stream is found by its bytes (a window from the middle of the data,
 * then checked from the start), its dictionary is read backwards from the `stream` keyword.
 * `null`: the dictionary has no /ColorSpace. `'unknown'`: the stream or the value could not be
 * found or understood (object streams, encryption, unusual syntax).
 */
export function streamColourComponents(
  file: Uint8Array,
  raw: Uint8Array,
  find: ByteFind
): number | null | 'unknown' {
  const dict = imageStreamDict(file, raw, find)
  if (dict === null) return 'unknown'
  return dictColourComponents(dict, file, find)
}

/** A stream dictionary's /ColorSpace component count; null without one. */
export function dictColourComponents(
  dict: string,
  file: Uint8Array,
  find: ByteFind
): number | null | 'unknown' {
  const m = /\/ColorSpace(?![A-Za-z])/.exec(dict)
  if (!m) return null
  return colourComponents(tokens(dict, m.index + m[0].length), file, find)
}

/**
 * The dictionary of the stream whose raw (undecoded) data is `raw`, from the source file (a window
 * from the middle of the data, then checked from the start), or null when it cannot be found.
 */
export function imageStreamDict(file: Uint8Array, raw: Uint8Array, find: ByteFind): string | null {
  if (raw.length === 0) return null
  const win = Math.min(64, raw.length)
  const mid = Math.max(0, Math.floor((raw.length - win) / 2))
  const needle = raw.subarray(mid, mid + win)
  const head = Math.min(raw.length, 256)
  let from = 0
  for (let tries = 0; tries < 16; tries++) {
    const at = find(needle, from)
    if (at < 0) return null
    from = at + 1
    const start = at - mid
    if (start < 0 || start + head > file.length) continue
    let same = true
    for (let i = 0; i < head && same; i++) same = file[start + i] === raw[i]
    if (!same) continue
    const dict = streamDictBefore(file, start)
    if (dict !== null) return dict
  }
  return null
}

/** A PDF name's text with its `#xx` escapes decoded (`/S#4Dask` is `/SMask`). */
function decodeName(s: string): string {
  return s.replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
}

/** Every name in a dictionary's text, escapes decoded, with the offset just past it. */
function namesIn(dict: string): Array<{ name: string; end: number }> {
  const out: Array<{ name: string; end: number }> = []
  for (let i = dict.indexOf('/'); i >= 0 && out.length < 4096; i = dict.indexOf('/', i + 1)) {
    let j = i + 1
    while (j < dict.length && !/[\s/[\]<>()%{}]/.test(dict[j])) j++
    out.push({ name: decodeName(dict.slice(i + 1, j)), end: j })
    i = j - 1
  }
  return out
}

/**
 * The streams an image dictionary names as its /SMask or /Mask (a /Mask array is a colour key, not
 * a stream, and is skipped). PDFium decodes these with the image, so a JPX one needs the SIZ
 * pre-check as much as the image itself.
 */
export function maskRefs(dict: string): Array<{ n: number; g: number }> {
  const out: Array<{ n: number; g: number }> = []
  const ref = /\s*(\d+)\s+(\d+)\s+R(?![A-Za-z])/y
  for (const { name, end } of namesIn(dict)) {
    if (name !== 'SMask' && name !== 'Mask') continue
    ref.lastIndex = end
    const m = ref.exec(dict)
    if (m) out.push({ n: Number(m[1]), g: Number(m[2]) })
    if (out.length >= 8) break
  }
  return out
}

/** Where each copy of indirect object `n g` starts (after `n g obj`); incremental updates add more. */
function objectStarts(find: ByteFind, file: Uint8Array, n: number, g: number, max = 8): number[] {
  const needle = new TextEncoder().encode(`${n} ${g} obj`)
  const out: number[] = []
  let from = 0
  for (let tries = 0; tries < 64 && out.length < max; tries++) {
    const at = find(needle, from)
    if (at < 0) break
    const before = at === 0 ? 0x0a : file[at - 1]
    if (isWs(before)) out.push(at + needle.length)
    from = at + 1
  }
  return out
}

/** The dictionary that starts at `at` (after whitespace) and the offset just past its `>>`. */
function dictAt(file: Uint8Array, at: number): { text: string; end: number } | null {
  let p = at
  while (p < file.length && isWs(file[p])) p++
  if (file[p] !== 0x3c || file[p + 1] !== 0x3c) return null
  let depth = 0
  const limit = Math.min(file.length - 1, p + 65536)
  for (let i = p; i < limit; i++) {
    if (file[i] === 0x3c && file[i + 1] === 0x3c) {
      depth++
      i++
    } else if (file[i] === 0x3e && file[i + 1] === 0x3e) {
      depth--
      i++
      if (depth === 0) return { text: latin1(file, p, i + 1), end: i + 1 }
    }
  }
  return null
}

/**
 * The SIZ pre-check on every copy of stream object `n g` that is JPXDecode data (§3.4.1, extended
 * to masks): the first refusal, or null when no copy is a JPX stream PDFium would mis-decode or
 * trap on. A mask's colour space is its /ColorSpace, else DeviceGray (a soft mask's and an image
 * mask's by definition). A copy whose stream data cannot be located is skipped: the raster
 * thread's crash path is the remaining guard.
 */
export function jpxObjectRefusal(
  file: Uint8Array,
  find: ByteFind,
  n: number,
  g: number
): JpxRefusal | null {
  for (const at of objectStarts(find, file, n, g)) {
    const dict = dictAt(file, at)
    if (!dict) continue
    if (!namesIn(dict.text).some((x) => x.name === 'JPXDecode')) continue
    let p = dict.end
    while (p < file.length && isWs(file[p])) p++
    if (latin1(file, p, Math.min(file.length, p + 6)) !== 'stream') continue
    p += 6
    if (file[p] === 0x0d) p++
    if (file[p] === 0x0a) p++
    const start = p
    let len = -1
    const lm = /\/Length\s+(\d+)(?:\s+(\d+)\s+R(?![A-Za-z]))?/.exec(dict.text)
    if (lm && lm[2] === undefined) len = Number(lm[1])
    else if (lm) {
      const lat = objectStarts(find, file, Number(lm[1]), Number(lm[2]), 1)[0]
      const v =
        lat === undefined
          ? null
          : /^\s*(\d+)/.exec(latin1(file, lat, Math.min(file.length, lat + 32)))
      if (v) len = Number(v[1])
    }
    if (!(len >= 0) || start + len > file.length) {
      const endAt = find(new TextEncoder().encode('endstream'), start)
      len = (endAt < 0 ? file.length : endAt) - start
    }
    const data = file.subarray(start, start + Math.max(0, len))
    const cs = dictColourComponents(dict.text, file, find)
    const check = jpxPrecheck(data, cs === null ? 1 : cs === 'unknown' ? null : cs)
    if (!check.ok) return check.reason
  }
  return null
}
