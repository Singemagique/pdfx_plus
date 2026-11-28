// The recognize thread's per-page pipeline (DESIGN.md §3.4.3–§3.4.6), as pure functions over an
// engine, so vitest runs it with the real core (tier 1), a replayed one (tier 0) or a fake one.
//
// One call recognises one raster:
//  1. Preprocess the OCR copy (never the page): background normalisation when the page looks like
//     a photo (or, for a photo placed on a white page, inside the photo's box), border removal, conditional despeckle (src/shared/ocr/preprocess/*; none of these
//     moves a pixel).
//  2. Geometry: the 90° projection test, then deskew (sweep and search on the 1/4-scale binary
//     copy), then a 16 px white pad. `toSource` maps the copy's pixels back to the raster's, so
//     every word and char box is mapped back with the inverse rotation (map.ts takes the affine).
//     An edit rotation the page already has is tried first, on the axis the 90° test found.
//  3. Pass 1: PSM 3, Otsu. If it reads doubtfully, the 0°/180° test (a quarter-height band placed
//     on the text, PSM 6, both ways; turn only if confidence AND plausibility agree), and when
//     neither way reads well the same on the copy turned a quarter (90° vs 270°). On a turn,
//     pass 1 again on the turned copy, kept only if it scores higher than the first.
//  4. Retry A (Sauvola) if the calibrated mean is below the retry threshold; Retry B (PSM 11) if
//     the OCR chars are under 30% of the ink components. Keep the higher Σ(conf × chars). At most
//     MAX_PASSES full-page recognitions, run against whichever pass 1 was kept; the band reads
//     are not counted (they are a quarter page each, four at most).
//  5. The adaptive pass is asked for, not run: the x-height (or, for scripts without one, the char
//     height) says the page needs more pixels, and only the raster thread can render them. The
//     coordinator re-renders at `adaptive.dpi` and calls again with `reuse`, which skips the
//     geometry tests and runs the chosen recipe once (page-plan.ts decides which result wins).

import { calibrate, TESS_CALIBRATION, thresholdsFor } from '../../../shared/ocr/calibration'
import type { CalibrationTable, GrayImage, RawOcr } from '../../../shared/ocr/engine/types'
import { TessError, fullPageParams, type TessParams } from '../../../shared/ocr/engine/tess-core'
import { hocrToRaw, parseHocr } from '../../../shared/ocr/hocr'
import { noXHeightScript } from '../../../shared/ocr/map'
import { normalizeRegion, photoRegion } from '../../../shared/ocr/preprocess/background'
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
  FLIP_CONF_DELTA,
  FLIP_MIN_WORDS,
  bandReading,
  plausibility,
  profileTest,
  shouldFlip,
  textBand,
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
  /** The same on the copy turned a quarter, when neither of those read plausibly. */
  bandQuarter?: { asIs: BandReading; flipped: BandReading }
  /** The band test turned the copy (by 180° or a quarter) and the turned pass 1 was kept. */
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
 * A first result with at least `share` of its chars in words read at raw confidence ≥ `raw` skips
 * the adaptive pass (§3.4.3: "may skip it when the first pass's confidence is already high").
 *
 * Raw, not calibrated: the fitted curve is steep at the top (P = 0.83 at raw 90, 0.994 at 95), so
 * a calibrated mean reaches P(95) only when nearly every word does, and it moved with every refit
 * of the table [measured, PR6 review: smallprint6pt and its blur read at calibrated means of
 * 0.990–0.995 and 10 of 12 pages took the pass]. [measured, PR6 review, seeds 1–3 ×
 * Helvetica/Times, HEAD before this change:] smallprint6pt has 0.97–0.99 of its chars at ≥ 95 and
 * recall 1.000 at 300 DPI, which the pass never improved; smallprint6pt-blur 0.94–0.99, where the
 * kept adaptive read lowered recall on 4 of 6 pages (e.g. 0.988 → 0.974) and raised it on 1; both
 * now skip, saving ~1.6–2.0 s a page. smallprint6pt-fax (0.26–0.88) still runs it, though there
 * the first read was kept on all 6 pages.
 */
export const ADAPTIVE_SKIP = { raw: 95, share: 0.9 } as const

