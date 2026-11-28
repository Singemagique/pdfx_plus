// XObject residue of a redaction (DESIGN.md §3.7.3, PR12 review). PDFium removes an image (or a
// Form XObject) under a redaction box from the PAGE, and gives the page a resource dictionary of
// its own, but it never takes the XObject out of a dictionary other pages list: one /Resources
// inherited from /Pages, or one indirect dictionary set on several pages. copyPages carries a
// page's whole resource dictionary, so exporting any OTHER page of that source would ship the
// unredacted original, unused but readable [measured, PDFium in @embedpdf/pdfium 2.14.4: page 1
// of such a file still lists the removed image after the pass, in both modes].
//
// `trimXObjects(doc)` finds every XObject the document can still PAINT, then takes every other
// image and Form XObject out of every /XObject resource dictionary, and returns them for the
// caller's unreachable sweep. What paints: each page's /Contents (its own or inherited resources),
// each annotation appearance stream, and, transitively, every Form XObject a painted stream draws
// with `Do`, plus the tiling patterns, soft-mask groups and Type3 glyph procedures of every
// resource dictionary a painted stream uses. A name counts only through the dictionary the
// drawing stream resolves it in, so a name that is merely LISTED (the shared dictionary's entry
// for the removed image) does not keep its XObject.
//
// Every uncertainty keeps, as in font-trim.ts: a stream that cannot be decoded (or nested past
// MAX_DEPTH) draws every XObject its resources list; a stream with no resources to resolve a
// name in keeps that name in every dictionary; the AcroForm /DR keeps its XObjects. Only images
// and Form XObjects are ever removed, and only from /XObject dictionaries, so nothing a reader
// paints changes. An encrypted document is left alone (its streams cannot be read here).

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFPageLeaf,
  PDFRef,
  PDFStream,
  type PDFContext,
  type PDFDocument,
  type PDFObject
} from 'pdf-lib'

import { contentOps, streamBytes } from './font-trim'

/** Nesting past this many forms is not followed: everything at that level is kept. */
const MAX_DEPTH = 32

const XOBJECT = PDFName.of('XObject')
const RESOURCES = PDFName.of('Resources')
const SUBTYPE = PDFName.of('Subtype')

class DrawScan {
  /** Every XObject ref some painted stream draws (or may draw). */
  readonly drawn = new Set<PDFRef>()
  /** Names drawn by a stream with no resources to look them up in: kept in every dictionary. */
  readonly loose = new Set<string>()
  private readonly seen = new Map<PDFStream, Set<PDFDict | undefined>>()
  private readonly seenRes = new Set<PDFDict>()

  constructor(private readonly ctx: PDFContext) {}

  private resolve(o: PDFObject | undefined): PDFObject | undefined {
    return o instanceof PDFRef ? this.ctx.lookup(o) : o
  }

  dict(o: PDFObject | undefined): PDFDict | undefined {
    const r = this.resolve(o)
    return r instanceof PDFDict ? r : undefined
  }

  private stream(o: PDFObject | undefined): PDFStream | undefined {
    const r = this.resolve(o)
    return r instanceof PDFStream ? r : undefined
  }

  /** Content `data` (null: unreadable) painted with `res`. */
  content(data: Uint8Array | null, res: PDFDict | undefined, depth: number): void {
    const xobjects = this.dict(res?.get(XOBJECT))
    if (depth > MAX_DEPTH) {
      // Too deep to follow: keep whatever it could draw.
      for (const [, v] of xobjects?.entries() ?? []) if (v instanceof PDFRef) this.drawn.add(v)
      return
    }
    this.painters(res, depth)
    if (!data) {
      for (const [, v] of xobjects?.entries() ?? []) this.draw(v, res, depth)
      return
    }
    for (const { op, operands } of contentOps(data)) {
      if (op !== 'Do') continue
      const name = operands[operands.length - 1]
      if (name?.k !== 'name') continue
      if (!res) {
        this.loose.add(name.v)
        continue
      }
      const v = xobjects?.get(PDFName.of(name.v))
      if (v !== undefined) this.draw(v, res, depth)
    }
  }

  /** A painted stream `s` with `res`, once per (stream, resources) pair. */
  paint(s: PDFStream, res: PDFDict | undefined, depth: number): void {
    let set = this.seen.get(s)
    if (!set) this.seen.set(s, (set = new Set()))
    if (set.has(res)) return
    set.add(res)
    this.content(streamBytes(s), res, depth)
  }

  /** XObject `v`, drawn from a stream painted with `res`: a form paints its own content. */
  private draw(v: PDFObject, res: PDFDict | undefined, depth: number): void {
    if (v instanceof PDFRef) this.drawn.add(v)
    const s = this.stream(v)
    if (s?.dict.get(SUBTYPE) !== PDFName.of('Form')) return
    this.paint(s, this.dict(s.dict.get(RESOURCES)) ?? res, depth + 1)
  }

