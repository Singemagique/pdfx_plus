// The redaction leak oracle of the OCR export (DESIGN.md §3.7.3 rule 6). Test-only.
//
// `rawLeaks(bytes, secret)` parses a SAVED file with pdf-lib and looks for a redacted word
// everywhere a reader of the file (not just a text extractor) could find it:
// - the raw file and EVERY stream, inflated where pdf-lib can (content streams, Form XObjects,
//   ToUnicode CMaps, CIDToGIDMaps, embedded files, XMP, the .pdfx manifest), plus every
//   attachment the .pdfx manifest carries as base64;
// - in every encoding: UTF-8, UTF-16BE, UTF-16LE, PDFDocEncoding, and as hex text of the first two
//   (a `<FEFF…>` string or a CMap destination);
// - every string object of the file, decoded (PDFDocEncoding or UTF-16BE with BOM);
// - every font's ToUnicode CMap, `bfchar` and `bfrange` (both forms) decoded, and every hex string
//   of every content stream decoded through every font's map: no code point UNIQUE to a redacted
//   word may appear, and the word itself may not appear as a CID sequence of any font (as hex text
//   or as raw big-endian bytes);
// - redaction rule 5 for every PDFx OCR font: the CIDs its /W (beyond the never-shown monospace
//   guard), CIDToGIDMap and ToUnicode describe are all CIDs some page actually shows with it.
// `extractorLeaks` reads every page with both shipped extractors (pdf.js getTextContent and PDFium
// FPDFText_GetText). Both return a list of findings; a clean file gives [].

import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFObject
} from 'pdf-lib'

import { MANIFEST_NAME } from '../format'
import { OCR_FONT_NAME, MONO_GUARD_CID } from '../ocr-font'
import {
  pdfiumCopyText,
  pdfiumProbe,
  pdfjsCopyText,
  pdfjsText,
  type ProbePdfium
} from './ocr-layer'

export interface Secret {
  /** The redacted words (each must appear nowhere). */
  words: readonly string[]
  /** Code points that occur ONLY in redacted words (none may appear in any character table). */
  uniqueCps: readonly number[]
}

/** The code points of `redacted` that occur in none of `kept` (the export's legitimate text). */
export function uniqueCodePoints(redacted: readonly string[], kept: readonly string[]): number[] {
  const keep = new Set(kept.flatMap((t) => [...t].map((c) => c.codePointAt(0)!)))
  const out = new Set<number>()
  for (const t of redacted)
    for (const c of t) if (!keep.has(c.codePointAt(0)!)) out.add(c.codePointAt(0)!)
  return [...out]
}

const hex4 = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0')
const latin1 = (b: Uint8Array): string => new TextDecoder('latin1').decode(b)

function utf16be(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2)
  for (let i = 0; i < s.length; i++) {
    out[2 * i] = s.charCodeAt(i) >> 8
    out[2 * i + 1] = s.charCodeAt(i) & 0xff
  }
  return out
}
const utf16le = (s: string): Uint8Array => utf16be(s).map((_, i, a) => a[i ^ 1])

/** PDFDocEncoding bytes of `s`, or null when it has a character outside Latin-1 (approximation). */
function pdfDocEncoding(s: string): Uint8Array | null {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c > 0xff) return null
    out[i] = c
  }
  return out
}

const toHex = (b: Uint8Array): string => [...b].map((v) => v.toString(16).padStart(2, '0')).join('')

const includes = (hay: Uint8Array, needle: Uint8Array): boolean =>
  needle.length > 0 &&
  Buffer.from(hay.buffer, hay.byteOffset, hay.byteLength).indexOf(Buffer.from(needle)) >= 0

/** A stream's bytes, inflated when pdf-lib can decode its filters (else as stored). */
function streamData(s: PDFStream): Uint8Array {
  try {
    return s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents()
  } catch {
    return s.getContents()
  }
}

/** ToUnicode CMap → cid → text, from `bfchar` and both `bfrange` forms. */
export function parseToUnicode(cmap: string): Map<number, string> {
  const out = new Map<number, string>()
  const utf16 = (h: string): string => {
    const units = (h.replace(/\s+/g, '').match(/.{1,4}/g) ?? []).map((u) => parseInt(u, 16))
    return String.fromCharCode(...units)
  }
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f\s]*)>/g))
      out.set(parseInt(m[1], 16), utf16(m[2]))
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f\s]*)>|\[([^\]]*)\])/g
    for (const m of block[1].matchAll(re)) {
      const lo = parseInt(m[1], 16)
      const hi = parseInt(m[2], 16)
      if (m[3] !== undefined) {
        const base = utf16(m[3])
        for (let c = lo; c <= hi && c - lo < 0x10000; c++) {
          const last = base.charCodeAt(base.length - 1) + (c - lo)
          out.set(c, base.slice(0, -1) + String.fromCharCode(last))
        }
      } else {
        const dsts = [...m[4].matchAll(/<([0-9A-Fa-f\s]*)>/g)].map((d) => utf16(d[1]))
        dsts.forEach((d, i) => out.set(lo + i, d))
      }
    }
  }
  return out
}

