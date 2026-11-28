// Export-time rules of the invisible OCR text layer (DESIGN.md §3.7.1, §3.7.3, §3.7.5): which
// recognised pages an export may carry, the crop-outside drop, the catalog /Lang rule and the
// machine-generated Producer suffix. Pure (no pdf-lib): useExport imports it, and build.ts applies
// the same per-page gate again at bake time.
//
// REDACTION SAFETY (until PR3b). PR3b adds the precise filter: drop each word whose footprint meets
// a redaction or an object the PDFium pass removed. Until then the rule is the fail-safe whole-page
// drop that §3.7.3 rule 2 prescribes when the removed-object extent is unknown: a page with ANY
// redaction overlay, or with ANY entry in the redaction pass's removed report, gets no OCR layer
// at all. The font tables are built only from what is baked (ocr-font.ts `finalize`), so such a
// page's characters cannot survive in a ToUnicode CMap either. A layer the SOURCE already carries
// (a reopened PDFx export) goes the same way on a redacted page: the redaction pass removes all of
// its text and unbinds its font (redact-export.ts), and every baked page has its own font
// (build.ts), so no other page's font holds the redacted page's characters.

import type { Overlay } from '../edit/model'
import { bcp47FromTesseract } from '../../../shared/ocr/lang'
import {
  pack,
  unpack,
  wordCount,
  wordFootprint,
  type OcrLine,
  type OcrWord,
  type PackedOcrPage
} from '../../../shared/ocr/types'
import type { EditLayer } from './build'

/** Appended to the document's Producer whenever an OCR layer is written (§3.7.1). */
export const OCR_PRODUCER_SUFFIX = '; text layer by PDFx OCR (machine-generated)'

/**
 * The redaction pass's removed-object report: page key → the bounds (overlay frame) of every
 * object it removed. PR3b fills it; until then callers pass nothing. Any entry for a page, empty
 * or not, keeps that page's OCR layer out of the export.
 */
export type RemovedReport = ReadonlyMap<string, readonly unknown[]>

/** Does `overlays` hold a redaction? */
const anyRedaction = (overlays: readonly Overlay[] | undefined): boolean =>
  !!overlays?.some((o) => o.type === 'redaction')

/**
 * May page `key` carry an OCR layer in an export of `edits`? Not when the page has any redaction
 * overlay, or any entry in `removed` (the fail-safe whole-page drop, see the header).
 */
export function ocrAllowed(
  edits: Pick<EditLayer, 'overlays'>,
  key: string,
  removed?: RemovedReport
): boolean {
  return !anyRedaction(edits.overlays.get(key)) && !removed?.has(key)
}

/**
 * What an export does with a PDFx OCR layer a SOURCE page already carries (a reopened PDFx export,
 * `ocr-ours` in §3.7.6): `keep` it (it is then marked machine-generated like a new one) or `drop`
 * it. `drop` is what "Include Recognized Text When Exporting" off and an unticked Sign box mean:
 * the output carries no machine text at all (D7). A redacted page loses its layer either way (the
 * redaction pass, redact-export.ts).
 */
export type OcrPassthrough = 'keep' | 'drop'

/**
 * A COPY of `editLayer` carrying the recognised pages an export may bake (`ocr`), like
 * `withSignatureAppearance`: EditProvider's memoised `editLayer` never changes because of OCR.
 * Pages that `ocrAllowed` refuses, and pages without words, are left out; with nothing left (or
 * `ocr` undefined: no results, or the setting or the Sign checkbox is off) the copy has no `ocr`
 * at all, whatever `editLayer` carried. `include` is that setting or checkbox: it decides whether
 * layers already in the sources are kept (`ocrPassthrough`).
 */
export function withOcrLayer(
  editLayer: EditLayer,
  ocr: ReadonlyMap<string, PackedOcrPage> | undefined,
  opts: { include: boolean; removed?: RemovedReport }
): EditLayer {
  const { ocr: _previous, ...rest } = editLayer
  const base: EditLayer = { ...rest, ocrPassthrough: opts.include ? 'keep' : 'drop' }
  if (!ocr || !opts.include) return base
  const kept = new Map<string, PackedOcrPage>()
  for (const [key, page] of ocr)
    if (wordCount(page) > 0 && ocrAllowed(editLayer, key, opts.removed)) kept.set(key, page)
  return kept.size ? { ...base, ocr: kept } : base
}

/**
 * `page` with only the words `keep` accepts (lines left empty go too); the same object when every
 * word is kept, null when none is.
 */
export function filterOcrWords(
  page: PackedOcrPage,
  keep: (word: OcrWord, line: OcrLine) => boolean
): PackedOcrPage | null {
  const view = unpack(page)
  let kept = 0
  const lines: OcrLine[] = []
  for (const line of view.lines) {
    const words = line.words.filter((w) => keep(w, line))
    kept += words.length
    if (words.length) lines.push({ ...line, words })
  }
  if (kept === 0) return null
  if (kept === wordCount(page)) return page
  return pack({ ...view, lines })
}

/** A box in the overlay frame (PDF points, bottom-left origin), as `visibleBox` returns it. */
export interface FrameBox {
  x: number
  y: number
  w: number
  h: number
}

/**
 * PDF export's crop rule (§3.7.5): words whose footprint lies ENTIRELY outside `box` (the page's
 * `visibleBox()` after edit crop) are dropped; partly visible words are kept. Not used for
 * `.pdfx`, where crop is still a live mirror edit.
 */
export function dropWordsOutside(page: PackedOcrPage, box: FrameBox): PackedOcrPage | null {
  return filterOcrWords(page, (word, line) => {
    const f = wordFootprint(word, line)
    return f.x1 > box.x && f.x0 < box.x + box.w && f.y1 > box.y && f.y0 < box.y + box.h
  })
}

/**
 * The catalog /Lang of an output document (§3.7.5). `sourceLangs` holds the /Lang of every source
 * document the output copies from (undefined where none is declared): `copyPages` never carries it.
 * `ocrLangs` holds, per OUTPUT page, the Tesseract code of the primary language of the layer baked
 * there (undefined for a page without one).
 *
 * - All sources that declare a /Lang agree (case-insensitively): that value.
 * - Otherwise, when NO source declares one, OCR'd pages are the majority of the output pages and
 *   they share one primary language: that language as BCP 47.
 * - Otherwise: none.
 */
export function catalogLang(
  sourceLangs: readonly (string | undefined)[],
  ocrLangs: readonly (string | undefined)[]
): string | undefined {
  const declared = sourceLangs.filter((l): l is string => !!l && l.trim() !== '')
  if (declared.length) {
    const first = declared[0].trim()
    return declared.every((l) => l.trim().toLowerCase() === first.toLowerCase()) ? first : undefined
  }
  const ocrd = ocrLangs.filter((l): l is string => l !== undefined)
  if (ocrd.length * 2 <= ocrLangs.length) return undefined
  if (!ocrd.every((l) => l === ocrd[0])) return undefined
  const tag = bcp47FromTesseract(ocrd[0])
  return tag === 'und' ? undefined : tag
}
