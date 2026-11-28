// Applying the Replace / Remove Recognized Text choices to the recognition results (DESIGN.md
// §3.5.2, §3.7.6), for the export snapshot (`OcrExportSource.snapshotFor`, export-source.ts). The
// choices are the edit history's `ocrSelect` op (edit-history.ts), carried on `EditLayer`; the
// results are the OCR store's, outside history. Pure: the store (PR7b) calls it with its entries.

import type { PackedOcrPage } from '../../../shared/ocr/types'
import type { EditLayer } from '../pdfx/build'

/** The recognition results the store holds for one live page. */
export interface PageResults {
  /** configHash → result (every config the page was recognised with). */
  results: ReadonlyMap<string, PackedOcrPage>
  /**
   * The configHash a page with no choice exports with: its automatic recognition. Absent for a
   * page whose default is to skip (`ocr-ours`: its own source layer stays, §3.7.6).
   */
  auto?: string
}

/**
 * The page per page key an export bakes: the result the page's `ocrSelect` choice names (Replace),
 * nothing for null (Remove), or, without a choice, its automatic result. A choice naming a result
 * the store does not hold (still running, or failed) bakes nothing, never another result; the page
 * still loses its source layer (build.ts `dropsSourceOcr`). Undefined when no page bakes anything.
 */
export function applyOcrSelections(
  pages: ReadonlyMap<string, PageResults>,
  select: EditLayer['ocrSelect']
): Map<string, PackedOcrPage> | undefined {
  const out = new Map<string, PackedOcrPage>()
  for (const [key, { results, auto }] of pages) {
    const chosen = select?.has(key) ? select.get(key)! : auto
    if (chosen === null || chosen === undefined) continue
    const page = results.get(chosen)
    if (page) out.set(key, page)
  }
  return out.size ? out : undefined
}
