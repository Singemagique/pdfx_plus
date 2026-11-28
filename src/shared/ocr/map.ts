// RawOcr (image px) → OcrPage / PackedOcrPage in the overlay frame (DESIGN.md §3.4.6, §3.5.1):
// the filter, the text cleaning (text.ts) and the geometry. Pure and DOM-free; the coordinator runs
// it on every recognised page, and tier-0 tests run it on replayed hOCR.
//
// Geometry. The raster is the page as the overlay shows it (intrinsic /Rotate applied, no edit
// rotation; §3.4.2), so pixel (px, py) maps to (px · W/rw, H − py · H/rh) pt: the design's
// `x_pt = px·72/renderDpi, y_pt = H − py·72/renderDpi`, with the scale taken from the raster's
// actual size so the pixel caps' DPI rounding never shifts a word. The mapping is one affine
// (`pixelToOverlay`) so PR6 can prepend the inverse deskew and orientation rotations to it.
// - A word is anchored at its baseline start: the word box's left edge on the line's hOCR baseline
//   (`y = slope·(x − x0) + y1 + intercept`); `w` runs along the baseline to the box's right edge.
// - The line angle is the baseline direction through the affine; |angle| < 1° snaps to 0 (Preview
//   renders tiny angles as jagged text). Only the ANGLE snaps: each word keeps its own baseline y,
//   so on a page skewed by less than 1° (scans commonly are, by 0.3–0.9°) a word at the right end
//   of a line does not drift off its ink by slope × distance (PR5 review: 5.8 pt at 0.9°). The
//   layer writes one Tm per word, so nothing needs a shared y.
// - Rotated lines (§3.4.6, hOCR `textangle`): Tesseract writes `textangle 90 / 180 / 270` (degrees
//   counter-clockwise; no `baseline` then) for a block whose text is turned, e.g. a vertical label
//   in the margin of an upright page. Such a line runs along the image's y axis (90: bottom to top,
//   270: top to bottom) or right to left (180); each word is anchored at its box edge where reading
//   starts, on the line's baseline (the line box's descender side moved in by `x_descenders`), its
//   `w` is the box's extent along the reading direction, and the size clamp uses the line box's
//   extent ACROSS it. A tall line with neither a baseline nor a textangle (Tesseract's vertical
//   text-direction lines: rot90page) is placed the same way, top to bottom unless its words run
//   upward. Any other textangle is dropped (never mapped as if horizontal). Char boxes on rotated
//   lines are degenerate (x0 = x1 = 0), so those words are spaced evenly.
// - Font size, by script: Latin/Cyrillic/Greek and anything else with an x-height: xh / 0.5 (PR0:
//   overestimates Helvetica by 4–12%; PR6 refits the factor). Han, kana, Hangul and Devanagari:
//   0.88 × the median char-box height. Either way clamped to the line box: the em box is at least
//   the line's ink height and at most twice it, using the median word height when the line box is
//   more than 1.5× that (a tilted or ragged line).

import { calibrate, RAW_THRESHOLDS } from './calibration'
import type { CalibrationTable, PxBox, RawLine, RawOcr, RawWord } from './engine/types'
import { cleanOcrText } from './text'
import {
  pack,
  type OcrLine,
  type OcrPage,
  type OcrWord,
  type PackedOcrPage,
  type PageClass
} from './types'

/** PDF `cm` order: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Affine = readonly [number, number, number, number, number, number]

export interface MapContext {
  /** The overlay frame of the page (pt): what the raster covers. */
  page: { width: number; height: number }
  /** The raster the engine saw (px). */
  raster: { width: number; height: number }
  renderDpi: number
  /** Physical DPI estimate (PR6, §3.4.3); defaults to renderDpi. */
  physDpi?: number
  engineId: string
  dataHashes: Record<string, string>
  langs: string[]
  pipelineVersion: number
  pageClass: PageClass
  calibration: CalibrationTable
  /** PR6: the detected orientation and skew whose inverse is already in `toOverlay`. */
  orientation?: 0 | 90 | 180 | 270
  skewDeg?: number
  /** Pixel → overlay affine; defaults to `pixelToOverlay(page, raster)`. */
  toOverlay?: Affine
}

