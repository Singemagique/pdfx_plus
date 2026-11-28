// Deleting what an edit unlinked from a pdf-lib document. pdf-lib 1.17.1's save() writes EVERY
// object registered in the context, reachable or not, so unlinking a content stream or a font
// from a page does not take it out of the file: a raw-bytes reader still finds it. (DESIGN.md
// §3.7.3 rule 6's oracle inflates every stream of the saved file.)

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

/** Call `fn` for every ref `obj` holds directly (through its direct dicts, arrays and stream dict). */
export function forEachRef(obj: PDFObject | undefined, fn: (ref: PDFRef) => void): void {
  const stack: (PDFObject | undefined)[] = [obj]
  while (stack.length) {
    const o = stack.pop()
    if (o instanceof PDFRef) fn(o)
    else if (o instanceof PDFStream) stack.push(o.dict)
    else if (o instanceof PDFDict) for (const [, v] of o.entries()) stack.push(v)
    else if (o instanceof PDFArray) for (const v of o.asArray()) stack.push(v)
  }
}

/** Every ref reachable from `roots` (inclusive) without passing through a ref in `stop`. */
function closure(
  ctx: PDFContext,
  roots: Iterable<PDFRef>,
  stop: ReadonlySet<PDFRef> = new Set()
): Set<PDFRef> {
  const seen = new Set<PDFRef>()
  const queue = [...roots]
  while (queue.length) {
    const ref = queue.pop()!
    if (seen.has(ref) || stop.has(ref)) continue
    seen.add(ref)
    forEachRef(ctx.lookup(ref), (r) => {
      if (!seen.has(r)) queue.push(r)
    })
  }
  return seen
}

/**
 * Delete from `ctx` every object reachable from `candidates` that the document no longer reaches,
 * and return how many were deleted. "The document" is the trailer (Root, Info, Encrypt) plus
 * EVERY page object registered in the context, whether or not it is in the page tree yet: a page
 * returned by copyPages and not yet added still holds what it shares with its siblings (the old
 * OCR font of a reopened file, say), so nothing it uses is ever deleted. Objects merely
 * referenced by other unreachable objects (an old indirect /Contents array, say) do not keep a
 * candidate alive. Refs the context holds no object for yet (pdf-lib embedders write theirs at
 * save) are simply skipped.
 */
export function deleteUnreachable(ctx: PDFContext, candidates: Iterable<PDFRef>): number {
  const roots: PDFRef[] = []
  const { Root, Info, Encrypt } = ctx.trailerInfo
  for (const o of [Root, Info, Encrypt]) forEachRef(o, (r) => roots.push(r))
  for (const [ref, obj] of ctx.enumerateIndirectObjects())
    if (obj instanceof PDFPageLeaf) roots.push(ref)
  const reachable = closure(ctx, roots)
  // What the candidates reach, minus (and never walking through) what the document reaches.
  const garbage = closure(ctx, candidates, reachable)
  for (const r of garbage) ctx.delete(r)
  return garbage.size
}

/**
 * Finish an assembled output document (every page in its page tree): cut each reference to a page
 * OUTSIDE the page tree and to an annotation NO tree page lists, then delete every object the
 * trailer no longer reaches. Returns how many objects were deleted.
 *
 * copyPages follows every reference of a copied page, so a Link's /Dest or GoTo /A, an
 * annotation's /P or /IRT, or a widget's /Parent → /Kids chain to a page the output does not have
 * copies that page whole (its /Contents, fonts and images) as an orphan nobody displays and every
 * raw reader finds: a page deleted from the collection, or the unredacted original of a redacted
 * page reached from another copy of the same file. Cut: a dict entry or array element naming such
 * a page or annotation, a destination array whose page is such a page, and a GoTo action to one.
 * The /Popup of a listed annotation counts as listed.
 *
 * pdf-lib clones a link's target page separately even when that page is copied in the same batch
 * (an internal link of an exported document). Such a clone shows content streams a tree page
 * already shows (every one of its /Contents is in that page's /Contents, which baking may have
 * extended): it is that page's TWIN, and references to it are moved to the tree page instead of
 * cut, so internal links keep working. A clone from other bytes (an unredacted copy) shows other
 * streams, so it has no twin.
 */
