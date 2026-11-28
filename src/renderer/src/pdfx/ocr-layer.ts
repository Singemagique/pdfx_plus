// The invisible OCR text layer (DESIGN.md §3.7.5): a pure function from one recognised page to the
// bytes of its own content stream, plus the two pdf-lib helpers that prepend such a stream to a
// page and drop it again (Replace / Remove, §3.7.6).
//
//   q
//    1 0 0 1 vx vy cm  a b c d e f cm                  % view origin + intrinsic /Rotate (as overlays)
//    /PDFxOCR <</Lang (en) /MachineGenerated true /Engine (…)>> BDC
//     BT 3 Tr /FOcr <size> Tf                         % one BT/ET and one size per line
//      <cos sin -sin cos x y> Tm <tz> Tz <cids> Tj     % one Tj per word, at its baseline start
//      <tz_gap> Tz <space> Tj                          % a real U+0020 stretched across the gap
//      …                                              % trailing space unless the line ends in '-'
//     ET
//     BT … ET
//    EMC
//   Q
//
// Why each choice (R6, R13 in §5):
// - `3 Tr` (invisible) in every BT, and the stream is PREPENDED, so a renderer that ignores Tr still
//   paints the scan over the text. Direct page content, never a Form XObject: PDFium sees a Form
//   XObject as one page object, and a later redaction would delete the whole layer.
// - `Tz` before EVERY `Tj`: Poppler does not carry Tz across BT/ET (OCRmyPDF #1632). Word width
//   comes from Tz, never from splitting a word; `Tw` is never used (it ignores 2-byte codes).
// - An explicit U+0020 between words AND the real geometric gap: extractors that build words from
//   gaps (pdf.js, Preview) and those that trust space characters (PDFium copy) agree. Where the
//   engine's boxes touch or overlap (italics, kerned pairs, tight justification), the previous
//   word is narrowed so at least MIN_WORD_GAP_EM separates the two: pdf.js joined words up to
//   0.02 em apart despite the space glyph, PDFium from ~0.1 em of overlap [measured].
// - Upside-down lines (angle π: an orientation-180 scan the user did not turn upright) read
//   correctly in pdf.js but come out of PDFium (Chrome/Edge copy) in reversed word order: PDFium
//   orders a line's text objects by display x, and one Tj per word makes every word its own
//   object. Content order cannot change that, and one object per line would make a redaction
//   remove the whole line. Once the page is turned upright with /Rotate (the "looks upside down —
//   Rotate?" offer, §3.4.5), PDFium's display frame includes the rotation and the order is right.
//   Known PDFium limitation, pinned in the layer suite.
// - One Tj per word, so a later PDFium redaction removes exactly the words it touches.
// - Oblique lines (not a multiple of 90°) all share one page-wide Tz and take each word's width
//   from `Tc`: pdf.js 5.7.284 reads a Tz change on a tilted baseline as a line break (see `show`).
// - CJK: no space where `needsSpaceBetween` says so (shared with the Find supply, §3.6.1); the
//   previous word's Tz is stretched to meet the next one when the gap is ≤ 2 em.

import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFName,
  PDFRef,
  PDFStream,
  type PDFObject,
  type PDFPage
} from 'pdf-lib'

import { bcp47FromTesseract } from '../../../shared/ocr/lang'
import { needsSpaceBetween } from '../../../shared/ocr/spacing'
import { cleanOcrText } from '../../../shared/ocr/text'
import { ocrLines, type OcrLine, type PackedOcrPage } from '../../../shared/ocr/types'
import { isOcrFontDict, OCR_NARROW, type OcrFontCache } from './ocr-font'
import { deleteUnreachable } from './reachable'

export type Matrix = [number, number, number, number, number, number]

/** The page-space pair overlays are baked through (build.ts `bakePage`). */
export interface OcrPageSpace {
  /** Lower-left corner of the page's view box (CropBox ∩ MediaBox), user space. */
  view: { x: number; y: number }
  /** build.ts `intrinsicMatrix` for a source /Rotate of 90/180/270; null when unrotated. */
  intrinsic: Matrix | null
}

