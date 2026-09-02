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

/** A page crop rectangle in PDF points (origin bottom-left), applied via /CropBox on export. */
export interface CropBox {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Where a (cryptographic) signature's visible appearance is placed. `geom` is in the same
 * 'visual' overlay space as Overlay.geom, so it flattens through the normal pipeline. Set either
 * by drawing a box or by clicking a detected AcroForm signature field (then `fieldName` is its
 * name and `label` a human-readable location). At most one placement exists at a time.
 */
export interface SignaturePlacement {
  pageKey: string
  geom: Geom
  fieldName?: string
  label: string
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
  | (BaseOverlay & {
      type: 'formValue'
      field: string
      value: string | boolean
      /** Render hint: 'radio' fills a dot at `geom` (the chosen option). Absent → text/checkbox. */
      control?: 'radio'
    })
  | (BaseOverlay & {
      type: 'signatureVisual'
      attachmentId?: string
      paths?: number[][]
      label?: string
    })

export type OverlayType = Overlay['type']

/**
 * Overlay types that ./pdfx/flatten.ts bakes by drawing onto the page. Everything else is
 * handled elsewhere: `redaction` is applied by the external PDFium pre-pass (PRD §4.5) before
 * re-assembly, never drawn.
 *
 * `formValue` IS drawn — the filled value is painted over its AcroForm field rectangle on
 * flatten (the underlying interactive widget is left untouched), and the value round-trips
 * through the PDFX mirror so the field stays editable on reopen.
 */
export const DRAWABLE_TYPES = [
  'image',
  'ink',
  'text',
  'highlight',
  'shape',
  'signatureVisual',
  'formValue'
] as const

/**
 * A page's stable identity for binding overlays. Pages key on the export source
 * (`sourceKey`) plus the source `pageIndex`, which is what the export pipeline already
 * uses (src/renderer/src/pdfx/build.ts). Keys never collide across pages: duplicating a
 * page mints a fresh source id (freshPageCopy in ../app/doc-ops/pages.ts), so the copy is
 * independently addressable from the moment it exists (PRD §4.1).
 */
export const makePageKey = (sourceKey: string, pageIndex: number): string =>
  `${sourceKey}#${pageIndex}`

/** An overlay colour → a CSS `rgb()` string, for the editor's live preview chrome. */
export const cssColor = (c: RGB): string =>
  `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`

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

/**
 * The `z` to give the next overlay drawn or stamped onto a page — the single definition of the
 * stacking rule for those sites (new content goes on top of what's already on that page). The
 * three that must go through it, so the rule can't drift between the overlay layer and the tool
 * palette, are OverlayLayer's pointer-drag commit and its image drop, and EditTools' stamp.
 *
 * NOT used by setFormValueInHistory (../edit-history.ts), which has always assigned the GLOBAL
 * overlay count (`d.overlays.length`) instead. Filled form values are page-anchored to their
 * AcroForm widget rect and don't overlap other content, so the difference has no visible effect;
 * switching it to this per-page count would renumber form overlays and is a behavior change
 * outside the scope of the cleanup that introduced this helper.
 */
export const nextZ = (overlays: Overlay[], pageKey: string): number =>
  overlaysForPage(overlays, pageKey).length

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
