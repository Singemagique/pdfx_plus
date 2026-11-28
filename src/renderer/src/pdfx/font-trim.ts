// Font residue of a redaction (DESIGN.md §3.7.3, rule 5 for NATIVE fonts). PDFium removes the text
// objects under a redaction box, but the fonts they were shown in keep every character table they
// had: a ToUnicode CMap, /W, CIDToGIDMap, CIDSet, /Differences, /Widths and the glyph program
// itself. A subset producer that numbers glyphs in first-use order (pdf-lib, among others) makes
// that ToUnicode spell the redacted words out in order, and the glyph program still draws them.
//
// `trimFonts(doc)` rewrites every font of a document to what its content still SHOWS:
// 1. Scan every content stream a reader can paint (each page's /Contents, every Form XObject and
//    tiling Pattern in any resource dictionary it reaches, ExtGState soft-mask groups, annotation
//    appearance streams, Type3 glyph procedures) and record the codes shown in each font (Tj, ',
//    ", TJ after the Tf in effect, q/Q tracked).
// 2. For each font, keep only those codes in: ToUnicode (rewritten as bfchar), /W and /W2, the
//    CIDToGIDMap stream, the CIDSet, /Differences, /Widths, and Type3 /CharProcs.
// 3. Zero the TrueType glyph outlines (FontFile2 `glyf`) no kept code reaches (composites keep
//    their components; GID 0 stays), unioned over every font sharing the program.
// Over-keeping is the safe direction for rendering, so every uncertainty keeps: a font set by an
// ExtGState /Font, listed in the AcroForm /DR (field appearances are regenerated from it), or
// reached from a stream that cannot be decoded is left untouched, as is a Type0 font whose
// encoding is not Identity-H/V (its codes cannot be split without its CMap); and when any stream
// shows text before its own Tf (a Form XObject drawing in the font its caller set), no font of the
// document is trimmed, because the scan cannot tell which font that is. Known residue, not
// rewritten: CFF and Type1 glyph programs (FontFile3, FontFile), simple TrueType glyph programs
// (their code → glyph mapping goes through the program's own cmap), and the program's own
// cmap/post/hmtx tables.

import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  type PDFDocument,
  type PDFObject
} from 'pdf-lib'

// ---------------------------------------------------------------------------------------------
// A content-stream lexer: operators and their operands (strings as raw bytes)

type Operand =
  | { k: 'num'; v: number }
  | { k: 'name'; v: string }
  | { k: 'str'; v: Uint8Array }
  | { k: 'arr'; v: Operand[] }
  | { k: 'other' }

export interface ContentOp {
  op: string
  operands: Operand[]
}

const WS = new Set([0, 9, 10, 12, 13, 32])
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25])
const isRegular = (c: number): boolean => !WS.has(c) && !DELIM.has(c)
const hexVal = (c: number): number =>
  c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1 // prettier-ignore

/**
 * The operators of a content stream in order. Lenient: an unknown byte is skipped, an unclosed
 * string ends at the end of the data, an operator closes any array or dict left open, and inline
 * image data (BI … ID … EI) is skipped.
 */