/** The plain scale-and-flip from raster px (top-left, y down) to the overlay frame (pt, y up). */
export function pixelToOverlay(
  page: { width: number; height: number },
  raster: { width: number; height: number }
): Affine {
  const sx = page.width / raster.width
  const sy = page.height / raster.height
  return [sx, 0, 0, -sy, 0, page.height]
}

const apply = (m: Affine, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5]
]
/** The affine's linear part on a vector. */
const applyVec = (m: Affine, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y,
  m[1] * x + m[3] * y
]
const len = (v: readonly [number, number]): number => Math.sqrt(v[0] * v[0] + v[1] * v[1])

/** tan(1°): a baseline flatter than this snaps to angle 0 (no trigonometry needed to decide). */
const TAN_1DEG = 0.017455064928217585

/** The x-height → em factor for Latin-like scripts (PR0; PR6 refits). */
export const XHEIGHT_EM = 0.5
/** Char-box height → em for scripts without an x-height (PR6 refits on the CJK replays). */
export const CJK_CHAR_EM = 0.88

const NO_XHEIGHT_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Devanagari}]/u
const LETTER = /[\p{L}\p{N}]/u

/** True when most letters of `text` are in a script without an x-height. */
export function noXHeightScript(text: string): boolean {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (NO_XHEIGHT_SCRIPT.test(ch)) cjk++
    else if (LETTER.test(ch)) other++
  }
  return cjk > other
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const height = (b: PxBox): number => b.y1 - b.y0
const width = (b: PxBox): number => b.x1 - b.x0

/**
 * Which way a line's text runs in the raster, as hOCR's `textangle` (degrees counter-clockwise):
 * 0 left to right, 90 bottom to top, 180 right to left (upside down), 270 top to bottom.
 */
export type LineOrientation = 0 | 90 | 180 | 270

/** A line box this much taller than wide, with no baseline and no textangle, runs vertically. */
const VERTICAL_ASPECT = 2

/** The orientation of a line, or null for a textangle this mapping cannot place (dropped). */
export function lineOrientation(l: RawLine): LineOrientation | null {
  if (l.angle !== undefined) {
    if (!Number.isInteger(l.angle)) return null
    const a = ((l.angle % 360) + 360) % 360
    return a === 0 || a === 90 || a === 180 || a === 270 ? a : null
  }
  if (l.baseline || !(height(l.bbox) > VERTICAL_ASPECT * width(l.bbox))) return 0
  // A vertical text-direction line: words in reading order; top to bottom unless they run upward.
  const first = l.words[0]
  const last = l.words[l.words.length - 1]
  if (
    first &&
    last &&
    first !== last &&
    first.bbox.y0 + first.bbox.y1 > last.bbox.y0 + last.bbox.y1
  )
    return 90
  return 270
}

const isVertical = (o: LineOrientation): boolean => o === 90 || o === 270

/** Why a word was dropped (for tests and diagnostics). */
export type DropReason = 'empty' | 'negative-conf' | 'noise' | 'tall' | 'aspect'

/**
 * The §3.4.6 filter for one word of a line. Keeps low-confidence real words: the layer serves
 * recall. Near-scanned masking (overlap with native text) needs triage's native words: PR6.
 * `lineMedianHeight` is the median word extent ACROSS the reading direction (the box width on a
 * vertical line, `vertical`).
 */
export function dropReason(
  w: RawWord,
  text: string,
  lineMedianHeight: number,
  vertical = false
): DropReason | null {
  if (text.length === 0) return 'empty'
  if (w.conf !== null && w.conf < 0) return 'negative-conf'
  if (w.conf !== null && w.conf < 30 && ([...text].length <= 2 || !LETTER.test(text)))
    return 'noise'
  const h = vertical ? width(w.bbox) : height(w.bbox)
  const wd = vertical ? height(w.bbox) : width(w.bbox)
  if (lineMedianHeight > 0 && h > 3 * lineMedianHeight) return 'tall'
  if (h <= 0 || wd <= 0 || wd / h > 30 || h / wd > 30) return 'aspect'
  return null
}

/**
 * Em height (px) of a line, by script (see the header). On a vertical line (`vertical`) every
 * "height" is the extent across the reading direction: the box widths.
 */