export interface OcrLayerOptions {
  space?: OcrPageSpace
  /** Font resource name the stream uses (default `FOcr`). */
  fontName?: string
  /** BCP 47 tag for the marked-content /Lang (default: from the page's first language). */
  lang?: string
  /** Engine id for the property list (default: `page.engineId`). */
  engine?: string
}

export interface OcrLayerContent {
  /** The content-stream bytes (ASCII). */
  bytes: Uint8Array
  /** Every CID the stream shows (for `OcrFontCache.track`). */
  cids: Set<number>
  /** Number of words written. */
  words: number
}

/** The private stream-dictionary key that tags a PDFx OCR layer stream (§3.7.2). */
export const OCR_LAYER_KEY = 'PDFxOCRLayer'
/** The marked-content tag around the layer. */
export const OCR_MARK = 'PDFxOCR'
export const OCR_FONT_RESOURCE = 'FOcr'
/** Tz is sanity-clamped to this range (percent); a word is never split to fit (§3.7.5). */
export const TZ_MIN = 1
export const TZ_MAX = 1000
/** Above this gap (in em) no stretched space is written: the space keeps its natural width. */
export const MAX_STRETCH_GAP_EM = 3
/**
 * Oblique lines: the largest per-glyph widening by Tc, in em (see `show`). pdf.js reads ≥ 0.102 em
 * as a space; PDFium inserted generated spaces at 0.09 em but none at 0.06 or below on 12 tilted
 * synth pages (skew2 + photoLike, seeds 1–6) [measured].
 */
export const OBLIQUE_TC_MAX = 0.05
/** The page Tz of oblique lines is this quantile of what their words need (the median). */
export const OBLIQUE_TZ_QUANTILE = 0.5
/** Up to this gap (in em) a CJK word's Tz stretches to meet the next CJK word. */
export const MAX_CJK_STRETCH_EM = 2
/**
 * The least separation (in em) between two space-separated words along the baseline: a closer
 * word is narrowed to keep it. pdf.js joined words up to 0.02 em apart and split them from 0.05;
 * PDFium joined them at 0.1 em of overlap [measured, PR2 review]; 0.15 leaves margin above
 * pdf.js's 0.102 em space threshold of tilted text (OBLIQUE_TC_MAX).
 */
export const MIN_WORD_GAP_EM = 0.15

/** A PDF number: at most `digits` decimals, no trailing zeros, no "-0". */
export function num(n: number, digits = 3): string {
  if (!Number.isFinite(n)) throw new Error(`ocr-layer: non-finite number ${n}`)
  const s = n.toFixed(digits).replace(/\.?0+$/, '')
  return s === '-0' || s === '' ? '0' : s
}

/** A PDF literal string with everything outside printable ASCII (and \ ( )) escaped in octal. */
export function pdfLiteral(s: string): string {
  let out = '('
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (ch === '\\' || ch === '(' || ch === ')') out += '\\' + ch
    else if (c >= 0x20 && c < 0x7f) out += ch
    else if (c < 0x100) out += '\\' + c.toString(8).padStart(3, '0')
    else out += '?'
  }
  return out + ')'
}

const clampTz = (tz: number): number => Math.min(TZ_MAX, Math.max(TZ_MIN, tz))

/** The q-quantile (0..1, nearest rank) of `values`; 100 when there are none. */
function quantile(values: number[], q: number): number {
  if (!values.length) return 100
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]
}

interface CleanWord {
  t: string
  x: number
  y: number
  w: number
}

function cleanWords(line: OcrLine): CleanWord[] {
  const out: CleanWord[] = []
  for (const w of line.words) {
    const t = cleanOcrText(w.t)
    if (t && Number.isFinite(w.x) && Number.isFinite(w.y) && Number.isFinite(w.w) && w.w > 0)
      out.push({ t, x: w.x, y: w.y, w: w.w })
  }
  return out
}

/**
 * The layer's content-stream bytes for one page, or null when no word survives cleaning. Words
 * are written exactly as given: filtering (redaction, crop) happens BEFORE this call, and only the
 * words written here ever get a CID. Pure apart from allocating CIDs in `fonts`.
 */
