// Conditional despeckle (DESIGN.md §3.4.4 step 3): only on a noisy page (more than ~2,000 tiny
// components per megapixel), remove the ink components of at most 4 px² × (dpi/300)², never
// above 9 px² (a 10 pt period at 300 DPI is about 25 px²). Ink is the Otsu dark class. Removed
// specks are painted white; nothing moves.

import { labelComponents } from './components'
import { binarize, histogram, otsu, type Gray } from './image'

/** Tiny components per megapixel above which a page counts as noisy. */
export const NOISY_PER_MP = 2000

/** The largest speck (px²) removed at `dpi`: 4 × (dpi/300)², at most 9. */
export function maxSpeck(dpi: number): number {
  return Math.max(1, Math.min(9, Math.floor((4 * dpi * dpi) / 90000)))
}

export interface DespeckleResult {
  image: Gray
  /** Components of ≤ maxSpeck px² before despeckling. */
  specks: number
  noisy: boolean
  /**
   * Ink components bigger than a speck: Retry B's denominator (§3.4.5: OCR chars < 30% of them
   * means Tesseract missed most of the page's marks). Counted once here, on the same labelling.
   */
  ink: number
}

export function despeckle(img: Gray, dpi: number): DespeckleResult {
  const mask = binarize(img, otsu(histogram(img)))
  const { labels, components } = labelComponents(mask, img.width, img.height)
  const limit = maxSpeck(dpi)
  let specks = 0
  for (const c of components) if (c.area <= limit) specks++
  const ink = components.length - specks
  // specks / (w·h / 10^6) > NOISY_PER_MP, cross-multiplied.
  const noisy = specks * 1_000_000 > NOISY_PER_MP * img.width * img.height
  if (!noisy) return { image: img, specks, noisy, ink }
  const out = img.data.slice()
  for (let i = 0; i < out.length; i++) {
    const l = labels[i]
    if (l && components[l - 1].area <= limit) out[i] = 255
  }
  return { image: { width: img.width, height: img.height, data: out }, specks, noisy, ink }
}