export function lineSizePx(line: RawLine, keptText: string, vertical = false): number {
  const across = vertical ? width : height
  const wordHeights = line.words.map((w) => across(w.bbox)).filter((h) => h > 0)
  const medWord = median(wordHeights)
  const boxH = across(line.bbox)
  const ref = medWord > 0 && boxH > 1.5 * medWord ? medWord : boxH
  let size: number
  if (noXHeightScript(keptText)) {
    const charHeights: number[] = []
    for (const w of line.words)
      for (const c of w.chars ?? []) if (across(c) > 0) charHeights.push(across(c))
    size = CJK_CHAR_EM * (charHeights.length > 0 ? median(charHeights) : medWord)
  } else size = line.xHeight > 0 ? line.xHeight / XHEIGHT_EM : ref
  if (ref > 0) size = Math.min(Math.max(size, ref), ref / XHEIGHT_EM)
  return size
}

/** The descender share of a line box when hOCR gives no `x_descenders` (OCR_DESCENT of ~1.2 em). */
const DESCENDER_FALLBACK = 0.2 / 1.2

/**
 * The baseline start and end (image px) of word box `b` on a rotated line `rl` (90/180/270): the
 * line's baseline sits `x_descenders` in from the line box's descender side, and the word runs
 * along it from the box edge where reading starts.
 */
function rotatedSpan(
  rl: RawLine,
  b: PxBox,
  o: 90 | 180 | 270
): { start: [number, number]; end: [number, number] } {
  const lb = rl.bbox
  const acrossBox = o === 180 ? height(lb) : width(lb)
  const desc =
    rl.descenders !== undefined && rl.descenders >= 0 && rl.descenders < acrossBox
      ? rl.descenders
      : DESCENDER_FALLBACK * acrossBox
  if (o === 90) {
    // Glyph tops point left (−x): the descender side is the right edge; reading runs upward.
    const xb = lb.x1 - desc
    return { start: [xb, b.y1], end: [xb, b.y0] }
  }
  if (o === 270) {
    const xb = lb.x0 + desc
    return { start: [xb, b.y0], end: [xb, b.y1] }
  }
  const yb = lb.y0 + desc
  return { start: [b.x1, yb], end: [b.x0, yb] }
}

/** Map one recognition to an OcrPage (objects; `mapRawOcr` packs it). */
export function mapRawOcrPage(raw: RawOcr, ctx: MapContext): OcrPage {
  const m = ctx.toOverlay ?? pixelToOverlay(ctx.page, ctx.raster)
  const lines: OcrLine[] = []
  let calWeighted = 0
  let weight = 0
  let anyConf = false

  for (const rl of raw.lines) {
    const o = lineOrientation(rl)
    if (o === null) continue
    const vertical = isVertical(o)
    const across = vertical ? width : height
    const medH = median(rl.words.map((w) => across(w.bbox)))
    const kept: { w: RawWord; t: string }[] = []
    for (const w of rl.words) {
      const t = cleanOcrText(w.text)
      if (dropReason(w, t, medH, vertical) === null) kept.push({ w, t })
    }
    if (kept.length === 0) continue

    let angle: number
    let flat = false
    let span: (b: PxBox) => { start: [number, number]; end: [number, number] }
    if (o === 0) {
      const slope = rl.baseline?.slope ?? 0
      const baseline = rl.baseline
      const baseY = (x: number, fallback: number): number =>
        baseline ? rl.bbox.y1 + baseline.intercept + slope * (x - rl.bbox.x0) : fallback
      // Baseline direction in the overlay frame; the em height runs perpendicular to it.
      const dir = applyVec(m, 1, slope)
      flat = Math.abs(slope) < TAN_1DEG && Math.abs(dir[1]) < TAN_1DEG * Math.abs(dir[0])
      angle = flat ? 0 : Math.atan2(dir[1], dir[0])
      span = (b) => ({ start: [b.x0, baseY(b.x0, b.y1)], end: [b.x1, baseY(b.x1, b.y1)] })
    } else {
      const r: [number, number] = o === 90 ? [0, -1] : o === 270 ? [0, 1] : [-1, 0]
      const dir = applyVec(m, r[0], r[1])
      // `+ 0` turns a −0 into 0, so upside down is π, not −π.
      angle = Math.atan2(dir[1] + 0, dir[0])
      span = (b) => rotatedSpan(rl, b, o)
    }
    const sizePx = lineSizePx(rl, kept.map((k) => k.t).join(''), vertical)
    // px → pt across the baseline (the affine's scale on the image axis across the reading one).
    const size = sizePx * len(vertical ? applyVec(m, 1, 0) : applyVec(m, 0, 1))

    const words: OcrWord[] = []
    for (const { w, t } of kept) {
      const { start, end } = span(w.bbox)
      // Each word on its OWN baseline, also on a snapped line (see the header).
      const [x, y] = apply(m, start[0], start[1])
      const [xe, ye] = apply(m, end[0], end[1])
      // Snapped lines run horizontally from the word's own left edge.
      const wPt = flat ? Math.abs(xe - x) : Math.sqrt((xe - x) ** 2 + (ye - y) ** 2)
      const conf = w.conf
      const confCal = calibrate(ctx.calibration, conf)
      const word: OcrWord = { t, x, y, w: wPt, conf, confCal }
      const chars = charEdges(w, t, wPt, o)
      if (chars) word.chars = chars
      words.push(word)
      const n = [...t].length
      if (conf !== null && confCal !== null) {
        anyConf = true
        calWeighted += confCal * n
        weight += n
      }
    }
    const line: OcrLine = { angle, size, words }
    if (rl.lang) line.lang = rl.lang
    lines.push(line)
  }

  const meanConfCal = weight > 0 ? calWeighted / weight : null
  const flag = calibrate(ctx.calibration, RAW_THRESHOLDS.flag)
  const status: OcrPage['status'] =
    lines.length === 0
      ? 'no-text'
      : meanConfCal !== null && flag !== null && meanConfCal < flag
        ? 'low-confidence'
        : 'ok'
  return {
    v: 1,
    engineId: ctx.engineId,
    dataHashes: { ...ctx.dataHashes },
    langs: [...ctx.langs],
    pipelineVersion: ctx.pipelineVersion,
    pageClass: ctx.pageClass,
    renderDpi: ctx.renderDpi,
    physDpi: ctx.physDpi ?? ctx.renderDpi,
    orientation: ctx.orientation ?? 0,
    skewDeg: ctx.skewDeg ?? 0,
    meanConfCal,
    confSource: anyConf ? raw.confSource : 'none',
    status,
    lines
  }
}