export function ocrLayerContent(
  page: PackedOcrPage,
  fonts: OcrFontCache,
  opts: OcrLayerOptions = {}
): OcrLayerContent | null {
  const lines: { line: OcrLine; words: CleanWord[] }[] = []
  for (const line of ocrLines(page)) {
    if (!(line.size > 0) || !Number.isFinite(line.angle)) continue
    const words = cleanWords(line)
    if (words.length) lines.push({ line, words })
  }
  if (!lines.length) return null

  const font = opts.fontName ?? OCR_FONT_RESOURCE
  const lang = opts.lang ?? bcp47FromTesseract(page.langs[0])
  const engine = opts.engine ?? page.engineId
  const cids = new Set<number>()
  let words = 0
  const ops: string[] = ['q']
  const space = opts.space
  if (space && (space.view.x !== 0 || space.view.y !== 0))
    ops.push(`1 0 0 1 ${num(space.view.x)} ${num(space.view.y)} cm`)
  if (space?.intrinsic) ops.push(`${space.intrinsic.map((v) => num(v, 6)).join(' ')} cm`)
  ops.push(
    `/${OCR_MARK} <</Lang ${pdfLiteral(lang)} /MachineGenerated true /Engine ${pdfLiteral(engine)}>> BDC`
  )

  const sp = fonts.encode(' ')
  // Plan every line first (CIDs are allocated in reading order, as they are written).
  const plans = lines.map(({ line, words: ws }) => {
    const { size } = line
    const cos = Math.cos(line.angle)
    const sin = Math.sin(line.angle)
    const c6 = num(cos, 6)
    const s6 = num(sin, 6)
    const words = ws.map((w, i) => {
      const enc = fonts.encode(w.t)
      const natural = (enc.units / 1000) * size
      const next = ws[i + 1]
      // Along the baseline: from this word's start to the next one's, and the gap between them.
      const along = next ? (next.x - w.x) * cos + (next.y - w.y) * sin : 0
      let gap = next ? along - w.w : 0
      const spaced = next ? needsSpaceBetween(w.t, next.t) : false
      let width = w.w
      if (next && !spaced && gap > 0 && gap <= MAX_CJK_STRETCH_EM * size) width += gap
      else if (next && spaced && gap < MIN_WORD_GAP_EM * size) {
        // Touching or overlapping boxes: end this word early (never below the Tz floor) so the
        // space between them is wide enough to read as one; the next word's Tm stays exact.
        width = Math.max((TZ_MIN / 100) * natural, along - MIN_WORD_GAP_EM * size)
        gap = along - width
      }
      return { w, enc, gap, spaced, width, tz: (100 * width) / natural }
    })
    return {
      size,
      rot: `${c6} ${s6} ${num(-sin, 6)} ${c6}`,
      // Not a multiple of 90° once written: pdf.js treats those exactly (rotate 0/90/180/270).
      oblique: c6 !== '0' && s6 !== '0',
      words
    }
  })
  // Every oblique line of the page shares ONE Tz (see `show`): a quantile of what its words need.
  const obliqueTz = clampTz(
    quantile(
      plans.flatMap((p) => (p.oblique ? p.words.map((w) => w.tz) : [])),
      OBLIQUE_TZ_QUANTILE
    )
  )
  // Whether an earlier (oblique) line left a non-zero Tc in the text state: Tc survives ET.
  let tcSet = false

  plans.forEach(({ size, rot, oblique, words: plan }, li) => {
    ops.push(`BT 3 Tr${tcSet && !oblique ? ' 0 Tc' : ''} /${font} ${num(size)} Tf`)
    tcSet = oblique
    const lineTz = oblique ? obliqueTz : 100

    /** Show `enc` across `width` pt: its own Tz on axis-aligned lines, Tc on oblique ones. */
    const show = (enc: { hex: string; units: number; cids: number[] }, width: number): string => {
      for (const c of enc.cids) cids.add(c)
      const natural = (enc.units / 1000) * size
      const tz = clampTz((100 * width) / natural)
      if (!oblique) return `${num(tz)} Tz <${enc.hex}> Tj`
      // pdf.js 5.7.284 compares glyph positions on a non-axis-aligned baseline in a frame scaled by
      // each glyph's OWN Tz (`applyInverseRotation` divides both coordinates by hypot(a, b), which
      // includes Tz), so any Tz change between two glyphs — two words, or two lines — of tilted
      // text shifts the perpendicular coordinate by distance-from-origin × ΔTz: a 2° page copied
      // one word per line, and lines with different Tz ran together ("Ourneighbour")
      // [measured, PR2]. So every oblique line of a page shares one Tz and each word is fitted
      // with Tc, which pdf.js and PDFium both apply per glyph. Shrinking is unbounded (pdf.js at
      // most splits the item); widening is capped at OBLIQUE_TC_MAX per glyph, above which the
      // extractors start reading the extra spacing as a space, so such a word ends a little short
      // (its successor's own Tm puts the next word right again). The cost is word geometry:
      // per-word PDFium boxes on tilted pages are approximate (see the layer suite).
      const th = lineTz / 100
      const per = (width - natural * th) / enc.cids.length // user-space change per glyph
      const bounded = enc.cids.length > 1 ? Math.min(OBLIQUE_TC_MAX * size, per) : per
      return `${num(lineTz)} Tz ${num(bounded / th, 4)} Tc <${enc.hex}> Tj`
    }

    const spaceNatural = (OCR_NARROW / 1000) * size * (lineTz / 100)
    plan.forEach(({ w, enc, gap, spaced, width }, i) => {
      ops.push(`${rot} ${num(w.x)} ${num(w.y)} Tm ${show(enc, width)}`)
      words++
      if (i + 1 < plan.length) {
        // Stretched across the gap (the space's natural width is 0.5 em); a column-sized gap
        // keeps the natural width and the next word's own Tm does the jump.
        if (spaced) ops.push(show(sp, gap > MAX_STRETCH_GAP_EM * size ? spaceNatural : gap))
      } else {
        // Trailing space, so extractors that join lines without a break still separate words;
        // never after a hyphen (the word continues) or where the next line joins without a space.
        const following = lines[li + 1]?.words[0]?.t ?? w.t
        if (!w.t.endsWith('-') && needsSpaceBetween(w.t, following))
          ops.push(show(sp, spaceNatural))
      }
    })
    ops.push('ET')
  })
  ops.push('EMC', 'Q')
  return { bytes: new TextEncoder().encode(ops.join('\n') + '\n'), cids, words }
}

