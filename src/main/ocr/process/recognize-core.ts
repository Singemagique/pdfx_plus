// The recognize thread's per-page pipeline (DESIGN.md §3.4.3–§3.4.6), as pure functions over an
// engine, so vitest runs it with the real core (tier 1), a replayed one (tier 0) or a fake one.
//
// One call recognises one raster:
//  1. Preprocess the OCR copy (never the page): background normalisation when the page looks like
//     a photo, border removal, conditional despeckle (src/shared/ocr/preprocess/*; none of these
//     moves a pixel).
//  2. Geometry: the 90° projection test, then deskew (sweep and search on the 1/4-scale binary
//     copy), then a 16 px white pad. `toSource` maps the copy's pixels back to the raster's, so
//     every word and char box is mapped back with the inverse rotation (map.ts takes the affine).
//  3. Pass 1: PSM 3, Otsu. If it reads doubtfully, the 0°/180° test (a central band, PSM 6, both
//     ways; flip only if confidence AND plausibility agree) and, on a flip, pass 1 again.
//  4. Retry A (Sauvola) if the calibrated mean is below the retry threshold; Retry B (PSM 11) if
//     the OCR chars are under 30% of the ink components. Keep the higher Σ(conf × chars). At most
//     MAX_PASSES full-page recognitions; the band reads are not counted (they are a quarter page).
//  5. The adaptive pass is asked for, not run: the x-height (or, for scripts without one, the char
//     height) says the page needs more pixels, and only the raster thread can render them. The
//     coordinator re-renders at `adaptive.dpi` and calls again with `reuse`, which skips the
//     geometry tests and runs the chosen recipe once (page-plan.ts decides which result wins).

import { calibrate, TESS_CORE7, thresholdsFor } from '../../../shared/ocr/calibration'
import type { CalibrationTable, GrayImage, RawOcr } from '../../../shared/ocr/engine/types'
import { TessError, fullPageParams, type TessParams } from '../../../shared/ocr/engine/tess-core'
import { hocrToRaw, parseHocr } from '../../../shared/ocr/hocr'
import { noXHeightScript } from '../../../shared/ocr/map'
import { looksLikePhoto, normalizeBackground } from '../../../shared/ocr/preprocess/background'
import { BORDER_PAD, removeBorder } from '../../../shared/ocr/preprocess/border'
import { despeckle } from '../../../shared/ocr/preprocess/despeckle'
import {
  IDENTITY,
  compose,
  rotateBilinear,
  rotateQuarterCW,
  translate,
  type Affine,
  type QuarterTurns
} from '../../../shared/ocr/preprocess/geometry'
import {
  QUARTER,
  binarize,
  boxDownscale,
  cropRows,
  histogram,
  otsu,
  packed,
  padWhite,
  type Gray
} from '../../../shared/ocr/preprocess/image'
import {
  BAND_DEN,
  BAND_NUM,
  bandReading,
  plausibility,
  profileTest,
  shouldFlip,
  type BandReading,
  type Orientation
} from '../../../shared/ocr/preprocess/orientation'

/**
 * The name and message a recognize thread posts for a failed page (`{ type: 'error' }`), for the
 * coordinator's failure policy (`isOomShaped`); never page content. A WASM OOM (TessError kind
 * 'oom') becomes `OcrOutOfMemory`, which the coordinator treats as OOM-shaped (respawn, re-queue
 * once, halve n); an abort is a `RuntimeError`; every other kind stays a `TessError`.
 */
export function describeRecognizeError(e: unknown): { name: string; message: string } {
  if (e instanceof TessError) {
    if (e.kind === 'oom') return { name: 'OcrOutOfMemory', message: `out of memory: ${e.message}` }
    return { name: e.kind === 'abort' ? 'RuntimeError' : 'TessError', message: e.message }
  }
  const err = e instanceof Error ? e : new Error('non-Error throw')
  return { name: err.name, message: err.message.slice(0, 300) }
}

export interface RecognizeEngine {
  recognize(img: GrayImage, params: TessParams): { hocr: string }
}

/** A full-page recognition recipe: the parameters beyond DPI. */
export interface PassRecipe {
  /** 3 = PSM_AUTO; 11 = sparse text (Retry B). */
  psm: 3 | 11
  /** 0 = Otsu; 2 = Sauvola (Retry A). */
  thresholding: 0 | 2
}

