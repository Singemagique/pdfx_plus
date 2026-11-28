// The glyphless font of the invisible OCR text layer (DESIGN.md §3.7.4). Its own module, not
// fonts.ts / embedFont: pdf-lib's CIDFont writer emits one ToUnicode block for every character
// (Ghostscript 9.56–10.04 rejects that when it writes PDF/A), sizes widths from real glyphs and
// cannot keep the font tables to the characters actually baked.
//
//   Type0 /BaseFont /PDFxOCR-GlyphLess /Encoding /Identity-H /ToUnicode <hand-written CMap>
//     └ CIDFontType2, CIDSystemInfo (Adobe/Identity/0), /DW 500, /W [0 [1000] c [1000 …] …] (the
//       never-shown monospace guard CID 0, then the wide CIDs), /CIDToGIDMap stream (used CIDs →
//       GID 1, or GID 2 when wide; the guard → GID 2), FontDescriptor → FontFile2
//
// One code point = one CID. `encode` hands out PROVISIONAL CIDs from 1 the first time a baked word
// needs a code point; `finalize` renumbers the CIDs still shown densely from 1 in first-use order
// (CID 0 is never used) and rewrites the live layer streams to match, so the output's numbering
// has no holes where dropped or removed content was (§3.7.4: CIDs are allocated over the filtered
// set). A code point outside the BMP still takes one CID; its ToUnicode value is the UTF-16BE
// surrogate pair. Every advance is 500 units, or 1000 for East Asian Wide/Fullwidth code points:
// never below 500, because PDFium drops identical codes whose advance is under 0.07 em, and a
// combining mark is a code point like any other. A wide CID maps to GID 2, the 1000-unit twin of the
// 500-unit GID 1: PDFium's char boxes are the glyph's own bbox, so a wide character drawn with GID 1
// got a box half its advance [measured, PR2].
//
// REDACTION RULE 5 (§3.7.3). /W, CIDToGIDMap and ToUnicode are written by `finalize(doc)` from the
// CIDs used by the layer streams that are ACTUALLY on the document's pages at that moment (the live
// page tree, never pdf-lib's page cache, which `removePage` leaves stale), never from everything
// this cache ever encoded. A layer built for a page that was later removed, or a stream removed
// again with `dropOcrLayers`, contributes nothing, and `finalize` deletes such streams from the
// context (pdf-lib's save writes every registered object, linked or not), so a character that only
// occurred in a filtered-out word cannot survive in the file where no text extractor reports it.

import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFPageLeaf,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFObject
} from 'pdf-lib'
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
 * The pdf.js monospace guard. pdf.js 5.7.284 (`extractWidths`) flags a font FixedPitch when every
 * /W width equals /DW, which every Latin-only layer did (all 500), and the app's Find then split a
 * whole merged line evenly per character (search/geometry.ts `mono`), so highlights missed the
 * words each stretched by its own Tz. /W therefore always lists CID 0 at the wide advance: CID 0
 * is never shown (CIDs start at 1), has no ToUnicode entry and maps to the wide glyph (GID 2,
 * advance 1000, so the width agrees with the program), so it carries no character, paints nothing
 * and is never part of any text, yet one width ≠ /DW clears the flag.
 */
export const MONO_GUARD_CID = 0

/**
 * FontDescriptor metrics. `em` (default) matches the glyph box the layer is positioned with:
 * Flags 4 (Symbolic), FontBBox [0 -200 1000 800], Ascent 800, Descent -200. `tesseract` is
 * Tesseract's known-good alternative, Flags 5 (FixedPitch + Symbolic) and FontBBox
 * [0 0 1000 1000], kept as the A/B candidate for the viewer matrix (§3.7.4). Both boxes are
 * 1000 wide, not the design's 500: FontBBox is the union of all glyph boxes (PDF 32000 §9.8.1),
 * and the wide glyph g2 spans 1000 units (the embedded TTF's head bbox is (0,-200)-(1000,800)).
 */
export type OcrFontBBox = 'em' | 'tesseract'

export interface OcrFontOptions {
  /** The TrueType program (default: the zero-area-contour glyph, `GLYPHLESS_TTF_ZERO_AREA`). */
  ttf?: Uint8Array
  bbox?: OcrFontBBox
  /**
   * A FontDescriptor + FontFile2 shared with other OCR fonts of the same document (`ttf` and
   * `bbox` are then the program's). They hold no character data, so a document whose pages each
   * have their OWN font (build.ts) stores the glyphless program once.
   */
  program?: OcrFontProgram
}

