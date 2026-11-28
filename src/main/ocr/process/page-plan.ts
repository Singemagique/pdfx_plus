// The per-page decisions between the raster thread and the recognize thread (DESIGN.md §3.4.2,
// §3.4.3), as pure functions, so the coordinator and the tier-1 page harness take them the same
// way: the render DPI and flags of the first render, whether and at what DPI the adaptive pass
// re-renders, which of the two results is kept, and the pixel → overlay affine of the result.

import { pixelToOverlay, type Affine } from '../../../shared/ocr/map'
import { compose } from '../../../shared/ocr/preprocess/geometry'
import { fitRaster, type PixelCaps, type TriagePage } from '../../../shared/ocr/triage'
import { FPDF_RENDER_NO_SMOOTHIMAGE, RENDER_FLAGS } from './raster-core'
import {
  ADAPTIVE_MAX_DPI,
  passScore,
  type AdaptiveRequest,
  type RecognizeOutcome
} from './recognize-core'

/** The DPI a page renders at when nothing better is known (no triage, no request DPI). */
export const DEFAULT_RENDER_DPI = 300

/**
 * PR6's A/B of FPDF_RENDER_NO_SMOOTHIMAGE (§3.4.2) for pages whose dominant image is 1-bit and
 * rendered at ≤ 1.5× its native density, scored by the codec outcome gate's rule (Find recall
 * first, then CER) [measured, pipeline.ocr.test.ts, adaptive pass off on both sides]:
 * - fax200 (1.5×), bilevel240 (1.25×), bilevel300 (exact 1:1): recall 100% and CER 0 either way.
 *   (At an exact integer 1:1 placement PDFium copies the bits with or without the flag.)
 * - smallprint6pt-fax (6 pt at 200 DPI, 1.5×): smoothing on 99.1% / CER 0.27%, off 97.4% / 0.58%.
 * So smoothing stays ON (the flag is never passed); the rule and the flag plumbing stay, so a
 * future codec fixture or the real corpus can flip this constant.
 */
export const NO_SMOOTH_1BIT = false
/** Above this render scale over native, smoothing stays on (upscaled 1-bit edges turn blocky). */
export const NO_SMOOTH_MAX_SCALE = 1.5

/** The render flags for a page: 0, plus NO_SMOOTHIMAGE for a 1-bit image at ≤ 1.5× native. */
export function renderFlagsFor(
  t: Pick<TriagePage, 'bitsPerPixel' | 'effectiveDpi'> | undefined,
  renderDpi: number,
  noSmooth1Bit = NO_SMOOTH_1BIT
): number {
  if (!noSmooth1Bit || !t || t.bitsPerPixel !== 1 || !t.effectiveDpi) return RENDER_FLAGS
  return renderDpi <= NO_SMOOTH_MAX_SCALE * t.effectiveDpi
    ? RENDER_FLAGS | FPDF_RENDER_NO_SMOOTHIMAGE
    : RENDER_FLAGS
}

/** The adaptive pass gains nothing below this DPI ratio (a re-render within 5% is the same). */
const MIN_GAIN = 1.05

/**
 * The adaptive re-render (§3.4.3): `request.dpi` capped at 600 DPI, at 2 × native for image-origin
 * pages, then at the pixel caps; null when that leaves no real gain over `renderDpi`.
 */
export function adaptiveRender(
  request: AdaptiveRequest,
  renderDpi: number,
  frame: { width: number; height: number },
  t: Pick<TriagePage, 'imageOrigin' | 'effectiveDpi'> | undefined,
  caps: PixelCaps
): { dpi: number; width: number; height: number } | null {
  let dpi = Math.min(ADAPTIVE_MAX_DPI, request.dpi)
  if (t?.imageOrigin && t.effectiveDpi) dpi = Math.min(dpi, 2 * t.effectiveDpi)
  dpi = Math.floor(dpi * 100) / 100
  const fit = fitRaster(frame.width, frame.height, dpi, caps)
  if (!(fit.dpi >= MIN_GAIN * renderDpi)) return null
  return fit
}

/** Keep the adaptive result only when it scores higher (Σ conf × chars, §3.4.5). */
export function keepAdaptive(first: RecognizeOutcome, second: RecognizeOutcome): boolean {
  return passScore(second.raw) > passScore(first.raw)
}

/** The affine from a result's OCR-copy pixels to the overlay frame (pt, bottom-left origin). */
export function overlayAffine(
  outcome: Pick<RecognizeOutcome, 'toSource'>,
  frame: { width: number; height: number },
  raster: { width: number; height: number }
): Affine {
  return compose(outcome.toSource, pixelToOverlay(frame, raster))
}