export interface PassPlan {
  /** 'pass1', 'pass1-flipped', 'sauvola', 'sparse', 'adaptive'; band reads 'band', 'band-flipped'. */
  id: string
  params: TessParams
}

export interface PassSummary {
  id: string
  ms: number
  words: number
  /** Σ(conf × chars) over words with a confidence (§3.4.5's keep-the-better rule). */
  score: number
}

/** The OCR copy's geometry: quarter turns clockwise, then a deskew by −`skewDeg`. */
export interface GeometryPlan {
  quarterTurns: QuarterTurns
  /** The text lines' counter-clockwise tilt in the turned copy (0 when no deskew ran). */
  skewDeg: number
}

export interface AdaptiveRequest {
  /** The DPI to re-render at (before the caller's caps): renderDpi × target / measured. */
  dpi: number
  /** Median x-height (or char height, `script: 'no-xheight'`) of the first result, px. */
  measured: number
  script: 'xheight' | 'no-xheight'
}

/** What the first call learned, so the adaptive call repeats it at the new DPI. */
export interface ReuseHint {
  plan: GeometryPlan
  recipe: PassRecipe
}

export interface RecognitionRecord {
  id: string
  params: TessParams
  width: number
  height: number
  /** FNV-1a of the input pixels (tests: the replay engine checks it gets the recorded input). */
  fnv: number
}

export interface PipelineStats {
  photo: boolean
  noisy: boolean
  specks: number
  borderRemoved: number
  ink: number
  vertical: boolean
  skew: { deg: number; conf: number; applied: boolean }
  /** The band test ran (pass 1 read doubtfully). */
  orientationChecked: boolean
  /** Its two readings, when it ran. */
  band?: { asIs: BandReading; flipped: BandReading }
  flipped: boolean
  /** OCR chars of the chosen result. */
  chars: number
  /** Char-weighted calibrated mean of the chosen result (null without confidences). */
  meanConfCal: number | null
}

export interface RecognizeOutcome {
  raw: RawOcr
  /** The id of the pass whose result is `raw`. */
  chosen: string
  /** Every recognition in order, band reads included. */
  passes: PassSummary[]
  /** The OCR copy's continuous pixel coords → the input raster's (map.ts prepends it). */
  toSource: Affine
  /** θ_detected: the clockwise turn that makes the input raster upright (§3.4.5). */
  orientation: Orientation
  plan: GeometryPlan
  recipe: PassRecipe
  /** Set when the page wants the adaptive re-render (never on a `reuse` call). */
  adaptive: AdaptiveRequest | null
  stats: PipelineStats
  /** Each recognition's hOCR, only when asked for (the tier-1 replay recorder). */
  hocr?: string[]
  recognitions?: RecognitionRecord[]
}

/** At most this many full-page recognitions per call (§3.4.5); the band reads are extra. */
export const MAX_PASSES = 3

/** §3.4.3: re-render when the median x-height is under 15 px, aiming at 20 px. */
export const ADAPTIVE_XH = { trigger: 15, target: 20 } as const
/** Scripts without an x-height: median char-box height under 30 px, aiming at 40 px. */
export const ADAPTIVE_CHAR = { trigger: 30, target: 40 } as const
/** The adaptive pass never renders above this. */
export const ADAPTIVE_MAX_DPI = 600

/**
 * A first result whose char-weighted calibrated mean reaches P(correct) at this raw anchor skips
 * the adaptive pass (§3.4.3: "may skip it when the first pass's calibrated confidence is already
 * high"). [measured, PR6 tier 1: smallprint6pt and its blur read at raw ~96 with recall 100% at
 * 300 DPI and skip; the 200 DPI fax variant reads at ~93 and gains +1.4 pp from the pass.]
 */
export const ADAPTIVE_SKIP_RAW = 95

/** Does this result read well enough to skip the adaptive pass? */
export function adaptiveSkip(raw: RawOcr, table: CalibrationTable): boolean {
  const mean = calibratedMean(raw, table)
  const at = calibrate(table, ADAPTIVE_SKIP_RAW)
  return mean !== null && at !== null && mean >= at
}