export function contentOps(data: Uint8Array): ContentOp[] {
  const ops: ContentOp[] = []
  const n = data.length
  let i = 0
  // Operand stack; arrays and dicts nest as frames.
  const frames: { kind: 'top' | 'arr' | 'dict'; items: Operand[] }[] = [{ kind: 'top', items: [] }]
  const push = (o: Operand): void => void frames[frames.length - 1].items.push(o)

  while (i < n) {
    const c = data[i]
    if (WS.has(c)) {
      i++
    } else if (c === 0x25) {
      while (i < n && data[i] !== 10 && data[i] !== 13) i++
    } else if (c === 0x28) {
      // Literal string with nesting and escapes.
      const out: number[] = []
      let depth = 1
      i++
      while (i < n) {
        const b = data[i++]
        if (b === 0x5c) {
          if (i >= n) break
          const e = data[i++]
          if (e === 0x6e) out.push(10)
          else if (e === 0x72) out.push(13)
          else if (e === 0x74) out.push(9)
          else if (e === 0x62) out.push(8)
          else if (e === 0x66) out.push(12)
          else if (e >= 0x30 && e <= 0x37) {
            let v = e - 0x30
            for (let k = 0; k < 2 && i < n && data[i] >= 0x30 && data[i] <= 0x37; k++)
              v = v * 8 + (data[i++] - 0x30)
            out.push(v & 0xff)
          } else if (e === 13) {
            if (data[i] === 10) i++
          } else if (e !== 10) out.push(e)
        } else if (b === 0x28) {
          depth++
          out.push(b)
        } else if (b === 0x29) {
          if (--depth === 0) break
          out.push(b)
        } else out.push(b)
      }
      push({ k: 'str', v: Uint8Array.from(out) })
    } else if (c === 0x3c && data[i + 1] === 0x3c) {
      frames.push({ kind: 'dict', items: [] })
      i += 2
    } else if (c === 0x3e && data[i + 1] === 0x3e) {
      if (frames.length > 1 && frames[frames.length - 1].kind === 'dict') frames.pop()
      push({ k: 'other' })
      i += 2
    } else if (c === 0x3c) {
      const out: number[] = []
      let hi = -1
      i++
      while (i < n && data[i] !== 0x3e) {
        const v = hexVal(data[i++])
        if (v < 0) continue
        if (hi < 0) hi = v
        else {
          out.push(hi * 16 + v)
          hi = -1
        }
      }
      if (hi >= 0) out.push(hi * 16)
      i++
      push({ k: 'str', v: Uint8Array.from(out) })
    } else if (c === 0x5b) {
      frames.push({ kind: 'arr', items: [] })
      i++
    } else if (c === 0x5d) {
      i++
      if (frames.length > 1 && frames[frames.length - 1].kind === 'arr') {
        const f = frames.pop()!
        push({ k: 'arr', v: f.items })
      }
    } else if (c === 0x2f) {
      let s = ''
      i++
      while (i < n && isRegular(data[i])) {
        if (data[i] === 0x23 && hexVal(data[i + 1]) >= 0 && hexVal(data[i + 2]) >= 0) {
          s += String.fromCharCode(hexVal(data[i + 1]) * 16 + hexVal(data[i + 2]))
          i += 3
        } else s += String.fromCharCode(data[i++])
      }
      push({ k: 'name', v: s })
    } else if (isRegular(c)) {
      let s = ''
      while (i < n && isRegular(data[i])) s += String.fromCharCode(data[i++])
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) push({ k: 'num', v: Number(s) })
      else if (s === 'true' || s === 'false' || s === 'null') push({ k: 'other' })
      else {
        // An operator inside an array or dict means one was never closed: drop the open frames
        // and read on, rather than swallowing the rest of the stream as operands.
        frames.length = 1
        ops.push({ op: s, operands: frames[0].items })
        frames[0].items = []
        if (s === 'ID') {
          // Inline image data: up to whitespace, EI, then whitespace or the end.
          i++
          while (i < n) {
            if (
              WS.has(data[i]) &&
              data[i + 1] === 0x45 &&
              data[i + 2] === 0x49 &&
              (i + 3 >= n || WS.has(data[i + 3]))
            ) {
              i += 3
              break
            }
            i++
          }
          ops.push({ op: 'EI', operands: [] })
        }
      }
    } else {
      i++ // a stray delimiter ({, }, a lone >)
    }
  }
  return ops
}

// ---------------------------------------------------------------------------------------------
// Which codes each font shows

/** How a font's strings split into codes. `other`: not split here, so never trimmed. */
type FontKind = 'simple' | 'identity' | 'other'

interface FontUse {
  kind: FontKind
  codes: Set<number>
  /** Set some way the scan cannot follow, or reached from undecodable content: never trimmed. */
  unknown: boolean
}

function fontKind(font: PDFDict): FontKind {
  const sub = font.get(PDFName.of('Subtype'))
  if (sub !== PDFName.of('Type0')) return 'simple'
  const enc = font.get(PDFName.of('Encoding'))
  return enc === PDFName.of('Identity-H') || enc === PDFName.of('Identity-V') ? 'identity' : 'other'
}

/** A stream's decoded bytes; null when its filters cannot be decoded here. */
function streamBytes(s: PDFStream): Uint8Array | null {
  try {
    if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode()
    const u = (s as { getUnencodedContents?: () => Uint8Array }).getUnencodedContents
    return u ? u.call(s) : s.getContents()
  } catch {
    return null
  }
}