/** /W of a CIDFont → every CID it gives a width to. */
export function widthCids(w: PDFArray | undefined, doc: PDFDocument): number[] {
  if (!w) return []
  const out: number[] = []
  const items = w.asArray().map((o) => (o instanceof PDFRef ? doc.context.lookup(o) : o))
  for (let i = 0; i < items.length; ) {
    const first = items[i]
    const next = items[i + 1]
    if (!(first instanceof PDFNumber)) break
    if (next instanceof PDFArray) {
      for (let k = 0; k < next.size(); k++) out.push(first.asNumber() + k)
      i += 2
    } else if (next instanceof PDFNumber) {
      for (let c = first.asNumber(); c <= next.asNumber(); c++) out.push(c)
      i += 3
    } else break
  }
  return out
}

interface FontInfo {
  ref: PDFRef | undefined
  base: string
  map: Map<number, string>
  wCids: number[]
  gidCids: number[]
}

/** Every Type0 font of the file, with its decoded tables. */
function type0Fonts(doc: PDFDocument): FontInfo[] {
  const out: FontInfo[] = []
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj.get(PDFName.of('Subtype')) !== PDFName.of('Type0'))
      continue
    const base = obj.lookupMaybe(PDFName.of('BaseFont'), PDFName)?.decodeText() ?? ''
    const tu = obj.lookupMaybe(PDFName.of('ToUnicode'), PDFStream)
    const map = tu ? parseToUnicode(latin1(streamData(tu))) : new Map<number, string>()
    const desc = obj.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)
    const cid = desc ? doc.context.lookupMaybe(desc.get(0), PDFDict) : undefined
    const wCids = widthCids(cid?.lookupMaybe(PDFName.of('W'), PDFArray), doc)
    // A stream maps CID → GID; the name /Identity (what pdf-lib writes) means GID = CID.
    const gidMap = cid?.get(PDFName.of('CIDToGIDMap'))
    const gidStream = gidMap instanceof PDFRef ? doc.context.lookup(gidMap) : gidMap
    const gidCids: number[] = []
    if (gidStream instanceof PDFStream) {
      const g = streamData(gidStream)
      for (let c = 0; 2 * c + 1 < g.length; c++) if (g[2 * c] || g[2 * c + 1]) gidCids.push(c)
    }
    out.push({ ref, base, map, wCids, gidCids })
  }
  return out
}

/** Every PDFString / PDFHexString reachable inside `obj` (dicts and arrays, not through refs). */
function* stringsIn(obj: PDFObject | undefined, depth = 0): Generator<PDFString | PDFHexString> {
  if (!obj || depth > 64) return
  if (obj instanceof PDFString || obj instanceof PDFHexString) yield obj
  else if (obj instanceof PDFArray) for (const o of obj.asArray()) yield* stringsIn(o, depth + 1)
  else if (obj instanceof PDFDict) for (const [, v] of obj.entries()) yield* stringsIn(v, depth + 1)
  else if (obj instanceof PDFStream) yield* stringsIn(obj.dict, depth + 1)
}

const HEX_TOKEN = /(?<!<)<([0-9A-Fa-f\s]+)>(?!>)/g
const TOKEN = /\/[^\s/<>[\]()%{}]+|(?<!<)<[0-9A-Fa-f\s]*>(?!>)|[A-Za-z'"*]+|[-+.\d]+/g

/** The CIDs each font resource shows in a content stream: font resource name → CIDs. */
function shownCids(content: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  let font: string | null = null
  const tokens = content.match(TOKEN) ?? []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === 'Tf' && i >= 2 && tokens[i - 2].startsWith('/')) font = tokens[i - 2].slice(1)
    else if (t.startsWith('<') && font) {
      const hex = t.slice(1, -1).replace(/\s+/g, '')
      let set = out.get(font)
      if (!set) out.set(font, (set = new Set()))
      for (let k = 0; k + 4 <= hex.length; k += 4) set.add(parseInt(hex.slice(k, k + 4), 16))
    }
  }
  return out
}

