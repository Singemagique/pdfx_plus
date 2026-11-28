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
//   renders tiny angles as jagged text).
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

/** Why a word was dropped (for tests and diagnostics). */
export type DropReason = 'empty' | 'negative-conf' | 'noise' | 'tall' | 'aspect'

/**
 * The §3.4.6 filter for one word of a line. Keeps low-confidence real words: the layer serves
 * recall. Near-scanned masking (overlap with native text) needs triage's native words: PR6.
 */
export function dropReason(w: RawWord, text: string, lineMedianHeight: number): DropReason | null {
  if (text.length === 0) return 'empty'
  if (w.conf !== null && w.conf < 0) return 'negative-conf'
  if (w.conf !== null && w.conf < 30 && ([...text].length <= 2 || !LETTER.test(text)))
    return 'noise'
  const h = height(w.bbox)
  const wd = width(w.bbox)
  if (lineMedianHeight > 0 && h > 3 * lineMedianHeight) return 'tall'
  if (h <= 0 || wd <= 0 || wd / h > 30 || h / wd > 30) return 'aspect'
  return null
}

/** Em height (px) of a line, by script (see the header). */
export function lineSizePx(line: RawLine, keptText: string): number {
  const wordHeights = line.words.map((w) => height(w.bbox)).filter((h) => h > 0)
  const medWord = median(wordHeights)
  const boxH = height(line.bbox)
  const ref = medWord > 0 && boxH > 1.5 * medWord ? medWord : boxH
  let size: number
  if (noXHeightScript(keptText)) {
    const charHeights: number[] = []
    for (const w of line.words)
      for (const c of w.chars ?? []) if (height(c) > 0) charHeights.push(height(c))
    size = CJK_CHAR_EM * (charHeights.length > 0 ? median(charHeights) : medWord)
  } else size = line.xHeight > 0 ? line.xHeight / XHEIGHT_EM : ref
  if (ref > 0) size = Math.min(Math.max(size, ref), ref / XHEIGHT_EM)
  return size
}

/** Map one recognition to an OcrPage (objects; `mapRawOcr` packs it). */
export function mapRawOcrPage(raw: RawOcr, ctx: MapContext): OcrPage {
  const m = ctx.toOverlay ?? pixelToOverlay(ctx.page, ctx.raster)
  const lines: OcrLine[] = []
  let calWeighted = 0
  let weight = 0
  let anyConf = false

  for (const rl of raw.lines) {
    const heights = rl.words.map((w) => height(w.bbox))
    const medH = median(heights)
    const kept: { w: RawWord; t: string }[] = []
    for (const w of rl.words) {
      const t = cleanOcrText(w.text)
      if (dropReason(w, t, medH) === null) kept.push({ w, t })
    }
    if (kept.length === 0) continue

    const slope = rl.baseline?.slope ?? 0
    const baseY = (x: number): number =>
      rl.baseline ? rl.bbox.y1 + rl.baseline.intercept + slope * (x - rl.bbox.x0) : NaN
    // Baseline direction in the overlay frame; the em height runs perpendicular to it.
    const dir = applyVec(m, 1, slope)
    const flat = Math.abs(slope) < TAN_1DEG && Math.abs(dir[1]) < TAN_1DEG * Math.abs(dir[0])
    const angle = flat ? 0 : Math.atan2(dir[1], dir[0])
    const sizePx = lineSizePx(rl, kept.map((k) => k.t).join(''))
    // px → pt across the baseline (the affine's scale on the image y axis).
    const size = sizePx * len(applyVec(m, 0, 1))

    const words: OcrWord[] = []
    for (const { w, t } of kept) {
      const b = w.bbox
      const y0 = rl.baseline ? baseY(b.x0) : b.y1
      const y1 = rl.baseline ? baseY(b.x1) : b.y1
      const [x, y] = apply(m, b.x0, y0)
      const [xe, ye] = apply(m, b.x1, y1)
      // Snapped lines run horizontally from the word's own left edge.
      const wPt = flat ? Math.abs(xe - x) : Math.sqrt((xe - x) ** 2 + (ye - y) ** 2)
      const conf = w.conf
      const confCal = calibrate(ctx.calibration, conf)
      const word: OcrWord = { t, x, y, w: wPt, conf, confCal }
      const chars = charEdges(w, t, wPt)
      if (chars) word.chars = chars
      words.push(word)
      const n = [...t].length
      if (conf !== null && confCal !== null) {
        anyConf = true
        calWeighted += confCal * n
        weight += n
      }
    }
    if (flat) {
      // One baseline for the whole line: the line's own hOCR baseline at its left edge (words of a
      // snapped line share it, so the layer writes them on one y).
      const yLine = rl.baseline ? apply(m, rl.bbox.x0, baseY(rl.bbox.x0))[1] : words[0].y
      for (const w of words) w.y = yLine
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
 * the word from its left edge. Only when the cleaned text is the engine's text unchanged and has
 * exactly one box per code point; otherwise the layer spaces the word evenly.
 */
export function charEdges(w: RawWord, t: string, wPt: number): Float32Array | undefined {
  const boxes = w.chars
  if (!boxes || t !== w.text) return undefined
  const n = [...t].length
  if (boxes.length !== n || n === 0) return undefined
  const x0 = w.bbox.x0
  const span = width(w.bbox)
  if (span <= 0) return undefined
  const k = wPt / span
  const edges = new Float32Array(n + 1)
  edges[n] = wPt
  let prev = 0
  for (let i = 1; i < n; i++) {
    const mid = (boxes[i - 1].x1 + boxes[i].x0) / 2
    const e = Math.min(wPt, Math.max(prev, (mid - x0) * k))
    edges[i] = e
    prev = e
  }
  return edges
}
