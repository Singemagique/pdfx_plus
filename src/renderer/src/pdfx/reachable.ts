// Deleting what an edit unlinked from a pdf-lib document. pdf-lib 1.17.1's save() writes EVERY
// object registered in the context, reachable or not, so unlinking a content stream or a font
// from a page does not take it out of the file: a raw-bytes reader still finds it. (DESIGN.md
// §3.7.3 rule 6's oracle inflates every stream of the saved file.)

import {
  PDFArray,
  PDFDict,
  PDFPageLeaf,
  PDFRef,
  PDFStream,
  type PDFContext,
  type PDFObject
} from 'pdf-lib'

/** Call `fn` for every ref `obj` holds directly (through its direct dicts, arrays and stream dict). */
function forEachRef(obj: PDFObject | undefined, fn: (ref: PDFRef) => void): void {
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