/** Map and pack (what the coordinator posts). */
export function mapRawOcr(raw: RawOcr, ctx: MapContext): PackedOcrPage {
  return pack(mapRawOcrPage(raw, ctx))
}

/**
 * Cumulative char edges 0..w (one per code point boundary, n + 1 values) from the cinfo boxes:
 * the boundary between two chars is the midpoint of the gap between their boxes, measured along
 * the word from its reading start (the left edge; the right edge on an upside-down line). Only
 * when the cleaned text is the engine's text unchanged and has exactly one real box per code point,
 * each inside the word's box; otherwise (and always on vertical lines, whose cinfo boxes Tesseract
 * reports as x0 = x1 = 0 outside the word) the layer spaces the word evenly.
 */
export function charEdges(
  w: RawWord,
  t: string,
  wPt: number,
  orientation: LineOrientation = 0
): Float32Array | undefined {
  const boxes = w.chars
  if (!boxes || t !== w.text || isVertical(orientation)) return undefined
  const n = [...t].length
  if (boxes.length !== n || n === 0) return undefined
  const b = w.bbox
  const span = width(b)
  if (span <= 0) return undefined
  for (const c of boxes)
    if (
      !(width(c) > 0 && height(c) > 0) ||
      c.x0 < b.x0 - CHAR_BOX_SLACK ||
      c.x1 > b.x1 + CHAR_BOX_SLACK ||
      c.y0 < b.y0 - CHAR_BOX_SLACK ||
      c.y1 > b.y1 + CHAR_BOX_SLACK
    )
      return undefined
  const k = wPt / span
  const flip = orientation === 180
  const edges = new Float32Array(n + 1)
  edges[n] = wPt
  let prev = 0
  for (let i = 1; i < n; i++) {
    const along = flip
      ? b.x1 - (boxes[i - 1].x0 + boxes[i].x1) / 2
      : (boxes[i - 1].x1 + boxes[i].x0) / 2 - b.x0
    const e = Math.min(wPt, Math.max(prev, along * k))
    edges[i] = e
    prev = e
  }
  return edges
}

/** How far (px) a char box may stick out of its word box before the boxes are not trusted. */
const CHAR_BOX_SLACK = 2
