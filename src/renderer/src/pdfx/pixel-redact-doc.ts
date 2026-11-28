// Sub-image (pixel) redaction, the pdf-lib half (DESIGN.md §2 D3, PR12). See pixel-redact.ts for
// the scope and redact.ts for the PDFium pass between the two steps here:
//
// 1. `imageCandidates` (before PDFium, on the SOURCE): every image XObject of each redacted page,
//    with how to redact it read off its own dictionary (`imagePlan`). PDFium cannot tell an image's
//    /Decode, /SMask, /Mask, /OC or Indexed palette, so the scope is decided here, on the literal
//    dictionary; PDFium matches its image object to a candidate by the stored stream bytes.
// 2. `swapPixelImages` (after PDFium, on its output): PDFium can only write the redacted copy as
//    8-bit (FPDFImageObj_SetBitmap), so each copy is found again by its exact interim samples and
//    its stream replaced by the final one, at the source's depth and in its colour space. A copy
//    that cannot be found throws `PixelSwapError`, and the export redacts that source again with
//    whole-image removal (redact-export.ts), so the growth limit always holds and nothing is
//    guessed.

import {
  decodePDFRawStream,
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFPageLeaf,
  PDFRawStream,
  PDFRef,
  PDFString,
  type PDFContext,
  type PDFObject
} from 'pdf-lib'

import {
  bytesEqual,
  type ImageCandidate,
  type ImagePlan,
  type PixelReplacement,
  type PlanColorSpace
} from './pixel-redact'

/** Filters whose output is the image's samples (PDFium's GetImageDataDecoded undoes them). */
const SAMPLE_FILTERS = new Set([
  'FlateDecode',
  'Fl',
  'LZWDecode',
  'LZW',
  'RunLengthDecode',
  'RL',
  'ASCIIHexDecode',
  'AHx',
  'ASCII85Decode',
  'A85'
])
/** Bi-level image codecs PDFium decodes to a bitmap (always 1 bit per component). */
const BILEVEL_CODECS = new Set(['CCITTFaxDecode', 'CCF', 'JBIG2Decode'])
const DCT_CODECS = new Set(['DCTDecode', 'DCT'])

/** Dictionary keys that put an image out of scope whatever their value. */
const OUT_OF_SCOPE_KEYS = ['SMask', 'Mask', 'Decode', 'SMaskInData', 'OC']

const skip = (why: string): { skip: string } => ({ skip: why })

const positiveInt = (o: PDFObject | undefined): number =>
  o instanceof PDFNumber && Number.isInteger(o.asNumber()) && o.asNumber() > 0 ? o.asNumber() : 0

/** The bytes of an Indexed lookup table (a string or a stream), or null. */
function lookupBytes(ctx: PDFContext, o: PDFObject | undefined): Uint8Array | null {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o
  if (v instanceof PDFString || v instanceof PDFHexString) return v.asBytes()
  if (v instanceof PDFRawStream) {
    try {
      return decodePDFRawStream(v).decode()
    } catch {
      return null
    }
  }
  return null
}

/** The plan's colour space for the dictionary's /ColorSpace, or why it is out of scope. */
function colorSpaceOf(ctx: PDFContext, o: PDFObject | undefined): PlanColorSpace | string {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o
  if (v === PDFName.of('DeviceGray')) return { kind: 'DeviceGray' }
  if (v === PDFName.of('DeviceRGB')) return { kind: 'DeviceRGB' }
  if (!(v instanceof PDFArray) || v.size() !== 4 || v.get(0) !== PDFName.of('Indexed'))
    return 'colour space'
  const base = v.lookup(1)
  if (base !== PDFName.of('DeviceGray') && base !== PDFName.of('DeviceRGB'))
    return 'Indexed base colour space'
  const hivalObj = v.lookup(2)
  const hival = hivalObj instanceof PDFNumber ? hivalObj.asNumber() : NaN
  if (!Number.isInteger(hival) || hival < 0 || hival > 255) return 'Indexed hival'
  const n = base === PDFName.of('DeviceRGB') ? 3 : 1
  const lookup = lookupBytes(ctx, v.get(3))
  if (!lookup || lookup.length < (hival + 1) * n) return 'Indexed lookup'
  return {
    kind: 'Indexed',
    base: base === PDFName.of('DeviceRGB') ? 'DeviceRGB' : 'DeviceGray',
    hival,
    lookup: lookup.slice(0, (hival + 1) * n)
  }
}