const resolve = (doc: PDFDocument, o: PDFObject | undefined): PDFObject | undefined =>
  o instanceof PDFRef ? doc.context.lookup(o) : o

const asDict = (doc: PDFDocument, o: PDFObject | undefined): PDFDict | undefined => {
  const r = resolve(doc, o)
  return r instanceof PDFDict ? r : undefined
}

const asStream = (doc: PDFDocument, o: PDFObject | undefined): PDFStream | undefined => {
  const r = resolve(doc, o)
  return r instanceof PDFStream ? r : undefined
}

/** The font an ExtGState /Font sets: already marked unknown, so what it shows is not recorded. */
const GS_FONT: FontUse = { kind: 'other', codes: new Set(), unknown: true }

class UsageScan {
  readonly uses = new Map<PDFDict, FontUse>()
  /**
   * Text was shown before any Tf in its stream: a Form XObject, pattern or appearance showing in
   * the font its CALLER set (the text font is graphics state, which a form inherits). Which font
   * that is depends on the caller, so no font may be trimmed.
   */
  inheritedFont = false
  private readonly seen = new Map<PDFStream, Set<PDFDict | undefined>>()
  private readonly seenRes = new Set<PDFDict>()

  constructor(private readonly doc: PDFDocument) {}

  use(font: PDFDict): FontUse {
    let u = this.uses.get(font)
    if (!u) this.uses.set(font, (u = { kind: fontKind(font), codes: new Set(), unknown: false }))
    return u
  }

  /** Every font of `res`, and every Form XObject / tiling Pattern / soft mask it reaches. */
  resources(res: PDFDict | undefined, depth: number): void {
    if (!res || this.seenRes.has(res) || depth > 32) return
    this.seenRes.add(res)
    const fonts = asDict(this.doc, res.get(PDFName.of('Font')))
    for (const [, v] of fonts?.entries() ?? []) {
      const f = asDict(this.doc, v)
      if (f) this.font(f, res, depth)
    }
    const xobjects = asDict(this.doc, res.get(PDFName.of('XObject')))
    for (const [, v] of xobjects?.entries() ?? []) {
      const x = asStream(this.doc, v)
      if (x && x.dict.get(PDFName.of('Subtype')) === PDFName.of('Form'))
        this.formLike(x, res, depth)
    }
    const patterns = asDict(this.doc, res.get(PDFName.of('Pattern')))
    for (const [, v] of patterns?.entries() ?? []) {
      const p = asStream(this.doc, v)
      if (p) this.formLike(p, res, depth)
    }
    const gstates = asDict(this.doc, res.get(PDFName.of('ExtGState')))
    for (const [, v] of gstates?.entries() ?? []) {
      const gs = asDict(this.doc, v)
      if (!gs) continue
      const f = gs.get(PDFName.of('Font'))
      const fa = resolve(this.doc, f)
      if (fa instanceof PDFArray) {
        const fd = asDict(this.doc, fa.get(0))
        if (fd) this.use(fd).unknown = true
      }
      const smask = asDict(this.doc, gs.get(PDFName.of('SMask')))
      const g = smask && asStream(this.doc, smask.get(PDFName.of('G')))
      if (g) this.formLike(g, res, depth)
    }
  }

  /** A font found in `res`: a Type3 font's glyph procedures are content too. */
  private font(font: PDFDict, res: PDFDict, depth: number): void {
    this.use(font)
    if (font.get(PDFName.of('Subtype')) !== PDFName.of('Type3')) return
    const own = asDict(this.doc, font.get(PDFName.of('Resources'))) ?? res
    const procs = asDict(this.doc, font.get(PDFName.of('CharProcs')))
    for (const [, v] of procs?.entries() ?? []) {
      const s = asStream(this.doc, v)
      if (s) this.stream(s, own, depth + 1)
    }
  }

  /** A Form XObject, tiling Pattern or transparency group: its own resources, else `res`. */
  private formLike(s: PDFStream, res: PDFDict | undefined, depth: number): void {
    const own = asDict(this.doc, s.dict.get(PDFName.of('Resources'))) ?? res
    this.stream(s, own, depth + 1)
  }

