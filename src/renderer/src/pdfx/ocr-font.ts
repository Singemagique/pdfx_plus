// The glyphless font of the invisible OCR text layer (DESIGN.md §3.7.4). Its own module, not
// fonts.ts / embedFont: pdf-lib's CIDFont writer emits one ToUnicode block for every character
// (Ghostscript 9.56–10.04 rejects that when it writes PDF/A), sizes widths from real glyphs and
// cannot keep the font tables to the characters actually baked.
//
//   Type0 /BaseFont /PDFxOCR-GlyphLess /Encoding /Identity-H /ToUnicode <hand-written CMap>
//     └ CIDFontType2, CIDSystemInfo (Adobe/Identity/0), /DW 500, /W [c [1000 …] …] for wide CIDs,
//       /CIDToGIDMap stream (used CIDs → GID 1, or GID 2 when wide), FontDescriptor → FontFile2
//
// One code point = one CID, allocated from 1 (CID 0 is never used) the first time a baked word
// needs it. A code point outside the BMP still takes one CID; its ToUnicode value is the UTF-16BE
// surrogate pair. Every advance is 500 units, or 1000 for East Asian Wide/Fullwidth code points:
// never below 500, because PDFium drops identical codes whose advance is under 0.07 em, and a
// combining mark is a code point like any other. A wide CID maps to GID 2, the 1000-unit twin of the
// 500-unit GID 1: PDFium's char boxes are the glyph's own bbox, so a wide character drawn with GID 1
// got a box half its advance [measured, PR2].
//
// REDACTION RULE 5 (§3.7.3). /W, CIDToGIDMap and ToUnicode are written by `finalize(doc)` from the
// CIDs used by the layer streams that are ACTUALLY on the document's pages at that moment, never
// from everything this cache ever encoded. A layer built for a page that was later dropped, or a
// stream removed again with `dropOcrLayers`, contributes nothing, so a character that only
// occurred in a filtered-out word cannot survive in a CMap where no text extractor would report it.

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib'
import { isWideCodePoint } from '../../../shared/ocr/text'
import { GLYPHLESS_TTF_ZERO_AREA } from './ocr-glyphless-ttf'

export const OCR_FONT_NAME = 'PDFxOCR-GlyphLess'
/** Every advance in font units (1000/em): the narrow default and the wide East Asian advance. */
export const OCR_NARROW = 500
export const OCR_WIDE = 1000
/** A ToUnicode bfchar block never holds more than this many entries (§3.7.4). */
export const BFCHAR_BLOCK = 100
/** The glyphs of the glyphless TTF: g1 (advance 500) and g2 (advance 1000). */
export const GID_NARROW = 1
export const GID_WIDE = 2
/** Identity-H codes are 2 bytes, so a document can hold at most 65535 distinct characters. */
const MAX_CID = 0xffff

/**
 * FontDescriptor metrics. `em` (default) matches the glyph box the layer is positioned with:
 * Flags 4 (Symbolic), FontBBox [0 -200 500 800], Ascent 800, Descent -200. `tesseract` is
 * Tesseract's known-good alternative, Flags 5 (FixedPitch + Symbolic) and FontBBox
 * [0 0 500 1000], kept as the A/B candidate for the viewer matrix (§3.7.4).
 */
export type OcrFontBBox = 'em' | 'tesseract'

export interface OcrFontOptions {
  /** The TrueType program (default: the zero-area-contour glyph, `GLYPHLESS_TTF_ZERO_AREA`). */
  ttf?: Uint8Array
  bbox?: OcrFontBBox
}