  /** What else in `res` paints content of its own (scanned whether used or not: it only keeps). */
  private painters(res: PDFDict | undefined, depth: number): void {
    if (!res || this.seenRes.has(res)) return
    this.seenRes.add(res)
    const own = (d: PDFDict): PDFDict | undefined => this.dict(d.get(RESOURCES)) ?? res
    for (const [, v] of this.dict(res.get(PDFName.of('Pattern')))?.entries() ?? []) {
      const p = this.stream(v)
      if (p) this.paint(p, own(p.dict), depth + 1)
    }
    for (const [, v] of this.dict(res.get(PDFName.of('ExtGState')))?.entries() ?? []) {
      const smask = this.dict(this.dict(v)?.get(PDFName.of('SMask')))
      const g = this.stream(smask?.get(PDFName.of('G')))
      if (g) this.paint(g, own(g.dict), depth + 1)
    }
    for (const [, v] of this.dict(res.get(PDFName.of('Font')))?.entries() ?? []) {
      const f = this.dict(v)
      if (!f || f.get(SUBTYPE) !== PDFName.of('Type3')) continue
      const fr = own(f)
      for (const [, p] of this.dict(f.get(PDFName.of('CharProcs')))?.entries() ?? []) {
        const s = this.stream(p)
        if (s) this.paint(s, fr, depth + 1)
      }
    }
  }
}

/** A page's content streams, read as the one stream they are (null when one cannot be read). */
function pageContent(ctx: PDFContext, node: PDFPageLeaf): Uint8Array | null {
  const c = node.get(PDFName.of('Contents'))
  const r = c instanceof PDFRef ? ctx.lookup(c) : c
  const parts = r instanceof PDFArray ? r.asArray() : r === undefined ? [] : [r]
  const chunks: Uint8Array[] = []
  for (const p of parts) {
    const s = p instanceof PDFRef ? ctx.lookup(p) : p
    if (!(s instanceof PDFStream)) continue
    const b = streamBytes(s)
    if (!b) return null
    chunks.push(b, Uint8Array.of(10))
  }
  const out = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0))
  let off = 0
  for (const b of chunks) {
    out.set(b, off)
    off += b.length
  }
  return out
}

/** Every XObject `doc` can still paint (see the header). */
function scanDocument(doc: PDFDocument): DrawScan {
  const ctx = doc.context
  const scan = new DrawScan(ctx)
  // Every page object, in the tree or not (as reachable.ts `deleteUnreachable` counts them).
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFPageLeaf)) continue
    scan.content(pageContent(ctx, obj), obj.Resources(), 0)
    const annots = ctx.lookup(obj.get(PDFName.of('Annots')))
    for (const a of annots instanceof PDFArray ? annots.asArray() : []) {
      const ap = scan.dict(scan.dict(a)?.get(PDFName.of('AP')))
      for (const [, v] of ap?.entries() ?? []) {
        const direct = ctx.lookup(v)
        const states =
          direct instanceof PDFStream
            ? [direct]
            : [...(scan.dict(v)?.entries() ?? [])].map(([, s]) => ctx.lookup(s))
        for (const s of states)
          if (s instanceof PDFStream) scan.paint(s, scan.dict(s.dict.get(RESOURCES)), 1)
      }
    }
  }
  // AcroForm default resources: kept whatever draws them.
  const acro = scan.dict(doc.catalog.get(PDFName.of('AcroForm')))
  const dr = scan.dict(acro?.get(PDFName.of('DR')))
  for (const [, v] of scan.dict(dr?.get(XOBJECT))?.entries() ?? [])
    if (v instanceof PDFRef) scan.drawn.add(v)
  return scan
}

/**
 * Take every image and Form XObject nothing in `doc` paints out of every /XObject resource
 * dictionary (see the header). Returns their refs, for reachable.ts `deleteUnreachable`.
 */
export function trimXObjects(doc: PDFDocument): PDFRef[] {
  if (doc.isEncrypted) return []
  const ctx = doc.context
  const scan = scanDocument(doc)
  const unlinked: PDFRef[] = []
  const done = new Set<PDFDict>()
  const prune = (xobjects: PDFDict): void => {
    if (done.has(xobjects)) return
    done.add(xobjects)
    for (const [k, v] of xobjects.entries()) {
      if (!(v instanceof PDFRef) || scan.drawn.has(v) || scan.loose.has(k.decodeText())) continue
      const s = ctx.lookup(v)
      const sub = s instanceof PDFStream ? s.dict.get(SUBTYPE) : undefined
      if (sub !== PDFName.of('Image') && sub !== PDFName.of('Form')) continue
      xobjects.delete(k)
      unlinked.push(v)
    }
  }
  // Every /XObject dictionary of the file: in any object, its stream dict, or a direct dict or
  // array nested in it.
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const stack: PDFObject[] = [obj]
    while (stack.length) {
      const o = stack.pop()!
      if (o instanceof PDFStream) stack.push(o.dict)
      else if (o instanceof PDFArray) stack.push(...o.asArray())
      else if (o instanceof PDFDict) {
        const x = scan.dict(o.get(XOBJECT))
        if (x) prune(x)
        for (const [, v] of o.entries()) if (!(v instanceof PDFRef)) stack.push(v)
      }
    }
  }
  return unlinked
}
