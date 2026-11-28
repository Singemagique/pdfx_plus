// Export-time rules of the invisible OCR text layer (DESIGN.md §3.7.1, §3.7.3, §3.7.5): which
// recognised pages an export may carry, the crop-outside drop, the catalog /Lang rule and the
// machine-generated Producer suffix. Pure (no pdf-lib): useExport imports it, and build.ts applies
// the same per-page gate again at bake time.
//
// REDACTION SAFETY (§3.7.3, a security-reviewed rule set). Every recognised page an export bakes
// goes through `redactOcrPage` first, in `withOcrLayer` and again in build.ts at bake time:
// - Rule 1: a word whose padded footprint (§3.5.1) intersects ANY redaction on its page is dropped,
//   whatever the z-order (OCR describes source pixels, which the PDFium pass removes regardless of
//   overlay z, so mirror.ts's `drawnAbove` does not apply). Partial overlap drops the whole word.
// - Rule 2: a word intersecting any object the redaction pass REMOVED (`removed`, from
//   redact-export.ts `buildRedactedSources({ report: true })`) is dropped too: a full-page scan,
//   a scan in a Form XObject or in strips, an inset photo, a vector stamp. Fail-safe: when a
//   redacted page has no report entry (or no report was given), or any removed extent is unknown
//   (non-finite), the page's WHOLE layer is dropped.
// - Rule 3: the same function serves PDF, ZIP, Sign and the .pdfx bake. The .pdfx bake filters
//   against the in-memory edit-layer redactions plus `removed`, because the .pdfx source bytes are
//   already destructively redacted (§3.0 #1). The OCR store is never mutated: undoing a redaction
//   brings the words back.
// - Rule 5: the font tables are built only from what is baked (ocr-font.ts `finalize`, one font per
//   page in build.ts), so a dropped word's characters cannot survive in a ToUnicode CMap.
// A layer the SOURCE already carries (a reopened PDFx export) is handled by the redaction pass
// itself: it removes all of that page's OCR text and unbinds its font (redact-export.ts).

import type { Geom, Overlay } from '../edit/model'
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
import { bboxesIntersect } from './mirror'

/** Appended to the document's Producer whenever an OCR layer is written (§3.7.1). */
export const OCR_PRODUCER_SUFFIX = '; text layer by PDFx OCR (machine-generated)'

/**
 * The redaction pass's removed-object report: page key → the bounds (overlay frame) of every
 * object it removed from that page, an entry for every redacted page. A non-finite rect is an
 * unknown extent.
 */
export type RemovedReport = ReadonlyMap<string, readonly FrameBox[]>

/** The redaction overlays of a page. */
const redactionsOf = (overlays: readonly Overlay[] | undefined): Overlay[] =>
  overlays?.filter((o) => o.type === 'redaction') ?? []

const finiteBox = (b: FrameBox): boolean =>
  Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h)

/** A frame box as an unrotated `Geom`, the shape mirror.ts `bboxesIntersect` takes. */
const asGeom = (b: FrameBox): Geom => ({ ...b, rotation: 0, opacity: 1 })

/**
 * The words of recognised page `page` (page key `key`) an export of `edits` may bake, under the
 * redaction rules of the header: `page` itself when nothing is dropped, a filtered copy, or null
 * when no word is left or the fail-safe drops the whole layer.
 */
export function redactOcrPage(
  page: PackedOcrPage,
  edits: Pick<EditLayer, 'overlays'>,
  key: string,
  removed: RemovedReport | undefined
): PackedOcrPage | null {
  const reds = redactionsOf(edits.overlays.get(key))
  const gone = removed?.get(key)
  if (!reds.length && !gone?.length) return wordCount(page) > 0 ? page : null
  // A redacted page needs the pass's report; an unknown extent removes everything.
  if (reds.length && !gone) return null
  if (gone?.some((b) => !finiteBox(b))) return null
  const boxes = [...reds.map((r) => r.geom), ...(gone ?? []).map(asGeom)]
  return filterOcrWords(page, (word, line) => {
    const f = wordFootprint(word, line)
    const fp: FrameBox = { x: f.x0, y: f.y0, w: f.x1 - f.x0, h: f.y1 - f.y0 }
    // A word whose own geometry is not finite cannot be placed, so it cannot be proved clear.
    if (!finiteBox(fp)) return false
    const g = asGeom(fp)
    return !boxes.some((b) => bboxesIntersect(b, g))
  })
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
 * Every page goes through `redactOcrPage` against the copy's redactions and `removed` (the report
 * of the redaction pass whose bytes the build uses); pages left without words are left out. With
 * nothing left (or `ocr` undefined: no results, or the setting or the Sign checkbox is off) the
 * copy has no `ocr` at all, whatever `editLayer` carried. `include` is that setting or checkbox:
 * it decides whether layers already in the sources are kept (`ocrPassthrough`). The copy carries
 * `removed` as `ocrRemoved`, so build.ts re-applies the same filter at bake time.
 */
export function withOcrLayer(
  editLayer: EditLayer,
  ocr: ReadonlyMap<string, PackedOcrPage> | undefined,
  opts: { include: boolean; removed?: RemovedReport }
): EditLayer {
  const { ocr: _previous, ocrRemoved: _report, ...rest } = editLayer
  const base: EditLayer = { ...rest, ocrPassthrough: opts.include ? 'keep' : 'drop' }
  if (!ocr || !opts.include) return base
  const kept = new Map<string, PackedOcrPage>()
  for (const [key, page] of ocr) {
    const safe = redactOcrPage(page, editLayer, key, opts.removed)
    if (safe) kept.set(key, safe)
  }
  if (!kept.size) return base
  return opts.removed ? { ...base, ocr: kept, ocrRemoved: opts.removed } : { ...base, ocr: kept }
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