/** Does this result read well enough to skip the adaptive pass? */
export function adaptiveSkip(raw: RawOcr): boolean {
  let at = 0
  let all = 0
  for (const l of raw.lines)
    for (const w of l.words) {
      if (w.conf === null || w.conf < 0) continue
      const k = [...w.text].length
      all += k
      if (w.conf >= ADAPTIVE_SKIP.raw) at += k
    }
  return all > 0 && at >= ADAPTIVE_SKIP.share * all
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

/** A band reading that clears pass 1's doubt test (DOUBT) on both signals. */
export function readsWell(b: BandReading): boolean {
  return b.meanConf >= DOUBT.meanConf && b.plausibility >= DOUBT.plausibility
}

/**
 * Does a band read on the copy turned a quarter beat the 0°/180° reads (best mean confidence
 * `refConf`)? Both signals again, in the form a quarter turn needs: the confidence rises by
 * FLIP_CONF_DELTA (with FLIP_MIN_WORDS words) AND the turned band reads like text (plausibility at
 * DOUBT's level). Not a plausibility rise: a sideways receipt's garbage is short tokens and digits
 * that score as plausible as real text: 0.53–0.88 [measured, PR6 review: receipt90 in Helvetica
 * and Times, seeds 1/3/5], against 0.94–0.98 for its upright band in Helvetica, whose mean conf
 * (53–71) is 29–38 above the best sideways read. A turn still has to win the full-page score.
 */
export function quarterWins(refConf: number, cand: BandReading): boolean {
  return (
    cand.words >= FLIP_MIN_WORDS &&
    cand.meanConf - refConf >= FLIP_CONF_DELTA &&
    cand.plausibility >= DOUBT.plausibility
  )
}

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
  /**
   * The table Retry A's gate reads (default TESS_CALIBRATION). The calibration run passes a fixed one,
   * so the fit does not depend on the table it replaces (calibrate.ocr.test.ts).
   */
  calibration?: CalibrationTable
  /** Ask for the adaptive pass at all (default true; never on a `reuse` call). */
  adaptive?: boolean
  /**
   * The page's edit rotation (§3.4.5 priors): pass 1 reads the copy turned this way first when it
   * lies on the 90° test's axis (it then picks 180 over 0, or 270 over 90); the band tests still
   * turn it when both of their signals disagree. A prior across the axis is not tried.
   */
  prior?: Orientation
}