  /** Content `bytes` (or `stream`) painted with `res`. */
  stream(s: PDFStream | Uint8Array | null, res: PDFDict | undefined, depth: number): void {
    if (depth > 32) return
    if (s instanceof PDFStream) {
      let set = this.seen.get(s)
      if (!set) this.seen.set(s, (set = new Set()))
      if (set.has(res)) return
      set.add(res)
    }
    this.resources(res, depth)
    const data = s instanceof PDFStream ? streamBytes(s) : s
    const fonts = asDict(this.doc, res?.get(PDFName.of('Font')))
    if (!data) {
      // Content we cannot read: none of the fonts it could use may be trimmed.
      for (const [, v] of fonts?.entries() ?? []) {
        const f = asDict(this.doc, v)
        if (f) this.use(f).unknown = true
      }
      return
    }
    const stack: (FontUse | undefined)[] = []
    let current: FontUse | undefined
    const show = (o: Operand | undefined): void => {
      if (o?.k !== 'str') return
      if (!current) {
        this.inheritedFont = true
        return
      }
      const b = o.v
      if (current.kind === 'identity')
        for (let k = 0; k + 1 < b.length; k += 2) current.codes.add((b[k] << 8) | b[k + 1])
      else if (current.kind === 'simple') for (const c of b) current.codes.add(c)
    }
    for (const { op, operands } of contentOps(data)) {
      if (op === 'q') stack.push(current)
      else if (op === 'Q') current = stack.length ? stack.pop() : current
      else if (op === 'Tf') {
        const name = operands[operands.length - 2]
        const f = name?.k === 'name' ? asDict(this.doc, fonts?.get(PDFName.of(name.v))) : undefined
        current = f ? this.use(f) : undefined
      } else if (op === 'gs') {
        // An ExtGState /Font: marked unknown in `resources`; the codes shown next are not ours.
        const name = operands[operands.length - 1]
        const gs =
          name?.k === 'name'
            ? asDict(this.doc, asDict(this.doc, res?.get(PDFName.of('ExtGState')))?.get(PDFName.of(name.v))) // prettier-ignore
            : undefined
        if (gs?.get(PDFName.of('Font'))) current = GS_FONT
      } else if (op === 'Tj' || op === "'") show(operands[operands.length - 1])
      else if (op === '"') show(operands[operands.length - 1])
      else if (op === 'TJ') {
        const arr = operands[operands.length - 1]
        if (arr?.k === 'arr') for (const o of arr.v) show(o)
      }
    }
  }
}

/** Every content a reader can paint in `doc`, scanned (see the header). */
function scanDocument(doc: PDFDocument): UsageScan {
  const scan = new UsageScan(doc)
  for (const page of doc.getPages()) {
    const node = page.node
    const res = asDict(doc, node.getInheritableAttribute(PDFName.of('Resources')))
    const contents = resolve(doc, node.get(PDFName.of('Contents')))
    const parts =
      contents instanceof PDFArray
        ? contents.asArray().map((p) => asStream(doc, p))
        : [contents instanceof PDFStream ? contents : undefined]
    // A page's streams are one content stream split at token boundaries: read them joined.
    const chunks: Uint8Array[] = []
    let readable = true
    for (const p of parts) {
      if (!p) continue
      const b = streamBytes(p)
      if (!b) readable = false
      else chunks.push(b, Uint8Array.of(10))
    }
    const joined = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0))
    let off = 0
    for (const c of chunks) {
      joined.set(c, off)
      off += c.length
    }
    scan.stream(readable ? joined : null, res, 0)
    // Annotation appearances: /N, /R, /D, each a stream or a dict of appearance states.
    const annots = resolve(doc, node.get(PDFName.of('Annots')))
    for (const a of annots instanceof PDFArray ? annots.asArray() : []) {
      const ap = asDict(doc, asDict(doc, a)?.get(PDFName.of('AP')))
      for (const [, v] of ap?.entries() ?? []) {
        const direct = asStream(doc, v)
        const states = direct ? [direct] : [...(asDict(doc, v)?.entries() ?? [])].map(([, s]) => asStream(doc, s)) // prettier-ignore
        for (const s of states)
          if (s) scan.stream(s, asDict(doc, s.dict.get(PDFName.of('Resources'))), 1)
      }
    }
  }
  // AcroForm default resources: viewers regenerate field appearances with these fonts.
  const acro = asDict(doc, doc.catalog.get(PDFName.of('AcroForm')))
  const dr = asDict(doc, acro?.get(PDFName.of('DR')))
  for (const [, v] of asDict(doc, dr?.get(PDFName.of('Font')))?.entries() ?? []) {
    const f = asDict(doc, v)
    if (f) scan.use(f).unknown = true
  }
  return scan
}