/**
 * The character-free part of the OCR font, the FontDescriptor and its FontFile2, written at most
 * once per document and shared by every OcrFontCache given it. Only the Type0 / CIDFontType2 /
 * ToUnicode / CIDToGIDMap / W tables carry characters, and those stay per cache.
 */
export class OcrFontProgram {
  private descriptor: PDFRef | null = null
  readonly ttf: Uint8Array
  readonly bbox: OcrFontBBox

  constructor(
    readonly doc: PDFDocument,
    opts: Omit<OcrFontOptions, 'program'> = {}
  ) {
    this.ttf = opts.ttf ?? glyphlessTtf()
    this.bbox = opts.bbox ?? 'em'
  }

  /** The FontDescriptor (with its FontFile2), registered on first use. */
  descriptorRef(): PDFRef {
    if (this.descriptor) return this.descriptor
    const ctx = this.doc.context
    const ttf = ctx.flateStream(this.ttf, { Length1: this.ttf.length })
    const tess = this.bbox === 'tesseract'
    this.descriptor = ctx.register(
      ctx.obj({
        Type: 'FontDescriptor',
        FontName: OCR_FONT_NAME,
        Flags: tess ? 5 : 4,
        FontBBox: tess ? [0, 0, OCR_WIDE, 1000] : [0, -200, OCR_WIDE, 800],
        ItalicAngle: 0,
        Ascent: tess ? 1000 : 800,
        Descent: tess ? -1 : -200,
        CapHeight: tess ? 1000 : 700,
        StemV: 80,
        FontFile2: ctx.register(ttf)
      })
    )
    return this.descriptor
  }
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
 * One OCR font of an output document. build.ts gives every baked PAGE its own cache (sharing one
 * `OcrFontProgram`), so a page never carries another page's characters in its ToUnicode: a page
 * later deleted or redacted out of a reopened file cannot leave its text behind in the font of the
 * pages that remain (§3.7.3 rule 5). Content streams reference its Type0 dictionary through
 * `ref()` as soon as they are built; `finalize(doc)` must run after the last page is baked and
 * before `save()` (and before `computeIntegrity` for `.pdfx`), and writes the dictionaries.
 */
export class OcrFontCache {
  private readonly cidOf = new Map<number, number>()
  private readonly cpOf: number[] = [0] // cpOf[cid]; CID 0 is a never-used placeholder
  private readonly streams = new Map<PDFRef, ReadonlySet<number>>()
  private fontRef: PDFRef | null = null
  private finalized = false
  private readonly program: OcrFontProgram

  constructor(
    readonly doc: PDFDocument,
    opts: OcrFontOptions = {}
  ) {
    if (opts.program && opts.program.doc !== doc)
      throw new Error('ocr-font: font program of another document')
    this.program = opts.program ?? new OcrFontProgram(doc, opts)
  }

  /** The (still empty until `finalize`) Type0 font object every layer stream points at. */
  ref(): PDFRef {
    this.fontRef ??= this.doc.context.nextRef()
    return this.fontRef
  }