export interface EncodedText {
  /** The CIDs as one hex string for a `<…> Tj` operand (4 hex digits per CID). */
  hex: string
  /** Σ advances in font units (500 or 1000 each): the text's natural width is units/1000 × size. */
  units: number
  cids: number[]
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

let defaultTtf: Uint8Array | null = null

/** The default glyphless TTF program (decoded once). */
export function glyphlessTtf(): Uint8Array {
  defaultTtf ??= decodeBase64(GLYPHLESS_TTF_ZERO_AREA)
  return defaultTtf
}

export const hex4 = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0')

/** UTF-16BE hex of one code point (a surrogate pair above the BMP). */
function utf16Hex(cp: number): string {
  if (cp <= 0xffff) return hex4(cp)
  const v = cp - 0x10000
  return hex4(0xd800 + (v >> 10)) + hex4(0xdc00 + (v & 0x3ff))
}

/** A hand-written ToUnicode CMap: one code point per CID, bfchar blocks of ≤ 100 entries. */
export function toUnicodeCMap(entries: readonly (readonly [cid: number, cp: number])[]): string {
  const out = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange'
  ]
  for (let i = 0; i < entries.length; i += BFCHAR_BLOCK) {
    const block = entries.slice(i, i + BFCHAR_BLOCK)
    out.push(`${block.length} beginbfchar`)
    for (const [cid, cp] of block) out.push(`<${hex4(cid)}> <${utf16Hex(cp)}>`)
    out.push('endbfchar')
  }
  out.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end')
  return out.join('\n') + '\n'
}

/**
 * /W for the wide CIDs among `cids` (sorted ascending), as runs `c [1000 1000 …]` of consecutive
 * CIDs. Narrow CIDs are left to /DW 500.
 */
export function widthsArray(
  cids: readonly number[],
  wide: (cid: number) => boolean
): (number | number[])[] {
  const out: (number | number[])[] = []
  let run: number[] | null = null
  let prev = -2
  for (const cid of cids) {
    if (!wide(cid)) continue
    if (run && cid === prev + 1) run.push(OCR_WIDE)
    else {
      run = [OCR_WIDE]
      out.push(cid, run)
    }
    prev = cid
  }
  return out
}

/**
 * The OCR font of ONE output document. Content streams reference its Type0 dictionary through
 * `ref()` as soon as they are built; `finalize(doc)` must run after the last page is baked and
 * before `save()` (and before `computeIntegrity` for `.pdfx`), and writes the dictionaries.
 */
export class OcrFontCache {
  private readonly cidOf = new Map<number, number>()
  private readonly cpOf: number[] = [0] // cpOf[cid]; CID 0 is a never-used placeholder
  private readonly streams = new Map<PDFRef, ReadonlySet<number>>()
  private fontRef: PDFRef | null = null
  private finalized = false
  private readonly ttf: Uint8Array
  private readonly bbox: OcrFontBBox

  constructor(
    readonly doc: PDFDocument,
    opts: OcrFontOptions = {}
  ) {
    this.ttf = opts.ttf ?? glyphlessTtf()
    this.bbox = opts.bbox ?? 'em'
  }

  /** The (still empty until `finalize`) Type0 font object every layer stream points at. */
  ref(): PDFRef {
    this.fontRef ??= this.doc.context.nextRef()
    return this.fontRef
  }

  /** Advance of a CID in font units. */
  advance(cid: number): number {
    return isWideCodePoint(this.cpOf[cid]) ? OCR_WIDE : OCR_NARROW
  }

  /** Encode `text` (one CID per code point, allocating new CIDs as needed). */
  encode(text: string): EncodedText {
    if (this.finalized) throw new Error('ocr-font: encode after finalize')
    let hex = ''
    let units = 0
    const cids: number[] = []
    for (const ch of text) {
      const cp = ch.codePointAt(0)!
      if (cp === 0 || cp === 0xfeff || cp === 0xfffe || (cp >= 0xd800 && cp <= 0xdfff))
        throw new Error(`ocr-font: U+${hex4(cp)} cannot be mapped (clean the text first)`)
      let cid = this.cidOf.get(cp)
      if (cid === undefined) {
        cid = this.cpOf.length
        if (cid > MAX_CID) throw new Error('ocr-font: more than 65535 distinct characters')
        this.cidOf.set(cp, cid)
        this.cpOf.push(cp)
      }
      cids.push(cid)
      hex += hex4(cid)
      units += isWideCodePoint(cp) ? OCR_WIDE : OCR_NARROW
    }
    return { hex, units, cids }
  }