// ---------------------------------------------------------------------------------------------
// Character tables

/** ToUnicode CMap → code → UTF-16 text, from `bfchar` and both `bfrange` forms. */
export function parseToUnicode(cmap: string): Map<number, string> {
  const out = new Map<number, string>()
  const utf16 = (h: string): string => {
    const units = (h.replace(/\s+/g, '').match(/.{1,4}/g) ?? []).map((u) => parseInt(u.padEnd(4, '0'), 16)) // prettier-ignore
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

const hex = (n: number, digits: number): string =>
  n.toString(16).toUpperCase().padStart(digits, '0')

/** A ToUnicode CMap of exactly `map` (codes of `bytes` bytes). */
export function writeToUnicode(map: ReadonlyMap<number, string>, bytes: 1 | 2): string {
  const d = bytes * 2
  const lines = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    `<${hex(0, d)}> <${hex(bytes === 1 ? 0xff : 0xffff, d)}>`,
    'endcodespacerange'
  ]
  const entries = [...map].sort((a, b) => a[0] - b[0])
  for (let k = 0; k < entries.length; k += 100) {
    const chunk = entries.slice(k, k + 100)
    lines.push(`${chunk.length} beginbfchar`)
    for (const [code, text] of chunk) {
      // UTF-16BE code units (a surrogate pair is two).
      const dst = Array.from({ length: text.length }, (_, i) => hex(text.charCodeAt(i), 4)).join('')
      lines.push(`<${hex(code, d)}> <${dst}>`)
    }
    lines.push('endbfchar')
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end')
  return lines.join('\n')
}

/** /W (or /W2 with `per` = 3) → CID → its numbers. */
function parseWidths(doc: PDFDocument, w: PDFArray, per: 1 | 3): Map<number, number[]> {
  const out = new Map<number, number[]>()
  const items = w.asArray().map((o) => resolve(doc, o))
  const num = (o: PDFObject | undefined): number | undefined =>
    o instanceof PDFNumber ? o.asNumber() : undefined
  for (let i = 0; i < items.length; ) {
    const first = num(items[i])
    const next = items[i + 1]
    if (first === undefined) break
    if (next instanceof PDFArray) {
      const vals = next.asArray().map((o) => num(resolve(doc, o)) ?? 0)
      for (let k = 0; k * per + per <= vals.length; k++)
        out.set(first + k, vals.slice(k * per, k * per + per))
      i += 2
    } else {
      const last = num(next)
      const vals = items.slice(i + 2, i + 2 + per).map((o) => num(o) ?? 0)
      if (last === undefined || vals.length < per) break
      for (let c = first; c <= last && c - first < 0x10000; c++) out.set(c, vals)
      i += 2 + per
    }
  }
  return out
}

/** /W or /W2 of exactly `map`, consecutive CIDs grouped. */
function writeWidths(doc: PDFDocument, map: ReadonlyMap<number, number[]>): PDFArray {
  const out: PDFObject[] = []
  const cids = [...map.keys()].sort((a, b) => a - b)
  for (let k = 0; k < cids.length; ) {
    let e = k
    while (e + 1 < cids.length && cids[e + 1] === cids[e] + 1) e++
    out.push(PDFNumber.of(cids[k]))
    out.push(doc.context.obj(cids.slice(k, e + 1).flatMap((c) => map.get(c)!)))
    k = e + 1
  }
  return doc.context.obj(out)
}

/** A new flate stream holding `data`, with `extra` dict entries. */
const newStream = (
  doc: PDFDocument,
  data: Uint8Array,
  extra: Record<string, PDFObject> = {}
): PDFRef =>
  // prettier-ignore
  doc.context.register(doc.context.flateStream(data, extra))

// ---------------------------------------------------------------------------------------------
// TrueType glyph programs

/**
 * `ttf` with the outline of every glyph outside `keep` (composite components added, GID 0 kept)
 * zeroed in place: numberOfContours 0, an empty glyph. Null when it is not a TrueType program
 * with glyf/loca this can read, or when nothing changes.
 */
export function zeroGlyphs(ttf: Uint8Array, keep: ReadonlySet<number>): Uint8Array | null {
  const dv = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength)
  if (ttf.length < 12) return null
  const version = dv.getUint32(0)
  if (version !== 0x00010000 && version !== 0x74727565) return null
  const numTables = dv.getUint16(4)
  const tables = new Map<string, { rec: number; off: number; len: number }>()
  for (let t = 0; t < numTables; t++) {
    const rec = 12 + 16 * t
    if (rec + 16 > ttf.length) return null
    const tag = String.fromCharCode(...ttf.subarray(rec, rec + 4))
    tables.set(tag, { rec, off: dv.getUint32(rec + 8), len: dv.getUint32(rec + 12) })
  }
  const head = tables.get('head')
  const maxp = tables.get('maxp')
  const loca = tables.get('loca')
  const glyf = tables.get('glyf')
  if (!head || !maxp || !loca || !glyf) return null
  if (glyf.off + glyf.len > ttf.length || loca.off + loca.len > ttf.length) return null
  const long = dv.getInt16(head.off + 50) === 1
  const numGlyphs = dv.getUint16(maxp.off + 4)
  if (loca.len < (numGlyphs + 1) * (long ? 4 : 2)) return null
  const at = (g: number): number =>
    long ? dv.getUint32(loca.off + 4 * g) : 2 * dv.getUint16(loca.off + 2 * g)
  const range = (g: number): [number, number] => [glyf.off + at(g), glyf.off + at(g + 1)]

  // Composite closure of what is kept.
  const kept = new Set<number>([0])
  const work = [...keep].filter((g) => g >= 0 && g < numGlyphs)
  while (work.length) {
    const g = work.pop()!
    if (kept.has(g) && g !== 0) continue
    kept.add(g)
    const [s, e] = range(g)
    if (e - s < 10 || e > glyf.off + glyf.len || dv.getInt16(s) >= 0) continue
    let p = s + 10
    for (let guard = 0; p + 4 <= e && guard < 256; guard++) {
      const flags = dv.getUint16(p)
      const comp = dv.getUint16(p + 2)
      if (comp < numGlyphs && !kept.has(comp)) work.push(comp)
      p += 4 + (flags & 0x1 ? 4 : 2)
      if (flags & 0x8) p += 2
      else if (flags & 0x40) p += 4
      else if (flags & 0x80) p += 8
      if (!(flags & 0x20)) break
    }
  }
  const out = ttf.slice()
  let changed = false
  for (let g = 0; g < numGlyphs; g++) {
    if (kept.has(g)) continue
    const [s, e] = range(g)
    if (e <= s || e > glyf.off + glyf.len) continue
    for (let k = s; k < e; k++) {
      if (out[k]) changed = true
      out[k] = 0
    }
  }
  if (!changed) return null
  // The glyf table checksum (viewers do not check it; tools that validate fonts do).
  const odv = new DataView(out.buffer)
  let sum = 0
  for (let k = 0; k < glyf.len; k += 4) {
    let word = 0
    for (let b = 0; b < 4; b++) word = (word << 8) | (k + b < glyf.len ? out[glyf.off + k + b] : 0)
    sum = (sum + (word >>> 0)) >>> 0
  }
  odv.setUint32(glyf.rec + 4, sum)
  return out
}

// ---------------------------------------------------------------------------------------------
// The rewrite

interface Program {
  stream: PDFStream
  ref: PDFRef | undefined
  /** The font descriptors naming it. */
  holders: Set<PDFDict>
  /** GIDs to keep; 'all' when some font using it is not trimmed. */
  keep: Set<number> | 'all'
}

/** What `trimFonts` changed (for tests and the caller's sweep). */
export interface TrimResult {
  /** Fonts whose tables were rewritten. */
  fonts: number
  /** Glyph programs whose outlines were zeroed. */
  programs: number
  /** Objects the rewrite unlinked (old tables): candidates for deleteUnreachable. */
  unlinked: PDFRef[]
}

/** Rewrite every font of `doc` to the codes its content still shows (see the header). */
export function trimFonts(doc: PDFDocument): TrimResult {
  const result: TrimResult = { fonts: 0, programs: 0, unlinked: [] }
  const scan = scanDocument(doc)
  // A show in an inherited font (see UsageScan): its codes are unknown, so every font keeps.
  if (scan.inheritedFont) for (const use of scan.uses.values()) use.unknown = true
  const programs = new Map<PDFStream, Program>()
  const ctx = doc.context
  const unlink = (o: PDFObject | undefined): void => {
    if (o instanceof PDFRef) result.unlinked.push(o)
  }
  const program = (desc: PDFDict | undefined): Program | undefined => {
    const raw = desc?.get(PDFName.of('FontFile2'))
    const s = asStream(doc, raw)
    if (!desc || !s) return undefined
    let p = programs.get(s)
    if (!p) programs.set(s, (p = { stream: s, ref: raw instanceof PDFRef ? raw : undefined, holders: new Set(), keep: new Set() })) // prettier-ignore
    p.holders.add(desc)
    return p
  }

  for (const [font, use] of scan.uses) {
    const descendants = resolve(doc, font.get(PDFName.of('DescendantFonts')))
    const cid = descendants instanceof PDFArray ? asDict(doc, descendants.get(0)) : undefined
    const desc = asDict(doc, (cid ?? font).get(PDFName.of('FontDescriptor')))
    const prog = program(desc)
    if (use.unknown || use.kind === 'other') {
      if (prog) prog.keep = 'all'
      continue
    }
    const codes = use.codes
    const bytes: 1 | 2 = use.kind === 'identity' ? 2 : 1
    let touched = false

    // ToUnicode.
    const tuRaw = font.get(PDFName.of('ToUnicode'))
    const tu = asStream(doc, tuRaw)
    if (tu) {
      const data = streamBytes(tu)
      const map = data ? parseToUnicode(new TextDecoder('latin1').decode(data)) : new Map()
      const kept = new Map([...map].filter(([c]) => codes.has(c)))
      // Always rewritten: whatever the original holds beyond the bfchar/bfrange this reads
      // (a usecmap, an odd form) does not survive either.
      font.set(PDFName.of('ToUnicode'), newStream(doc, new TextEncoder().encode(writeToUnicode(kept, bytes)))) // prettier-ignore
      unlink(tuRaw)
      if (!data || kept.size !== map.size) touched = true
    }

    if (use.kind === 'identity') {
      if (!cid) {
        if (prog) prog.keep = 'all'
        if (touched) result.fonts++
        continue
      }
      for (const key of ['W', 'W2'] as const) {
        const raw = cid.get(PDFName.of(key))
        const arr = resolve(doc, raw)
        if (!(arr instanceof PDFArray)) continue
        const map = parseWidths(doc, arr, key === 'W' ? 1 : 3)
        const kept = new Map([...map].filter(([c]) => codes.has(c)))
        if (kept.size !== map.size) {
          cid.set(PDFName.of(key), writeWidths(doc, kept))
          unlink(raw)
          touched = true
        }
      }
      // CIDToGIDMap: a stream maps CID → GID (2 bytes each); /Identity (or none): GID = CID.
      const mapRaw = cid.get(PDFName.of('CIDToGIDMap'))
      const mapStream = asStream(doc, mapRaw)
      const gidMap = mapStream ? streamBytes(mapStream) : null
      const gidOf = (c: number): number =>
        gidMap ? (2 * c + 1 < gidMap.length ? (gidMap[2 * c] << 8) | gidMap[2 * c + 1] : 0) : c
      if (mapStream && gidMap) {
        const next = new Uint8Array(gidMap.length)
        for (const c of codes)
          if (2 * c + 1 < gidMap.length) {
            next[2 * c] = gidMap[2 * c]
            next[2 * c + 1] = gidMap[2 * c + 1]
          }
        if (next.some((v, i) => v !== gidMap[i])) {
          cid.set(PDFName.of('CIDToGIDMap'), newStream(doc, next))
          unlink(mapRaw)
          touched = true
        }
      } else if (mapStream && !gidMap && prog) prog.keep = 'all'
      // CIDSet: one bit per CID present in the program.
      const setRaw = desc?.get(PDFName.of('CIDSet'))
      const set = asStream(doc, setRaw)
      const setData = set ? streamBytes(set) : null
      if (desc && setData) {
        const next = new Uint8Array(setData.length)
        for (const c of [0, ...codes])
          if (c >> 3 < next.length && setData[c >> 3] & (0x80 >> (c & 7)))
            next[c >> 3] |= 0x80 >> (c & 7)
        if (next.some((v, i) => v !== setData[i])) {
          desc.set(PDFName.of('CIDSet'), newStream(doc, next))
          unlink(setRaw)
          touched = true
        }
      }
      if (prog && prog.keep !== 'all') for (const c of codes) prog.keep.add(gidOf(c))
    } else {
      // A simple font: its glyph program is not trimmed here (see the header).
      if (prog) prog.keep = 'all'
      const first = font.lookupMaybe(PDFName.of('FirstChar'), PDFNumber)?.asNumber()
      const widthsRaw = font.get(PDFName.of('Widths'))
      const widths = resolve(doc, widthsRaw)
      if (first !== undefined && widths instanceof PDFArray) {
        const vals = widths.asArray().map((o) => resolve(doc, o))
        const zero = (o: PDFObject | undefined): boolean =>
          o instanceof PDFNumber && o.asNumber() === 0
        if (vals.some((o, k) => !codes.has(first + k) && !zero(o))) {
          const next = vals.map((o, k) => (codes.has(first + k) && o ? o : PDFNumber.of(0)))
          font.set(PDFName.of('Widths'), ctx.obj(next))
          unlink(widthsRaw)
          touched = true
        }
      }
      const enc = asDict(doc, font.get(PDFName.of('Encoding')))
      const diffRaw = enc?.get(PDFName.of('Differences'))
      const diffs = resolve(doc, diffRaw)
      const names = new Map<number, string>()
      if (enc && diffs instanceof PDFArray) {
        let code = 0
        for (const o of diffs.asArray().map((x) => resolve(doc, x))) {
          if (o instanceof PDFNumber) code = o.asNumber()
          else if (o instanceof PDFName) names.set(code++, o.decodeText())
        }
        const kept = [...names].filter(([c]) => codes.has(c)).sort((a, b) => a[0] - b[0])
        if (kept.length !== names.size) {
          const out: PDFObject[] = []
          let expect = -2
          for (const [c, n] of kept) {
            if (c !== expect) out.push(PDFNumber.of(c))
            out.push(PDFName.of(n))
            expect = c + 1
          }
          enc.set(PDFName.of('Differences'), ctx.obj(out))
          unlink(diffRaw)
          touched = true
        }
      }
      // Type3: a glyph procedure no shown code names is a drawing of a removed character.
      const procs = asDict(doc, font.get(PDFName.of('CharProcs')))
      if (procs && font.get(PDFName.of('Subtype')) === PDFName.of('Type3')) {
        const shownNames = new Set([...codes].map((c) => names.get(c)).filter(Boolean))
        for (const [k, v] of procs.entries())
          if (!shownNames.has(k.decodeText())) {
            procs.delete(k)
            unlink(v)
            touched = true
          }
      }
    }
    if (touched) result.fonts++
  }

  for (const p of programs.values()) {
    if (p.keep === 'all') continue
    const data = streamBytes(p.stream)
    const next = data && zeroGlyphs(data, p.keep)
    if (!next) continue
    const extra: Record<string, PDFObject> = { Length1: PDFNumber.of(next.length) }
    for (const [k, v] of p.stream.dict.entries()) {
      const key = k.decodeText()
      if (!['Length', 'Filter', 'DecodeParms', 'Length1', 'DL'].includes(key)) extra[key] = v
    }
    // Every descriptor naming the program follows (a descriptor no scanned font uses keeps the
    // old one, and with it whatever reaches it).
    const ref = newStream(doc, next, extra)
    for (const h of p.holders) h.set(PDFName.of('FontFile2'), ref)
    if (p.ref) result.unlinked.push(p.ref)
    result.programs++
  }
  return result
}