/** Is `obj` (a /Contents entry, resolved) a PDFx OCR layer stream? */
export function isOcrLayerStream(obj: unknown): boolean {
  return obj instanceof PDFStream && obj.dict.get(PDFName.of(OCR_LAYER_KEY)) === PDFBool.True
}

/** A font resource name in `fonts` that is free or already bound to `ref`: FOcr, FOcr1, … */
function fontResourceName(fonts: PDFDict | undefined, ref: PDFRef | null): string {
  for (let i = 0; ; i++) {
    const name = i === 0 ? OCR_FONT_RESOURCE : `${OCR_FONT_RESOURCE}${i}`
    const bound = fonts?.get(PDFName.of(name))
    if (bound === undefined || (ref !== null && bound === ref)) return name
  }
}

/** The page's /Contents entries as a list of stream refs (a stream, an array, or a ref to either). */
function contentsList(page: PDFPage): PDFObject[] {
  const ctx = page.node.context
  const entry = page.node.get(PDFName.of('Contents'))
  const resolved = entry instanceof PDFRef ? ctx.lookup(entry) : entry
  if (resolved instanceof PDFArray) return resolved.asArray()
  if (resolved instanceof PDFStream)
    return [entry instanceof PDFRef ? entry : ctx.register(resolved)]
  return []
}

/**
 * Bake `ocr` into `page` as its own content stream, PREPENDED to /Contents (index 0), with
 * `/PDFxOCRLayer true` in its dictionary, and bind the OCR font as a page font resource. Returns
 * the stream's ref, or null — leaving the page untouched — when there is nothing to write. The
 * caller calls `fonts.finalize(doc)` after the last page.
 *
 * Self-contained against shared containers: /Contents always becomes a fresh direct array, and
 * /Resources and its /Font dict page-own (shallow) copies, so a /Contents array or resource dict
 * shared with another page (or a ref to an array, which the font's CID tracking must see through)
 * is never mutated. `normalize()` is deliberately NOT called: the layer comes first and is
 * balanced (q … Q), so the original content needs no q/Q wrapper, and wrapping on every
 * Replace round trip would pile up [layer, q, q, …, Q, Q].
 */