/**
 * How an image XObject is redacted pixel by pixel, from its dictionary alone, or why it is out of
 * scope (pixel-redact.ts header): /ImageMask, /SMask, /Mask, /Decode, /OC, a JPX, Crypt or unknown
 * filter, an image codec that is not the last filter, a colour space other than DeviceGray,
 * DeviceRGB or Indexed over one of them, or a depth other than 1, 2, 4 or 8.
 */
export function imagePlan(ctx: PDFContext, dict: PDFDict): ImagePlan | { skip: string } {
  const get = (k: string): PDFObject | undefined => {
    const v = dict.get(PDFName.of(k))
    return v instanceof PDFRef ? ctx.lookup(v) : v
  }
  if (!positiveInt(get('Width')) || !positiveInt(get('Height'))) return skip('size')
  const mask = get('ImageMask')
  if (mask !== undefined && mask !== PDFBool.False) return skip('ImageMask')
  for (const k of OUT_OF_SCOPE_KEYS) if (dict.has(PDFName.of(k))) return skip(k)
  const f = get('Filter')
  const filters: string[] = []
  if (f instanceof PDFName) filters.push(f.decodeText())
  else if (f instanceof PDFArray)
    for (let i = 0; i < f.size(); i++) {
      const n = f.lookup(i)
      if (!(n instanceof PDFName)) return skip('filter')
      filters.push(n.decodeText())
    }
  else if (f !== undefined) return skip('filter')
  const last = filters[filters.length - 1]
  for (const [i, name] of filters.entries()) {
    const codec = BILEVEL_CODECS.has(name) || DCT_CODECS.has(name)
    if (!SAMPLE_FILTERS.has(name) && !codec) return skip(`filter ${name}`)
    if (codec && i !== filters.length - 1) return skip(`filter ${name} not last`)
  }
  const bpcObj = get('BitsPerComponent')
  const cs = colorSpaceOf(ctx, dict.get(PDFName.of('ColorSpace')))
  if (typeof cs === 'string') return skip(cs)
  if (last !== undefined && BILEVEL_CODECS.has(last)) {
    // Bi-level: 1 bit, DeviceGray (a JBIG2 image may leave /BitsPerComponent out).
    if (bpcObj !== undefined && positiveInt(bpcObj) !== 1) return skip('bilevel depth')
    if (cs.kind !== 'DeviceGray') return skip('bilevel colour space')
    return { decode: 'bitmap', colorSpace: cs, bpc: 1 }
  }
  const bpc = positiveInt(bpcObj)
  if (bpc !== 1 && bpc !== 2 && bpc !== 4 && bpc !== 8) return skip('depth')
  if (last !== undefined && DCT_CODECS.has(last)) {
    if (bpc !== 8 || cs.kind === 'Indexed') return skip('DCT colour space')
    return { decode: 'bitmap', colorSpace: cs, bpc: 8 }
  }
  return { decode: 'samples', colorSpace: cs, bpc }
}

/** The page's image XObjects (its own or inherited /Resources), as (ref, stream) pairs. */
function pageImages(
  ctx: PDFContext,
  node: PDFPageLeaf
): { ref: PDFRef | undefined; stream: PDFRawStream }[] {
  const out: { ref: PDFRef | undefined; stream: PDFRawStream }[] = []
  const xobjects = node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)
  if (!xobjects) return out
  for (const [, v] of xobjects.entries()) {
    const s = v instanceof PDFRef ? ctx.lookup(v) : v
    if (!(s instanceof PDFRawStream)) continue
    if (s.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue
    out.push({ ref: v instanceof PDFRef ? v : undefined, stream: s })
  }
  return out
}

