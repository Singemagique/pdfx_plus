// The typed edit / overlay model (PRD §4.1).
//
// Overlays are page-relative annotations that are (a) rendered live over the page
// in the editor, (b) flattened into the PDF on export so any viewer sees them, and
// (c) mirrored in the PDFX v1.1 manifest for round-trip re-editing.
//
// Geometry is in PDF user-space points with the origin at the bottom-left, matching
// pdf-lib's drawing API, so the flatten pipeline (./. ./pdfx/flatten.ts) can consume
// `geom` directly without a coordinate flip. The renderer converts to/from CSS pixels
// at the view layer.

export interface RGB {
  r: number
  g: number
  b: number
}

export interface Geom {
  x: number
  y: number
  w: number
  h: number
  /** Clockwise rotation in degrees, about the box's lower-left corner. */
  rotation: number
  /** 0..1. */
  opacity: number
}

export type StandardFontName = 'Helvetica' | 'Times' | 'Courier'
export type TextAlign = 'left' | 'center' | 'right'
export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow' | 'underline' | 'strike'

interface BaseOverlay {
  id: string
  /** Stable key of the page this overlay belongs to — see makePageKey. */
  pageKey: string
  /** Stacking order within a page; higher draws later (on top). */
  z: number
  createdAt: number
  geom: Geom
}

export type Overlay =
  | (BaseOverlay & { type: 'image'; attachmentId: string; mime: 'image/png' | 'image/jpeg' })
  | (BaseOverlay & {
      type: 'ink'
      /** One entry per stroke: a flat [x0,y0,x1,y1,…] polyline in page points. */
      paths: number[][]
      strokeWidth: number
      color: RGB
      /** Marks this ink as a hand-drawn signature (a visual-signature variant). */
      signature?: boolean
    })
  | (BaseOverlay & {
      type: 'text'
      text: string
      fontSize: number
      color: RGB
      font: StandardFontName
      align: TextAlign
    })
  | (BaseOverlay & { type: 'highlight'; color: RGB })
  | (BaseOverlay & {
      type: 'shape'
      shape: ShapeKind
      color: RGB
      strokeWidth: number
      /** Endpoints [x1,y1,x2,y2] in page points for `line`/`arrow`; absent otherwise. */
      points?: number[]
    })
  | (BaseOverlay & { type: 'redaction'; fill: RGB })
  | (BaseOverlay & { type: 'formValue'; field: string; value: string | boolean })
  | (BaseOverlay & {
      type: 'signatureVisual'
      attachmentId?: string
      paths?: number[][]
      label?: string
    })

export type OverlayType = Overlay['type']

/** Overlay types that ./pdfx/flatten.ts bakes by drawing onto the page. */
export const DRAWABLE_TYPES = [
  'image',
  'ink',
  'text',
  'highlight',
  'shape',
  'signatureVisual'
] as const

/**
 * Overlay types NOT drawn by the pdf-lib flatten pass:
 *  - `redaction` is applied by the external PDFium pre-pass (PRD §4.5) before re-assembly.
 *  - `formValue` is applied through pdf-lib's AcroForm API + form.flatten().
 */
export const NON_DRAWN_TYPES = ['redaction', 'formValue'] as const

export const isDrawable = (o: Overlay): boolean =>
  (DRAWABLE_TYPES as readonly string[]).includes(o.type)

/**
 * A page's stable identity for binding overlays. Pages key on the export source
 * (`sourceKey`) plus the source `pageIndex`, which is what the export pipeline already
 * uses (src/renderer/src/pdfx/build.ts). NOTE: a duplicated page initially shares this
 * key with its origin; remapDuplicatedPage() gives the copy an independent key so edits
 * to one do not leak into the other (PRD §4.1).
 */
export const makePageKey = (sourceKey: string, pageIndex: number): string =>
  `${sourceKey}#${pageIndex}`

export const parsePageKey = (pageKey: string): { sourceKey: string; pageIndex: number } => {
  const at = pageKey.lastIndexOf('#')
  return { sourceKey: pageKey.slice(0, at), pageIndex: Number(pageKey.slice(at + 1)) }
}

let counter = 0
/** Monotonic id; uses crypto.randomUUID when available, with a deterministic fallback. */
export function newOverlayId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  counter += 1
  return `ov-${counter}`
}

/** Overlays for a page, sorted by z then creation time (stable draw order). */
export function overlaysForPage(overlays: Overlay[], pageKey: string): Overlay[] {
  return overlays
    .filter((o) => o.pageKey === pageKey)
    .sort((a, b) => a.z - b.z || a.createdAt - b.createdAt)
}

/** Index overlays by page key, each list pre-sorted in draw order. */
export function groupByPage(overlays: Overlay[]): Map<string, Overlay[]> {
  const out = new Map<string, Overlay[]>()
  for (const o of overlays) {
    const list = out.get(o.pageKey)
    if (list) list.push(o)
    else out.set(o.pageKey, [o])
  }
  for (const list of out.values()) list.sort((a, b) => a.z - b.z || a.createdAt - b.createdAt)
  return out
}

/**
 * Copy every overlay bound to `fromKey` onto `toKey` with fresh ids, returning the new
 * overlays only. Used when a page is duplicated so the copy gets independent edits.
 */
export function remapDuplicatedPage(
  overlays: Overlay[],
  fromKey: string,
  toKey: string
): Overlay[] {
  return overlays
    .filter((o) => o.pageKey === fromKey)
    .map((o) => ({ ...o, id: newOverlayId(), pageKey: toKey }))
}