/** Retry B: OCR chars below this share of the ink components. */
export const SPARSE_RATIO = 0.3

/**
 * Pass 1 reads doubtfully (run the 0°/180° band test) below either of these. [measured, PR6
 * orientation sweep, 6 fonts × 5 seeds: upside-down bands read at raw means 25–40 and plausibility
 * 0.55–0.69, the same bands the right way up at ~95 and 0.92–0.98; of the upright tier-1 presets
 * only numbers-table (letter-digit codes) reads doubtfully, and its band test does not flip.]
 */
export const DOUBT = { meanConf: 75, plausibility: 0.7 } as const

/** Σ(conf × chars): the score by which two passes over one page are compared. */
export function passScore(raw: RawOcr): number {
  let s = 0
  for (const l of raw.lines)
    for (const w of l.words) if (w.conf !== null && w.conf > 0) s += w.conf * [...w.text].length
  return s
}

const wordCount = (raw: RawOcr): number => raw.lines.reduce((n, l) => n + l.words.length, 0)

function charCount(raw: RawOcr): number {
  let n = 0
  for (const l of raw.lines) for (const w of l.words) n += [...w.text.trim()].length
  return n
}

/** Char-weighted mean of the calibrated word confidence (what OcrPage.meanConfCal reports). */
export function calibratedMean(raw: RawOcr, table: CalibrationTable): number | null {
  let sum = 0
  let n = 0
  for (const l of raw.lines)
    for (const w of l.words) {
      const p = calibrate(table, w.conf)
      if (p === null || w.conf === null || w.conf < 0) continue
      const k = [...w.text].length
      sum += p * k
      n += k
    }
  return n > 0 ? sum / n : null
}

function rawMeanConf(raw: RawOcr): number {
  let s = 0
  let n = 0
  for (const l of raw.lines)
    for (const w of l.words)
      if (w.conf !== null && w.conf >= 0) {
        s += w.conf
        n++
      }
  return n > 0 ? s / n : 0
}