export function pruneDetached(doc: PDFDocument): number {
  const ctx = doc.context
  const dictOf = (o: PDFObject | undefined): PDFDict | undefined => {
    const r = o instanceof PDFRef ? ctx.lookup(o) : o
    return r instanceof PDFDict ? r : undefined
  }
  const pages = doc.getPages()
  const tree = new Set<PDFDict>(pages.map((p) => p.node))
  /** The content-stream refs of a page node. */
  const contentRefs = (node: PDFDict): PDFRef[] => {
    const c = node.get(PDFName.of('Contents'))
    const r = c instanceof PDFRef ? ctx.lookup(c) : c
    if (r instanceof PDFArray) return r.asArray().filter((x): x is PDFRef => x instanceof PDFRef)
    return c instanceof PDFRef ? [c] : []
  }
  const treeContents = pages.map((p) => ({ ref: p.ref, refs: new Set(contentRefs(p.node)) }))
  const twins = new Map<PDFDict, PDFRef | null>()
  const twinOf = (d: PDFDict): PDFRef | null => {
    let t = twins.get(d)
    if (t === undefined) {
      const own = contentRefs(d)
      const hit = own.length ? treeContents.find((p) => own.every((r) => p.refs.has(r))) : undefined
      twins.set(d, (t = hit?.ref ?? null))
    }
    return t
  }
  const listed = new Set<PDFDict>()
  for (const page of tree)
    for (const a of (page as PDFPageLeaf).Annots()?.asArray() ?? []) {
      const d = dictOf(a)
      if (!d) continue
      listed.add(d)
      const popup = dictOf(d.get(PDFName.of('Popup')))
      if (popup) listed.add(popup)
    }
  const isAnnot = (d: PDFDict): boolean =>
    !(d instanceof PDFPageLeaf) &&
    d.get(PDFName.of('Rect')) !== undefined &&
    d.get(PDFName.of('Subtype')) instanceof PDFName
  /** A page outside the tree: its twin's ref, or null (none: references to it are cut). */
  const detached = (o: PDFObject | undefined): PDFRef | null | undefined => {
    const d = dictOf(o)
    return d instanceof PDFPageLeaf && !tree.has(d) ? twinOf(d) : undefined
  }
  const deadPage = (o: PDFObject | undefined): boolean => detached(o) === null
  const destTo = (o: PDFObject | undefined): boolean => {
    const r = o instanceof PDFRef ? ctx.lookup(o) : o
    return r instanceof PDFArray && r.size() > 0 && deadPage(r.get(0))
  }
  /** Should a reference to `o` be cut? */
  const cut = (o: PDFObject): boolean => {
    if (destTo(o)) return true
    const d = dictOf(o)
    if (!d) return false
    if (deadPage(d) || (isAnnot(d) && !listed.has(d))) return true
    // A GoTo action whose destination is such a page.
    return d.get(PDFName.of('S')) === PDFName.of('GoTo') && destTo(d.get(PDFName.of('D')))
  }

  const seen = new Set<PDFObject>()
  const stack: PDFObject[] = []
  const visit = (o: PDFObject | undefined): void => {
    if (!o) return
    const r = o instanceof PDFRef ? ctx.lookup(o) : o
    if (!r || seen.has(r)) return
    if (r instanceof PDFDict || r instanceof PDFArray || r instanceof PDFStream) {
      seen.add(r)
      stack.push(r)
    }
  }
  const { Root, Info, Encrypt } = ctx.trailerInfo
  for (const o of [Root, Info, Encrypt]) visit(o)
  while (stack.length) {
    const o = stack.pop()!
    const dict = o instanceof PDFStream ? o.dict : o
    if (dict instanceof PDFDict) {
      for (const [k, v] of dict.entries()) {
        const twin = detached(v)
        if (cut(v)) dict.delete(k)
        else if (twin) dict.set(k, twin)
        else visit(v)
      }
    } else if (dict instanceof PDFArray) {
      for (let i = dict.size() - 1; i >= 0; i--) {
        const v = dict.get(i)
        const twin = detached(v)
        if (cut(v)) dict.remove(i)
        else if (twin) dict.set(i, twin)
        else visit(v)
      }
    }
  }

  // Everything the trailer no longer reaches.
  const roots: PDFRef[] = []
  for (const o of [Root, Info, Encrypt]) forEachRef(o, (r) => roots.push(r))
  const reachable = closure(ctx, roots)
  let deleted = 0
  for (const [ref] of ctx.enumerateIndirectObjects())
    if (!reachable.has(ref)) deleted += ctx.delete(ref) ? 1 : 0
  return deleted
}