  /** Record that the layer content stream `stream` shows `cids` (see `finalize`). */
  track(stream: PDFRef, cids: Iterable<number>): void {
    if (this.finalized) throw new Error('ocr-font: track after finalize')
    this.streams.set(stream, new Set(cids))
  }

  /**
   * The CIDs shown by tracked layer streams that some page of `doc` currently lists in /Contents,
   * sorted ascending. The basis of every font table (redaction rule 5).
   */
  usedCids(doc: PDFDocument): number[] {
    const used = new Set<number>()
    for (const page of doc.getPages()) {
      const contents = page.node.get(PDFName.of('Contents'))
      const refs: unknown[] =
        contents instanceof PDFRef
          ? [contents]
          : (doc.context.lookupMaybe(contents, PDFArray)?.asArray() ?? [])
      for (const r of refs) {
        if (!(r instanceof PDFRef)) continue
        const cids = this.streams.get(r)
        if (cids) for (const c of cids) used.add(c)
      }
    }
    return [...used].sort((a, b) => a - b)
  }

  /**
   * Write the font: Type0 + CIDFontType2 + FontDescriptor + FontFile2, with /W, CIDToGIDMap and
   * ToUnicode built ONLY from `usedCids(doc)`. Does nothing if no layer stream ever asked for the
   * font. Afterwards the cache refuses further `encode`/`track` calls.
   */
  finalize(doc: PDFDocument): void {
    if (doc !== this.doc) throw new Error('ocr-font: finalize on another document')
    if (this.finalized) throw new Error('ocr-font: finalize called twice')
    this.finalized = true
    if (!this.fontRef) return
    const ctx = doc.context
    const used = this.usedCids(doc)

    const ttf = ctx.flateStream(this.ttf, { Length1: this.ttf.length })
    const tess = this.bbox === 'tesseract'
    const descriptor = ctx.obj({
      Type: 'FontDescriptor',
      FontName: OCR_FONT_NAME,
      Flags: tess ? 5 : 4,
      FontBBox: tess ? [0, 0, 500, 1000] : [0, -200, 500, 800],
      ItalicAngle: 0,
      Ascent: tess ? 1000 : 800,
      Descent: tess ? -1 : -200,
      CapHeight: tess ? 1000 : 700,
      StemV: 80,
      FontFile2: ctx.register(ttf)
    })

    const maxCid = used.length ? used[used.length - 1] : 0
    const gidMap = new Uint8Array(2 * (maxCid + 1))
    // Big-endian GIDs: 1 (narrow) or 2 (wide) for every used CID; unused CIDs stay GID 0.
    for (const cid of used)
      gidMap[2 * cid + 1] = this.advance(cid) === OCR_WIDE ? GID_WIDE : GID_NARROW

    const w = ctx.obj([])
    for (const part of widthsArray(used, (c) => this.advance(c) === OCR_WIDE))
      w.push(typeof part === 'number' ? PDFNumber.of(part) : ctx.obj(part))

    const cidFont = ctx.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: OCR_FONT_NAME,
      CIDSystemInfo: ctx.obj({
        Registry: PDFString.of('Adobe'),
        Ordering: PDFString.of('Identity'),
        Supplement: 0
      }),
      FontDescriptor: ctx.register(descriptor),
      DW: OCR_NARROW,
      W: w,
      CIDToGIDMap: ctx.register(ctx.flateStream(gidMap))
    })

    const cmap = toUnicodeCMap(used.map((cid) => [cid, this.cpOf[cid]] as const))
    const type0 = ctx.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: OCR_FONT_NAME,
      Encoding: 'Identity-H',
      DescendantFonts: [ctx.register(cidFont)],
      ToUnicode: ctx.register(ctx.flateStream(cmap))
    })
    ctx.assign(this.fontRef, type0)
  }
}

/** Is `dict` a Type0 font dictionary of a PDFx OCR layer (this one or an earlier export's)? */
export function isOcrFontDict(dict: PDFDict | undefined): boolean {
  const base = dict?.get(PDFName.of('BaseFont'))
  return base instanceof PDFName && base.decodeText() === OCR_FONT_NAME
}