function median(v: number[]): number {
  if (v.length === 0) return 0
  const s = [...v].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * The adaptive pass's trigger (§3.4.3) on a result at `dpi`: the median x-height of its lines, or
 * for pages whose lines are mostly in scripts without one (Han, kana, Hangul, Devanagari) the
 * median char-box height. Null when the text is big enough or nothing was read.
 */
export function adaptiveRequest(raw: RawOcr, dpi: number): AdaptiveRequest | null {
  let noXh = 0
  let other = 0
  const xhs: number[] = []
  const charHs: number[] = []
  for (const l of raw.lines) {
    const text = l.words.map((w) => w.text).join('')
    if (text.length === 0) continue
    if (noXHeightScript(text)) {
      noXh++
      for (const w of l.words)
        for (const c of w.chars ?? []) if (c.y1 - c.y0 > 0) charHs.push(c.y1 - c.y0)
    } else {
      other++
      if (l.xHeight > 0) xhs.push(l.xHeight)
    }
  }
  if (noXh > other) {
    const h = median(charHs)
    if (!(h > 0) || h >= ADAPTIVE_CHAR.trigger) return null
    return { dpi: (dpi * ADAPTIVE_CHAR.target) / h, measured: h, script: 'no-xheight' }
  }
  const xh = median(xhs)
  if (!(xh > 0) || xh >= ADAPTIVE_XH.trigger) return null
  return { dpi: (dpi * ADAPTIVE_XH.target) / xh, measured: xh, script: 'xheight' }
}

function paramsFor(dpi: number, recipe: PassRecipe): TessParams {
  return {
    ...fullPageParams(dpi),
    tessedit_pageseg_mode: recipe.psm,
    thresholding_method: recipe.thresholding
  }
}

/** FNV-1a over the pixels (test bookkeeping only; deterministic). */
export function fnv1a(data: Uint8Array): number {
  let h = 0x811c9dc5
  for (let i = 0; i < data.length; i++) {
    h ^= data[i]
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** The OCR copy for a geometry plan: turned, deskewed, padded, with its map back. */
export function orientedCopy(base: Gray, plan: GeometryPlan): { image: Gray; toSource: Affine } {
  const turned = rotateQuarterCW(base, plan.quarterTurns)
  let image = turned.image
  let toSource = turned.toSource
  if (plan.skewDeg !== 0) {
    const r = rotateBilinear(image, -plan.skewDeg)
    image = r.image
    toSource = compose(r.toSource, toSource)
  }
  return {
    image: padWhite(image, BORDER_PAD),
    toSource: compose(translate(-BORDER_PAD, -BORDER_PAD), toSource)
  }
}

export interface RecognizePageOptions {
  returnHocr?: boolean
  now?: () => number
  /** The adaptive second call: reuse the first call's geometry and recipe. */
  reuse?: ReuseHint
  calibration?: CalibrationTable
  /** Ask for the adaptive pass at all (default true; never on a `reuse` call). */
  adaptive?: boolean
}

/** Recognise one page raster (see the header). */
export function recognizePage(
  engine: RecognizeEngine,
  img: GrayImage,
  dpi: number,
  opts: RecognizePageOptions = {}
): RecognizeOutcome {
  const now = opts.now ?? (() => performance.now())
  const table = opts.calibration ?? TESS_CORE7
  const hocrs: string[] = []
  const records: RecognitionRecord[] = []
  const passes: PassSummary[] = []

  const run = (id: string, image: Gray, params: TessParams): { raw: RawOcr; score: number } => {
    const t0 = now()
    const { hocr } = engine.recognize(image, params)
    if (opts.returnHocr) {
      hocrs.push(hocr)
      records.push({ id, params, width: image.width, height: image.height, fnv: fnv1a(image.data) })
    }
    const raw = hocrToRaw(parseHocr(hocr))
    const score = passScore(raw)
    passes.push({ id, ms: Math.round(now() - t0), words: wordCount(raw), score })
    return { raw, score }
  }

  // 1. Preprocess (§3.4.4).
  const src = packed(img)
  const photo = looksLikePhoto(src)
  let base = photo ? normalizeBackground(src, dpi) : src
  const border = removeBorder(base)
  base = border.image
  const ds = despeckle(base, dpi)
  base = ds.image

  // 2. Geometry (§3.4.5).
  let plan: GeometryPlan
  let vertical = false
  let skew = { deg: 0, conf: 0, applied: false }
  if (opts.reuse) plan = { ...opts.reuse.plan }
  else {
    const q = boxDownscale(base, QUARTER)
    const t = otsu(histogram(q))
    const prof = profileTest(binarize(q, t), q.width, q.height)
    vertical = prof.vertical
    const turns: QuarterTurns = vertical ? 1 : 0
    // The skew of the profile the page is read along (the quarter-turned mask's, when vertical).
    const s = vertical ? prof.cols : prof.rows
    skew = { deg: s.deg, conf: s.conf, applied: s.apply }
    plan = { quarterTurns: turns, skewDeg: s.apply ? s.deg : 0 }
  }
  let copy = orientedCopy(base, plan)

  const recipe0: PassRecipe = opts.reuse?.recipe ?? { psm: 3, thresholding: 0 }
  let full = 0
  type Best = { raw: RawOcr; score: number; id: string; recipe: PassRecipe }
  const first = run(opts.reuse ? 'adaptive' : 'pass1', copy.image, paramsFor(dpi, recipe0))
  full++
  let best: Best = { ...first, id: opts.reuse ? 'adaptive' : 'pass1', recipe: recipe0 }

  // 3. 0° vs 180°, only when pass 1 reads doubtfully.
  let orientationChecked = false
  let flipped = false
  let bandStats: PipelineStats['band']
  if (
    !opts.reuse &&
    (rawMeanConf(best.raw) < DOUBT.meanConf || plausibility(best.raw) < DOUBT.plausibility)
  ) {
    orientationChecked = true
    const h = copy.image.height
    const bandH = Math.max(1, Math.floor((h * BAND_NUM) / BAND_DEN))
    const y0 = Math.floor((h - bandH) / 2)
    const band = cropRows(copy.image, y0, y0 + bandH)
    const bandParams = { ...fullPageParams(dpi), tessedit_pageseg_mode: 6 }
    const asIs = bandReading(run('band', band, bandParams).raw)
    const turned = bandReading(run('band-flipped', rotateQuarterCW(band, 2).image, bandParams).raw)
    bandStats = { asIs, flipped: turned }
    if (shouldFlip(asIs, turned)) {
      flipped = true
      plan = { ...plan, quarterTurns: ((plan.quarterTurns + 2) % 4) as QuarterTurns }
      copy = orientedCopy(base, plan)
      const again = run('pass1-flipped', copy.image, paramsFor(dpi, recipe0))
      full++
      best = { ...again, id: 'pass1-flipped', recipe: recipe0 }
    }
  }

  // 4. Retries (§3.4.5).
  if (!opts.reuse) {
    const retryAt = thresholdsFor(table).retry
    const cal = calibratedMean(best.raw, table)
    if (full < MAX_PASSES && cal !== null && cal < retryAt) {
      const recipe: PassRecipe = { psm: best.recipe.psm, thresholding: 2 }
      const r = run('sauvola', copy.image, paramsFor(dpi, recipe))
      full++
      if (r.score > best.score) best = { ...r, id: 'sauvola', recipe }
    }
    if (full < MAX_PASSES && charCount(best.raw) < SPARSE_RATIO * ds.ink) {
      const recipe: PassRecipe = { psm: 11, thresholding: best.recipe.thresholding }
      const r = run('sparse', copy.image, paramsFor(dpi, recipe))
      full++
      if (r.score > best.score) best = { ...r, id: 'sparse', recipe }
    }
  }

  // §3.4.3: the adaptive pass roughly doubles a page's cost, so a first result that already reads
  // with high confidence skips it.
  const confident = adaptiveSkip(best.raw, table)
  const adaptive =
    opts.reuse || opts.adaptive === false || confident ? null : adaptiveRequest(best.raw, dpi)
  const out: RecognizeOutcome = {
    raw: best.raw,
    chosen: best.id,
    passes,
    toSource: copy.toSource,
    orientation: ((plan.quarterTurns * 90) % 360) as Orientation,
    plan,
    recipe: best.recipe,
    adaptive,
    stats: {
      photo,
      noisy: ds.noisy,
      specks: ds.specks,
      borderRemoved: border.removed,
      ink: ds.ink,
      vertical,
      skew,
      orientationChecked,
      ...(bandStats ? { band: bandStats } : {}),
      flipped,
      chars: charCount(best.raw),
      meanConfCal: calibratedMean(best.raw, table)
    }
  }
  if (opts.returnHocr) {
    out.hocr = hocrs
    out.recognitions = records
  }
  return out
}

/**
 * Tests only (the PR5 engine-level replay cache, engine.ocr.test.ts): exactly pass 1 (PSM 3, Otsu)
 * on the raster as given, no preprocessing and no geometry, so the recorded hOCR stays in the
 * raster's own pixels.
 */
export function recognizeRawPass1(
  engine: RecognizeEngine,
  img: GrayImage,
  dpi: number,
  returnHocr = false
): RecognizeOutcome {
  const src = packed(img)
  const params = paramsFor(dpi, { psm: 3, thresholding: 0 })
  const t0 = performance.now()
  const { hocr } = engine.recognize(src, params)
  const raw = hocrToRaw(parseHocr(hocr))
  const out: RecognizeOutcome = {
    raw,
    chosen: 'pass1',
    passes: [
      {
        id: 'pass1',
        ms: Math.round(performance.now() - t0),
        words: wordCount(raw),
        score: passScore(raw)
      }
    ],
    toSource: IDENTITY,
    orientation: 0,
    plan: { quarterTurns: 0, skewDeg: 0 },
    recipe: { psm: 3, thresholding: 0 },
    adaptive: null,
    stats: {
      photo: false,
      noisy: false,
      specks: 0,
      borderRemoved: 0,
      ink: 0,
      vertical: false,
      skew: { deg: 0, conf: 0, applied: false },
      orientationChecked: false,
      flipped: false,
      chars: charCount(raw),
      meanConfCal: null
    }
  }
  if (returnHocr) {
    out.hocr = [hocr]
    out.recognitions = [
      { id: 'pass1', params, width: src.width, height: src.height, fnv: fnv1a(src.data) }
    ]
  }
  return out
}