  /** The font's ref if a layer has asked for it, without allocating one. */
  peekRef(): PDFRef | null {
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
   * The tracked layer streams that a page in `doc`'s page tree currently lists in /Contents. The
   * tree is walked from the catalog: pdf-lib 1.17.1's `removePage` does not invalidate the cache
   * behind `getPages()`, so a removed page would still count. /Contents may be a stream ref, a
   * direct array, or a ref to an array; all three are resolved.
   */
  private liveStreams(doc: PDFDocument): Set<PDFRef> {
    const ctx = doc.context
    const live = new Set<PDFRef>()
    doc.catalog.Pages().traverse((node) => {
      if (!(node instanceof PDFPageLeaf)) return
      const entry = node.get(PDFName.of('Contents'))
      const resolved = entry instanceof PDFRef ? ctx.lookup(entry) : entry
      const refs = resolved instanceof PDFArray ? resolved.asArray() : [entry]
      for (const r of refs) if (r instanceof PDFRef && this.streams.has(r)) live.add(r)
    })
    return live
  }

  /**
   * The (provisional) CIDs shown by tracked layer streams that some page of `doc` currently lists
   * in /Contents, sorted ascending. The basis of every font table (redaction rule 5).
   */
  usedCids(doc: PDFDocument): number[] {
    const used = new Set<number>()
    for (const ref of this.liveStreams(doc)) for (const c of this.streams.get(ref)!) used.add(c)
    return [...used].sort((a, b) => a - b)
  }

  /** Rewrite the hex `Tj` operands of the layer stream `ref` through `dense` (old → new CID). */
  private renumber(ref: PDFRef, dense: ReadonlyMap<number, number>): void {
    const ctx = this.doc.context
    const old = ctx.lookup(ref, PDFStream)
    const bytes = old instanceof PDFRawStream ? decodePDFRawStream(old).decode() : old.getContents()
    // Our own stream: the only `<…>` operands are the Tj hex strings (the BDC property list is a
    // `<<…>>` dictionary, which this pattern cannot match).
    const text = new TextDecoder().decode(bytes).replace(/<([0-9A-F]*)> Tj/g, (_, hex: string) => {
      let out = ''
      for (let i = 0; i < hex.length; i += 4) {
        const cid = dense.get(parseInt(hex.slice(i, i + 4), 16))
        if (cid === undefined) throw new Error('ocr-font: layer stream shows an untracked CID')
        out += hex4(cid)
      }
      return `<${out}> Tj`
    })
    const dict: Record<string, PDFObject> = {}
    for (const [k, v] of old.dict.entries()) {
      const key = k.decodeText()
      if (key !== 'Length' && key !== 'Filter' && key !== 'DecodeParms') dict[key] = v
    }
    ctx.assign(ref, ctx.flateStream(new TextEncoder().encode(text), dict))
  }

  /**
   * Write the font: Type0 + CIDFontType2 + FontDescriptor + FontFile2, with /W, CIDToGIDMap and
   * ToUnicode built ONLY from `usedCids(doc)`, renumbered densely from 1. Tracked layer streams no
   * page lists any more (dropped, or on a removed page) are deleted from the context. Writes no
   * font when no CID is shown (and unbinds the never-written font from the pages). Afterwards the
   * cache refuses further `encode`/`track` calls.
   */
  finalize(doc: PDFDocument): void {
    if (doc !== this.doc) throw new Error('ocr-font: finalize on another document')
    if (this.finalized) throw new Error('ocr-font: finalize called twice')
    this.finalized = true
    if (!this.fontRef) return
    const ctx = doc.context
    const live = this.liveStreams(doc)
    for (const ref of this.streams.keys()) if (!live.has(ref)) ctx.delete(ref)
    const shown = this.usedCids(doc)
    if (!shown.length) {
      this.unbindFont(doc)
      return
    }
    // Dense renumbering in first-use order (provisional CIDs were allocated in reading order).
    const dense = new Map(shown.map((cid, i) => [cid, i + 1]))
    if (shown.some((cid, i) => cid !== i + 1)) for (const ref of live) this.renumber(ref, dense)
    const used = shown.map((_, i) => i + 1)
    const cpOf = (cid: number): number => this.cpOf[shown[cid - 1]]
    const wide = (cid: number): boolean => isWideCodePoint(cpOf(cid))

    const gidMap = new Uint8Array(2 * (used.length + 1))
    // Big-endian GIDs: 1 (narrow) or 2 (wide) for every used CID. The never-shown monospace guard
    // CID 0 maps to the wide glyph its /W width describes; no CID maps to GID 0.
    gidMap[2 * MONO_GUARD_CID + 1] = GID_WIDE
    for (const cid of used) gidMap[2 * cid + 1] = wide(cid) ? GID_WIDE : GID_NARROW

    const w = ctx.obj([PDFNumber.of(MONO_GUARD_CID), ctx.obj([OCR_WIDE])])
    for (const part of widthsArray(used, wide))
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
      FontDescriptor: this.program.descriptorRef(),
      DW: OCR_NARROW,
      W: w,
      CIDToGIDMap: ctx.register(ctx.flateStream(gidMap))
    })

    const cmap = toUnicodeCMap(used.map((cid) => [cid, cpOf(cid)] as const))
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

  /** Remove every page font binding to the (never written) font, so no ref dangles. */
  private unbindFont(doc: PDFDocument): void {
    const ref = this.fontRef
    doc.catalog.Pages().traverse((node) => {
      if (!(node instanceof PDFPageLeaf)) return
      const fonts = node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict)
      // No page shows the font, so even a Font dict shared by several pages can lose the entry.
      if (fonts) for (const [name, value] of fonts.entries()) if (value === ref) fonts.delete(name)
    })
  }
}

/** Is `dict` a Type0 font dictionary of a PDFx OCR layer (this one or an earlier export's)? */
export function isOcrFontDict(dict: PDFDict | undefined): boolean {
  const base = dict?.get(PDFName.of('BaseFont'))
  return base instanceof PDFName && base.decodeText() === OCR_FONT_NAME
}