/**
 * pageIndex → the image XObjects of each of `pageIndices` in the source `bytes`, with their plans.
 * Empty (whole-image removal everywhere) when the file is encrypted or pdf-lib cannot read it.
 */
export async function imageCandidates(
  bytes: Uint8Array,
  pageIndices: Iterable<number>
): Promise<Map<number, ImageCandidate[]>> {
  const out = new Map<number, ImageCandidate[]>()
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
  } catch {
    return out
  }
  // Encrypted: pdf-lib holds the encrypted stream bytes, which PDFium's never match anyway.
  if (doc.isEncrypted) return out
  const ctx = doc.context
  const pages = doc.getPages()
  for (const i of pageIndices) {
    const node = pages[i]?.node
    if (!node) continue
    out.set(
      i,
      pageImages(ctx, node).map(({ stream }) => ({
        width: positiveInt(ctx.lookup(stream.dict.get(PDFName.of('Width')))),
        height: positiveInt(ctx.lookup(stream.dict.get(PDFName.of('Height')))),
        raw: stream.contents,
        plan: imagePlan(ctx, stream.dict)
      }))
    )
  }
  return out
}

/** A pixel-redacted copy PDFium wrote could not be found again in its output (see the header). */
export class PixelSwapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PixelSwapError'
  }
}

/** The final colour space object of a replacement. */
function colorSpaceObject(ctx: PDFContext, cs: PlanColorSpace): PDFObject {
  if (cs.kind !== 'Indexed') return PDFName.of(cs.kind)
  return ctx.obj([
    PDFName.of('Indexed'),
    PDFName.of(cs.base),
    cs.hival,
    ctx.register(ctx.stream(cs.lookup))
  ])
}

/**
 * Put the final stream of every pixel-redacted image of `pixels` (pageIndex → replacements) into
 * `doc`, a PDFium output: each interim is found among its page's image XObjects by its size and its
 * exact 8-bit samples, and its stream object is replaced in place (so whatever refers to it now
 * shows the final stream). Returns the refs that may have come loose (the interims' colour
 * spaces) for the caller's unreachable sweep. Throws PixelSwapError when an interim is missing.
 */
export function swapPixelImages(
  doc: PDFDocument,
  pixels: ReadonlyMap<number, readonly PixelReplacement[]>
): PDFRef[] {
  const ctx = doc.context
  const pages = doc.getPages()
  const unlinked: PDFRef[] = []
  for (const [i, reps] of pixels) {
    const node = pages[i]?.node
    if (!node) throw new PixelSwapError(`pixel redaction: no page ${i}`)
    const pending = new Set(reps)
    const done = new Set<PDFRef>()
    for (const { ref, stream } of pageImages(ctx, node)) {
      if (!ref || done.has(ref) || !pending.size) continue
      const w = positiveInt(ctx.lookup(stream.dict.get(PDFName.of('Width'))))
      const h = positiveInt(ctx.lookup(stream.dict.get(PDFName.of('Height'))))
      if (positiveInt(ctx.lookup(stream.dict.get(PDFName.of('BitsPerComponent')))) !== 8) continue
      const same = [...pending].filter((r) => r.width === w && r.height === h)
      if (!same.length) continue
      let samples: Uint8Array
      try {
        samples = decodePDFRawStream(stream).decode()
      } catch {
        continue
      }
      const rep = same.find((r) => bytesEqual(r.interim.data, samples))
      if (!rep) continue
      const old = stream.dict.get(PDFName.of('ColorSpace'))
      if (old instanceof PDFRef) unlinked.push(old)
      ctx.assign(
        ref,
        ctx.stream(rep.final.data, {
          Type: 'XObject',
          Subtype: 'Image',
          Width: w,
          Height: h,
          BitsPerComponent: rep.final.bpc,
          ColorSpace: colorSpaceObject(ctx, rep.final.colorSpace),
          Filter: 'FlateDecode'
        })
      )
      pending.delete(rep)
      done.add(ref)
    }
    if (pending.size) throw new PixelSwapError(`pixel redaction: ${pending.size} image(s) not found on page ${i}`) // prettier-ignore
  }
  return unlinked
}