export function appendOcrLayer(
  page: PDFPage,
  ocr: PackedOcrPage,
  fonts: OcrFontCache,
  opts: Omit<OcrLayerOptions, 'fontName'> = {}
): PDFRef | null {
  const node = page.node
  const ctx = node.context
  const resources = node.Resources() // inherited ones included
  const fontDict = resources?.lookupMaybe(PDFName.of('Font'), PDFDict)
  const fontName = fontResourceName(fontDict, fonts.peekRef())
  const content = ocrLayerContent(ocr, fonts, { ...opts, fontName })
  if (!content) return null
  const ref = ctx.register(ctx.flateStream(content.bytes, { [OCR_LAYER_KEY]: true }))
  fonts.track(ref, content.cids)
  const ownFonts = fontDict ? fontDict.clone(ctx) : ctx.obj({})
  ownFonts.set(PDFName.of(fontName), fonts.ref())
  const ownRes = resources ? resources.clone(ctx) : ctx.obj({})
  ownRes.set(PDFName.of('Font'), ownFonts)
  node.set(PDFName.of('Resources'), ownRes)
  node.set(PDFName.of('Contents'), ctx.obj([ref, ...contentsList(page)]))
  return ref
}

/**
 * Remove every PDFx OCR layer stream (dictionary `/PDFxOCRLayer true`) from `page`'s /Contents,
 * leaving every other stream byte-for-byte untouched, and unbind the page's PDFx OCR font
 * resources (BaseFont /PDFxOCR-GlyphLess). Returns the number of streams dropped. /Contents and
 * the Font dict are replaced, never mutated, so a container shared with another page is left
 * alone.
 *
 * Unlinking is not removal: pdf-lib's save writes every registered object. So the dropped
 * streams, the unbound OCR fonts with their whole graph (CIDFont, FontDescriptor, FontFile2,
 * CIDToGIDMap, ToUnicode) and the replaced indirect containers are then DELETED from the context,
 * unless something else in the document still reaches them (`deleteUnreachable`): another
 * page's layer that shares the font keeps it.
 */
export function dropOcrLayers(page: PDFPage): number {
  const node = page.node
  const ctx = node.context
  const entry = node.get(PDFName.of('Contents'))
  const resolved = entry instanceof PDFRef ? ctx.lookup(entry) : entry
  const candidates: PDFRef[] = []
  let dropped = 0
  if (isOcrLayerStream(resolved)) {
    node.set(PDFName.of('Contents'), ctx.obj([]))
    dropped = 1
  } else if (resolved instanceof PDFArray) {
    const keep = resolved.asArray().filter((r) => {
      const layer = isOcrLayerStream(r instanceof PDFRef ? ctx.lookup(r) : r)
      if (layer) {
        dropped++
        if (r instanceof PDFRef) candidates.push(r)
      }
      return !layer
    })
    if (dropped) node.set(PDFName.of('Contents'), ctx.obj(keep))
  }
  if (!dropped) return 0
  // The old stream, or the old indirect /Contents array.
  if (entry instanceof PDFRef) candidates.push(entry)
  const resEntry = node.get(PDFName.of('Resources'))
  const resources = node.Resources()
  const fontEntry = resources?.get(PDFName.of('Font'))
  const fontDict = resources?.lookupMaybe(PDFName.of('Font'), PDFDict)
  if (resources && fontDict) {
    const own = fontDict.clone(ctx)
    let unbound = 0
    for (const [name, value] of fontDict.entries()) {
      const dict = value instanceof PDFRef ? ctx.lookupMaybe(value, PDFDict) : value
      if (dict instanceof PDFDict && isOcrFontDict(dict)) {
        own.delete(name)
        unbound++
        if (value instanceof PDFRef) candidates.push(value)
      }
    }
    if (unbound) {
      const res = resources.clone(ctx)
      res.set(PDFName.of('Font'), own)
      node.set(PDFName.of('Resources'), res)
      for (const e of [resEntry, fontEntry]) if (e instanceof PDFRef) candidates.push(e)
    }
  }
  deleteUnreachable(ctx, candidates)
  return dropped
}
