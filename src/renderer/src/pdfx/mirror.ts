// PDFX v1.1 editable mirror: serialize the edit model into the manifest on .pdfx export,
// and reconstruct it on import — so edits survive save → reopen. In-memory overlays/rotations
// are keyed by page key (sourceId#pageIndex), which is regenerated each load; the mirror keys
// by (document index, page-within-document) instead, and we translate on both ends.

import {
  DRAWABLE_TYPES,
  makePageKey,
  newOverlayId,
  type CropBox,
  type Geom,
  type Overlay
} from '../edit/model'
import type { DocEntry } from '../types'
import type { Attachment } from './flatten'
import type { EditLayer } from './build'
import type { ExportDocument, ManifestAttachment, ManifestEdit, PdfxManifest } from './format'

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(s)
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)
  return bytes
}

const attachmentIdOf = (o: Overlay): string | undefined =>
  o.type === 'image' || o.type === 'signatureVisual' ? o.attachmentId : undefined

export interface SerializedMirror {
  edits: ManifestEdit[]
  attachments: Record<string, ManifestAttachment>
}

interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Normalized axis-aligned bounds of a geom, ignoring rotation (tolerates negative w/h). */
const bounds = (g: Geom): Rect => ({
  x0: Math.min(g.x, g.x + g.w),
  y0: Math.min(g.y, g.y + g.h),
  x1: Math.max(g.x, g.x + g.w),
  y1: Math.max(g.y, g.y + g.h)
})

/**
 * The area an overlay's box can occupy, as one axis-aligned rectangle: the union of its unrotated
 * bounds and the AABB of its four corners rotated by `geom.rotation`.
 *
 * flatten.ts passes `rotation` to pdf-lib as `degrees(rotation)`, and pdf-lib rotates about the
 * box's (x, y) origin with the matrix [cos, sin, -sin, cos] — i.e. by +rotation in this y-up user
 * space (verified against pdf-lib's drawImage/drawText operator sequence: translate(x, y) then
 * rotateRadians). It applies that only to the types that take a `rotate` option (image,
 * signatureVisual, text); highlight / ink / shape / formValue / redaction rectangles are drawn
 * unrotated. The union covers both cases at once, so a rotated redaction — only reachable from a
 * hand-edited .pdfx, since the UI never sets one — can neither hide content outside its unrotated
 * box unnoticed nor stop covering the box it actually paints. Fail-safe by construction: the union
 * is never smaller than the old bbox (rotation can only ever drop MORE), and `rotation === 0`
 * reduces to exactly the old bbox, so the normal path is unchanged.
 */