/** Every content stream of a page and of the Form XObjects it reaches, with their font dicts. */
function pageContents(doc: PDFDocument): { text: string; fonts: PDFDict | undefined }[] {
  const out: { text: string; fonts: PDFDict | undefined }[] = []
  const seen = new Set<PDFStream>()
  const visit = (stream: PDFStream, resources: PDFDict | undefined, depth: number): void => {
    if (seen.has(stream) || depth > 16) return
    seen.add(stream)
    out.push({ text: latin1(streamData(stream)), fonts: resources?.lookupMaybe(PDFName.of('Font'), PDFDict) }) // prettier-ignore
    const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict)
    for (const [, v] of xobjects?.entries() ?? []) {
      const x = v instanceof PDFRef ? doc.context.lookup(v) : v
      if (x instanceof PDFStream && x.dict.get(PDFName.of('Subtype')) === PDFName.of('Form'))
        visit(x, x.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources, depth + 1)
    }
  }
  for (const page of doc.getPages()) {
    const res = page.node.Resources()
    const entry = page.node.get(PDFName.of('Contents'))
    const resolved = entry instanceof PDFRef ? doc.context.lookup(entry) : entry
    const refs = resolved instanceof PDFArray ? resolved.asArray() : entry ? [entry] : []
    // A page's streams are one content stream split in pieces: decode them joined.
    const parts = refs.map((r) => (r instanceof PDFRef ? doc.context.lookup(r) : r))
    const joined = parts
      .filter((p): p is PDFStream => p instanceof PDFStream)
      .map((p) => {
        seen.add(p)
        return latin1(streamData(p))
      })
      .join('\n')
    out.push({ text: joined, fonts: res?.lookupMaybe(PDFName.of('Font'), PDFDict) })
    const xobjects = res?.lookupMaybe(PDFName.of('XObject'), PDFDict)
    for (const [, v] of xobjects?.entries() ?? []) {
      const x = v instanceof PDFRef ? doc.context.lookup(v) : v
      if (x instanceof PDFStream && x.dict.get(PDFName.of('Subtype')) === PDFName.of('Form'))
        visit(x, x.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? res, 1)
    }
  }
  return out
}

/** The base64 attachments of an embedded .pdfx manifest, decoded. */
function manifestAttachments(buffers: Uint8Array[]): Uint8Array[] {
  const out: Uint8Array[] = []
  for (const b of buffers) {
    const s = new TextDecoder().decode(b)
    if (!s.trimStart().startsWith('{') || !s.includes('"pdfx"')) continue
    try {
      const m = JSON.parse(s) as { attachments?: Record<string, { data?: string }> }
      for (const a of Object.values(m.attachments ?? {}))
        if (typeof a?.data === 'string')
          out.push(Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0)))
    } catch {
      continue
    }
  }
  return out
}