/** Recognise one page raster (see the header). */
export function recognizePage(
  engine: RecognizeEngine,
  img: GrayImage,
  dpi: number,
  opts: RecognizePageOptions = {}
): RecognizeOutcome {
  const now = opts.now ?? (() => performance.now())
  const table = opts.calibration ?? TESS_CALIBRATION
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
  const photoBox = photoRegion(src)
  const photo = photoBox !== null
  let base = photoBox ? normalizeRegion(src, photoBox, dpi) : src
  const border = removeBorder(base)
  base = border.image
  const ds = despeckle(base, dpi)
  base = ds.image

  // 2. Geometry (§3.4.5).
  let plan: GeometryPlan
  let vertical = false
  let skew = { deg: 0, conf: 0, applied: false }
  // The deskew for a copy turned by `turns`: the row profile's, or the quarter-turned mask's for an
  // odd turn (a half turn keeps a tilt's sense, so 0/180 and 90/270 share one).
  let skewFor: (turns: QuarterTurns) => number = () => 0
  if (opts.reuse) plan = { ...opts.reuse.plan }
  else {
    const q = boxDownscale(base, QUARTER)
    const t = otsu(histogram(q))
    const prof = profileTest(binarize(q, t), q.width, q.height)
    vertical = prof.vertical
    skewFor = (turns) => {
      const s = turns % 2 ? prof.cols : prof.rows
      return s.apply ? s.deg : 0
    }
    // §3.4.5 priors: an edit rotation the page already has is tried first, on the axis the 90° test
    // found (0/180, or 90/270 when the lines run vertically). A prior across that axis is not
    // tried: Tesseract reads a sideways copy of a clean page at full confidence, so nothing after
    // pass 1 could undo a wrong quarter turn [measured, PR6 review: clean300 with prior 90, pass 1
    // scored 55,624 like the upright read, no band test ran, Find recall 0.23].
    const axis: QuarterTurns = vertical ? 1 : 0
    const p = opts.prior ? ((opts.prior / 90) as QuarterTurns) : null
    const turns: QuarterTurns = p !== null && p % 2 === axis ? p : axis
    const s = turns % 2 ? prof.cols : prof.rows
    skew = { deg: s.deg, conf: s.conf, applied: s.apply }
    plan = { quarterTurns: turns, skewDeg: skewFor(turns) }
  }
  let copy = orientedCopy(base, plan)

  const recipe0: PassRecipe = opts.reuse?.recipe ?? { psm: 3, thresholding: 0 }
  let full = 0
  type Best = { raw: RawOcr; score: number; id: string; recipe: PassRecipe }
  const first = run(opts.reuse ? 'adaptive' : 'pass1', copy.image, paramsFor(dpi, recipe0))
  full++
  let best: Best = { ...first, id: opts.reuse ? 'adaptive' : 'pass1', recipe: recipe0 }

  // 3. Orientation, only when pass 1 reads doubtfully: 0° vs 180° on a band of the copy, then, if
  // neither way reads well, 90° vs 270° on a band of the copy turned a quarter.
  let orientationChecked = false
  let flipped = false
  let bandStats: PipelineStats['band']
  let quarterStats: PipelineStats['bandQuarter']
  if (
    !opts.reuse &&
    (rawMeanConf(best.raw) < DOUBT.meanConf || plausibility(best.raw) < DOUBT.plausibility)
  ) {
    orientationChecked = true
    const bandParams = { ...fullPageParams(dpi), tessedit_pageseg_mode: 6 }
    const readBoth = (img: Gray, id: string): { asIs: BandReading; flipped: BandReading } => {
      const bandH = Math.max(1, Math.floor((img.height * BAND_NUM) / BAND_DEN))
      const y0 = textBand(img, bandH)
      const band = cropRows(img, y0, y0 + bandH)
      return {
        asIs: bandReading(run(id, band, bandParams).raw),
        flipped: bandReading(run(`${id}-flipped`, rotateQuarterCW(band, 2).image, bandParams).raw)
      }
    }
    const turn = (by: number): QuarterTurns => ((plan.quarterTurns + by) % 4) as QuarterTurns
    bandStats = readBoth(copy.image, 'band')
    let target: { turns: QuarterTurns; id: string } | null = null
    if (shouldFlip(bandStats.asIs, bandStats.flipped))
      target = { turns: turn(2), id: 'pass1-flipped' }
    else if (!readsWell(bandStats.asIs) && !readsWell(bandStats.flipped)) {
      // Neither way up reads well: maybe the lines run the other way and the 90° test missed them
      // [measured, PR6 review: receipt90 (narrow, short lines) read as vertical=false in 3 fonts].
      // Turned a quarter clockwise, the band as is is turn(1) and flipped turn(3).
      const qPlan = { quarterTurns: turn(1), skewDeg: skewFor(turn(1)) }
      quarterStats = readBoth(orientedCopy(base, qPlan).image, 'band-quarter')
      const refConf = Math.max(bandStats.asIs.meanConf, bandStats.flipped.meanConf)
      const cw = quarterWins(refConf, quarterStats.asIs)
      const ccw = quarterWins(refConf, quarterStats.flipped)
      if (cw && (!ccw || quarterStats.asIs.meanConf >= quarterStats.flipped.meanConf))
        target = { turns: turn(1), id: 'pass1-turned' }
      else if (ccw) target = { turns: turn(3), id: 'pass1-turned' }
    }
    if (target) {
      // §3.4.5's keep-the-better rule applies to a turn too: the band can be the odd part of the
      // page (a fold-over mailer's upside-down address block in the middle of upright text).
      const tPlan = { quarterTurns: target.turns, skewDeg: skewFor(target.turns) }
      const tCopy = orientedCopy(base, tPlan)
      const again = run(target.id, tCopy.image, paramsFor(dpi, recipe0))
      full++
      if (again.score > best.score) {
        flipped = true
        plan = tPlan
        copy = tCopy
        best = { ...again, id: target.id, recipe: recipe0 }
      }
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
  const confident = adaptiveSkip(best.raw)
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
      ...(quarterStats ? { bandQuarter: quarterStats } : {}),
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