function footprint(g: Geom): Rect {
  const box = bounds(g)
  if (!g.rotation || !Number.isFinite(g.rotation)) return box
  const rad = (g.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const xs = [box.x0, box.x1]
  const ys = [box.y0, box.y1]
  for (const [dx, dy] of [
    [0, 0],
    [g.w, 0],
    [0, g.h],
    [g.w, g.h]
  ]) {
    xs.push(g.x + dx * cos - dy * sin)
    ys.push(g.y + dx * sin + dy * cos)
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

/** Do two overlays' (rotation-aware) footprints overlap at all? */
function bboxesIntersect(a: Geom, b: Geom): boolean {
  const p = footprint(a)
  const q = footprint(b)
  return p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1
}

/**
 * Is `a` painted after `b`? Mirrors flatten's draw order: z ascending, then createdAt ascending.
 * An exact tie (same z AND same createdAt) counts as "after": the two orders are indistinguishable
 * to the sort, so the only safe reading of a tie between a redaction and an overlay is that the
 * redaction wins. Ties are reachable — `z` is handed out as `pageOverlays.length`, which reuses a
 * value after a delete — and a strict `>` there would keep (and thus leak) the covered overlay.
 */
const drawnAbove = (a: Overlay, b: Overlay): boolean =>
  a.z > b.z || (a.z === b.z && a.createdAt >= b.createdAt)

/**
 * Drop every overlay that a redaction on the same page hides, so redacted content can't survive
 * anywhere it stays readable: the PLAINTEXT manifest mirror (serializeMirror) and the flattened
 * content stream (build.ts's bakePage). The destructive PDFium pre-pass only rewrites SOURCE bytes,
 * so a text/ink/image/formValue overlay sitting under a black box would otherwise be written
 * verbatim into pdfx-manifest.json, and baked into the exported page as its own operators — a text
 * overlay's `Tj` survives under the box and comes straight back out of copy-paste or pdftotext.
 *
 * "Hidden" = a redaction that flatten draws AFTER the overlay (higher z, or equal z and equal-or-
 * later createdAt — see drawnAbove / flattenPageOverlays) whose footprint touches the overlay's.
 * Overlays drawn ABOVE a redaction survive: they paint on top of the black box in the exported PDF
 * too, so keeping them is WYSIWYG parity with flatten.ts. PARTIAL overlap drops the whole overlay:
 * the mirror stores an overlay atomically (there is no way to persist "half a text run"), so
 * anything the user covered even in part is treated as secret. Fail-safe by design — it can
 * over-drop, never under-drop.
 *
 * Redaction overlays themselves are dropped by default (the mirror must never carry them: they are
 * applied destructively on export). Pass `keepRedactions` on the flatten path, where the box still
 * has to be painted over the hole the destructive pass left in the source content.
 */
export function stripRedactedOverlays(
  all: Overlay[],
  options?: { keepRedactions?: boolean }
): Overlay[] {
  const keepRedactions = options?.keepRedactions ?? false
  const redactions = all.filter((o) => o.type === 'redaction')
  return all.filter((o) =>
    o.type === 'redaction'
      ? keepRedactions
      : !redactions.some((r) => drawnAbove(r, o) && bboxesIntersect(r.geom, o.geom))
  )
}

/**
 * How many non-redaction overlays stripRedactedOverlays would drop, across every page of the edit
 * layer. Saving or exporting removes those annotations for good (they are the ones a redaction
 * covers), so useExport reports the number in its "Saved …" flash rather than losing a partially
 * covered highlight without a word. It runs the SAME function that does the dropping, so the number
 * can never disagree with what actually happens — a change to the coverage rules moves both at once.
 *
 * `livePageKeys` restricts the count to pages that are still in the collection: overlays are never
 * pruned when a page/document is deleted (so undo can bring them back), but a save only ever visits
 * live pages, so counting a deleted page's overlays would report a removal that did not happen.
 */
export function countRedactedOverlays(
  overlaysByPage: Map<string, Overlay[]>,
  livePageKeys?: ReadonlySet<string>
): number {
  let dropped = 0
  for (const [pageKey, overlays] of overlaysByPage) {
    if (livePageKeys && !livePageKeys.has(pageKey)) continue
    // stripRedactedOverlays also drops the redactions themselves; only the others are "lost".
    const drawable = overlays.filter((o) => o.type !== 'redaction').length
    dropped += drawable - stripRedactedOverlays(overlays).length
  }
  return dropped
}

/** Build the manifest `edits` + `attachments` from the edit layer, or null if there's nothing. */
export function serializeMirror(
  documents: ExportDocument[],
  edits: EditLayer
): SerializedMirror | null {
  const editsArr: ManifestEdit[] = []
  const usedAttachments = new Set<string>()
  let docIndex = 0 // index into the manifest's documents[] (empty docs are skipped on export)

  for (const doc of documents) {
    if (doc.pages.length === 0) continue
    doc.pages.forEach((page, pi) => {
      const key = makePageKey(page.sourceKey, page.pageIndex)
      // Redaction overlays are applied destructively on export (see redact-export.ts), so they are
      // never written to the editable mirror — a reopened .pdfx must not carry the redacted content.
      // Overlays the redaction covers go with them (see stripRedactedOverlays); this runs BEFORE the
      // usedAttachments scan below, so a redacted image's bytes are never embedded either.
      const overlays = stripRedactedOverlays(edits.overlays.get(key) ?? [])
      const rotation = edits.rotations?.get(key) ?? 0
      const crop = edits.crops?.get(key)
      if (overlays.length === 0 && !rotation && !crop) return
      editsArr.push({
        doc: docIndex,
        page: pi,
        ...(rotation ? { rotation } : {}),
        ...(crop ? { crop } : {}),
        ...(overlays.length ? { overlays } : {})
      })
      for (const o of overlays) {
        const id = attachmentIdOf(o)
        if (id) usedAttachments.add(id)
      }
    })
    docIndex++
  }

  if (editsArr.length === 0) return null

  const attachments: Record<string, ManifestAttachment> = {}
  for (const id of usedAttachments) {
    const a = edits.attachments.get(id)
    if (a) attachments[id] = { mime: a.mime, data: toBase64(a.bytes) }
  }
  return { edits: editsArr, attachments }
}

export interface ImportedMirror {
  overlays: Overlay[]
  rotations: Array<[string, number]>
  crops: Array<[string, CropBox]>
  attachments: Array<[string, Attachment]>
}

// The manifest is JSON — its numbers/types are untrusted (the tamper gate deliberately excludes the
// mirror from its hash). Validate before feeding values into pdf-lib, or a crafted/corrupt .pdfx can
// produce an unopenable file (Infinity geometry → literal `Infinity` in the output), fail every
// export (a non-90° rotation trips pdf-lib's assertion), or inject a `redaction` overlay that a later
// re-export silently applies. Reject anything that isn't well-formed.
const DRAWABLE = new Set<string>(DRAWABLE_TYPES)
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

function validGeom(g: unknown): boolean {
  if (!g || typeof g !== 'object') return false
  const o = g as Record<string, unknown>
  return finite(o.x) && finite(o.y) && finite(o.w) && finite(o.h) && finite(o.rotation) && finite(o.opacity) // prettier-ignore
}

function validCrop(c: unknown): c is CropBox {
  if (!c || typeof c !== 'object') return false
  const o = c as Record<string, unknown>
  return finite(o.x) && finite(o.y) && finite(o.w) && finite(o.h) && o.w > 0 && o.h > 0
}

function validColor(c: unknown): boolean {
  if (!c || typeof c !== 'object') return false
  const o = c as Record<string, unknown>
  return finite(o.r) && finite(o.g) && finite(o.b)
}

/** Ink/signature strokes: an array of flat [x0,y0,x1,y1,…] polylines of finite numbers. */
const validPaths = (p: unknown): boolean =>
  Array.isArray(p) && p.every((stroke) => Array.isArray(stroke) && stroke.every(finite))

const FONTS = new Set(['Helvetica', 'Times', 'Courier'])
const ALIGNS = new Set(['left', 'center', 'right'])
const SHAPES = new Set(['rect', 'ellipse', 'line', 'arrow', 'underline', 'strike'])

/**
 * Per-type payload check, the companion to validGeom. Geometry alone isn't enough: an overlay with a
 * well-formed geom but a malformed body (color: null, ink without paths, an image whose attachment
 * failed to decode) imports fine and then throws deep inside pdf-lib on EVERY later export, leaving
 * the document permanently un-exportable. Drop such overlays at import instead, exactly as bad
 * geometry is dropped. `hasAttachment` reports ids that actually decoded above.
 */
function validPayload(o: Record<string, unknown>, hasAttachment: (id: string) => boolean): boolean {
  switch (o.type) {
    case 'highlight':
      return validColor(o.color)
    case 'ink':
      return validColor(o.color) && validPaths(o.paths) && finite(o.strokeWidth)
    case 'text':
      return (
        typeof o.text === 'string' &&
        finite(o.fontSize) &&
        validColor(o.color) &&
        FONTS.has(o.font as string) &&
        ALIGNS.has(o.align as string)
      )
    case 'shape':
      return (
        validColor(o.color) &&
        SHAPES.has(o.shape as string) &&
        finite(o.strokeWidth) &&
        (o.points === undefined || (Array.isArray(o.points) && o.points.every(finite)))
      )
    case 'image':
      return typeof o.attachmentId === 'string' && hasAttachment(o.attachmentId)
    case 'signatureVisual':
      // Either an image attachment or hand-drawn strokes; whichever it carries must be usable.
      return o.attachmentId !== undefined
        ? typeof o.attachmentId === 'string' && hasAttachment(o.attachmentId)
        : validPaths(o.paths)
    case 'formValue':
      return typeof o.field === 'string' && (typeof o.value === 'string' || typeof o.value === 'boolean') // prettier-ignore
    default:
      return false
  }
}

/**
 * Decode the manifest's attachment table, skipping anything malformed. The container, each entry and
 * each base64 payload are untrusted: a non-object table, a missing/non-string `data`, or bytes atob
 * rejects must not throw, or one crafted attachment takes down the whole document load.
 */
function decodeAttachments(manifest: PdfxManifest): Array<[string, Attachment]> {
  const table = manifest.attachments
  if (!table || typeof table !== 'object') return []
  const out: Array<[string, Attachment]> = []
  for (const [id, a] of Object.entries(table)) {
    if (!a || typeof a !== 'object') continue
    const { data, mime } = a as { data?: unknown; mime?: unknown }
    if (typeof data !== 'string' || typeof mime !== 'string') continue
    try {
      out.push([id, { bytes: fromBase64(data), mime }])
    } catch {
      continue // not valid base64 — drop this attachment rather than fail the load
    }
  }
  return out
}

/** Reconstruct overlays/rotations/crops/attachments from a manifest, keyed to the freshly-loaded docs. */
export function deserializeMirror(manifest: PdfxManifest, docs: DocEntry[]): ImportedMirror | null {
  // `edits` is JSON: a truthy non-array (5, true, {length: 2}) passes a bare `.length` check and
  // then explodes in the for..of below, killing the load of an otherwise-readable document.
  if (!Array.isArray(manifest.edits) || manifest.edits.length === 0) return null
  const overlays: Overlay[] = []
  const rotations: Array<[string, number]> = []
  const crops: Array<[string, CropBox]> = []
  // Decoded first: overlays that reference an attachment are only kept if it actually decoded.
  const attachments = decodeAttachments(manifest)
  const decodedIds = new Set(attachments.map(([id]) => id))
  const hasAttachment = (id: string): boolean => decodedIds.has(id)

  for (const edit of manifest.edits) {
    if (!edit || typeof edit !== 'object') continue
    const page = docs[edit.doc]?.pages[edit.page]
    if (!page) continue
    const key = makePageKey(page.source.id, page.pageIndex)
    if (edit.rotation === 90 || edit.rotation === 180 || edit.rotation === 270) {
      rotations.push([key, edit.rotation])
    }
    if (edit.crop && validCrop(edit.crop)) crops.push([key, edit.crop])
    for (const o of Array.isArray(edit.overlays) ? edit.overlays : []) {
      if (!o || typeof o !== 'object') continue
      const raw = o as unknown as Record<string, unknown>
      if (
        !DRAWABLE.has((o as Overlay).type) ||
        !validGeom(raw.geom) ||
        !validPayload(raw, hasAttachment)
      ) {
        continue // drop unknown/redaction types, non-finite geometry and malformed payloads
      }
      overlays.push({ ...o, id: newOverlayId(), pageKey: key })
    }
  }

  return { overlays, rotations, crops, attachments }
}