/** Every finding of the raw-bytes oracle for `secret` in the saved file `bytes` (see header). */
export async function rawLeaks(bytes: Uint8Array, secret: Secret): Promise<string[]> {
  const found: string[] = []
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
  const buffers: { name: string; data: Uint8Array; image?: boolean }[] = [
    { name: 'file', data: bytes }
  ]
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream)) continue
    const image = obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')
    buffers.push({ name: `stream ${ref.toString()}`, data: streamData(obj), image })
  }
  for (const [i, data] of manifestAttachments(buffers.map((b) => b.data)).entries())
    buffers.push({ name: `manifest attachment ${i}`, data })

  // 1) The words, in every encoding, in every buffer.
  for (const w of secret.words) {
    const forms: [string, Uint8Array | null][] = [
      ['utf-8', new TextEncoder().encode(w)],
      ['utf-16be', utf16be(w)],
      ['utf-16le', utf16le(w)],
      ['pdfdoc', pdfDocEncoding(w)]
    ]
    const hexForms = [toHex(utf16be(w)), toHex(new TextEncoder().encode(w))]
    for (const { name, data } of buffers) {
      for (const [enc, needle] of forms)
        if (needle && includes(data, needle)) found.push(`${name}: "${w}" as ${enc}`)
      const text = latin1(data).replace(/\s+/g, '').toLowerCase()
      for (const h of hexForms) if (text.includes(h)) found.push(`${name}: "${w}" as hex ${h}`)
    }
  }

  // 2) Every string object, decoded.
  const unique = new Set(secret.uniqueCps)
  const textHits = (where: string, s: string): void => {
    for (const w of secret.words) if (s.includes(w)) found.push(`${where}: "${w}"`)
    for (const c of s) if (unique.has(c.codePointAt(0)!)) found.push(`${where}: U+${hex4(c.codePointAt(0)!)}`) // prettier-ignore
  }
  for (const [ref, obj] of doc.context.enumerateIndirectObjects())
    for (const s of stringsIn(obj)) textHits(`string in ${ref.toString()}`, s.decodeText())
  for (const s of stringsIn(doc.context.trailerInfo.Info)) textHits('trailer Info', s.decodeText())

  // 3) Character tables, and content hex decoded through them.
  const fonts = type0Fonts(doc)
  for (const f of fonts) {
    for (const [cid, t] of f.map) textHits(`ToUnicode of ${f.base} (CID ${cid})`, t)
    // The word as a CID sequence of this font, if every code point has a CID.
    const cidOf = new Map<string, number>()
    for (const [cid, t] of f.map) if (!cidOf.has(t)) cidOf.set(t, cid)
    for (const w of secret.words) {
      const cids = [...w].map((c) => cidOf.get(c))
      if (cids.some((c) => c === undefined)) continue
      const hex = cids.map((c) => hex4(c!)).join('')
      const bin = Uint8Array.from(cids.flatMap((c) => [c! >> 8, c! & 0xff]))
      for (const { name, data, image } of buffers) {
        if (latin1(data).replace(/\s+/g, '').toUpperCase().includes(hex))
          found.push(`${name}: "${w}" as CIDs <${hex}> of ${f.base}`)
        if (!image && includes(data, bin)) found.push(`${name}: "${w}" as CID bytes of ${f.base}`)
      }
    }
  }
  const contents = pageContents(doc)
  for (const { text } of contents)
    for (const m of text.matchAll(HEX_TOKEN)) {
      const hex = m[1].replace(/\s+/g, '')
      for (const f of fonts) {
        let s = ''
        for (let k = 0; k + 4 <= hex.length; k += 4) s += f.map.get(parseInt(hex.slice(k, k + 4), 16)) ?? '' // prettier-ignore
        if (s) textHits(`content hex through ${f.base}`, s)
      }
    }

  // 4) Rule 5: a PDFx OCR font describes only CIDs a page shows with it.
  const shownBy = new Map<PDFRef, Set<number>>()
  for (const { text, fonts: res } of contents) {
    for (const [name, cids] of shownCids(text)) {
      const ref = res?.get(PDFName.of(name))
      if (!(ref instanceof PDFRef)) continue
      let set = shownBy.get(ref)
      if (!set) shownBy.set(ref, (set = new Set()))
      for (const c of cids) set.add(c)
    }
  }
  for (const f of fonts) {
    if (f.base !== OCR_FONT_NAME && !f.base.endsWith(`+${OCR_FONT_NAME}`)) continue
    const shown = (f.ref && shownBy.get(f.ref)) || new Set<number>()
    const describe = (what: string, cids: number[]): void => {
      const extra = cids.filter((c) => c !== MONO_GUARD_CID && !shown.has(c))
      if (extra.length) found.push(`${f.base} ${f.ref?.toString()}: ${what} describes unshown CIDs ${extra.join(',')}`) // prettier-ignore
    }
    describe('ToUnicode', [...f.map.keys()])
    describe('/W', f.wCids)
    describe('CIDToGIDMap', f.gidCids)
  }
  return found
}

/** Is there a .pdfx manifest embedded in `bytes` (so the oracle searched it)? */
export async function hasManifest(bytes: Uint8Array): Promise<boolean> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)
  const ef = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict)
  const arr = ef?.lookupMaybe(PDFName.of('Names'), PDFArray)
  if (!arr) return false
  for (let i = 0; i < arr.size(); i += 2) {
    const k = arr.lookup(i)
    if ((k instanceof PDFString || k instanceof PDFHexString) && k.decodeText() === MANIFEST_NAME)
      return true
  }
  return false
}

/** Each redacted word or unique code point either shipped extractor reports, on any page. */
export async function extractorLeaks(
  pdfium: ProbePdfium,
  bytes: Uint8Array,
  secret: Secret
): Promise<string[]> {
  const found: string[] = []
  const pages = (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount()
  const unique = new Set(secret.uniqueCps)
  for (let i = 0; i < pages; i++) {
    const texts: [string, string][] = [
      ['pdf.js', pdfjsCopyText((await pdfjsText(bytes, i)).items)],
      ['PDFium', pdfiumCopyText(pdfiumProbe(pdfium, bytes, i))]
    ]
    for (const [who, t] of texts) {
      const squeezed = t.replace(/\s+/g, '')
      for (const w of secret.words)
        if (t.includes(w) || squeezed.includes(w.replace(/\s+/g, ''))) found.push(`${who} page ${i}: "${w}"`) // prettier-ignore
      for (const c of t) if (unique.has(c.codePointAt(0)!)) found.push(`${who} page ${i}: U+${hex4(c.codePointAt(0)!)}`) // prettier-ignore
    }
  }
  return found
}
