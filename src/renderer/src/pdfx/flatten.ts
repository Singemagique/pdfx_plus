// Flatten-on-export: bake drawable overlays into a page's content so any PDF viewer
// shows them (PRD §4.4). Geometry is already in PDF points (origin bottom-left), so it
// maps straight onto pdf-lib's draw API.
//
// `redaction` is NOT handled here: it is applied by the external PDFium pre-pass before
// re-assembly (§4.5). `formValue` IS handled — the filled value is painted over its AcroForm
// field rectangle (text, or an X for a checked box); the original interactive widget is left in
// place underneath. flattenPageOverlays skips only redaction.

import {
  PDFDocument,
  PDFFont,
  PDFImage,
  PDFPage,
  StandardFonts,
  degrees,
  rgb,
  type Color
} from 'pdf-lib'

import type { Overlay, RGB, StandardFontName, TextAlign } from '../edit/model'

export interface Attachment {
  bytes: Uint8Array
  mime: string
}

export interface FlattenResources {
  embedImage(attachmentId: string): Promise<PDFImage>
  getFont(name: StandardFontName): Promise<PDFFont>
}

const STD_FONT: Record<StandardFontName, StandardFonts> = {
  Helvetica: StandardFonts.Helvetica,
  Times: StandardFonts.TimesRoman,
  Courier: StandardFonts.Courier
}

const toColor = (c: RGB): Color => rgb(c.r, c.g, c.b)

/** Default highlight alpha when an overlay leaves opacity unset (pdf-lib has no blend mode). */
const HIGHLIGHT_ALPHA = 0.4

/** Resources backed by a single output document and an attachment registry. Caches embeds. */
export function createFlattenResources(
  doc: PDFDocument,
  attachments: Map<string, Attachment>
): FlattenResources {
  const images = new Map<string, Promise<PDFImage>>()
  const fonts = new Map<StandardFontName, Promise<PDFFont>>()
  return {
    embedImage(attachmentId) {
      let p = images.get(attachmentId)
      if (!p) {
        const a = attachments.get(attachmentId)
        if (!a) return Promise.reject(new Error(`missing attachment: ${attachmentId}`))
        p = a.mime === 'image/jpeg' ? doc.embedJpg(a.bytes) : doc.embedPng(a.bytes)
        images.set(attachmentId, p)
      }
      return p
    },
    getFont(name) {
      let p = fonts.get(name)
      if (!p) {
        p = doc.embedFont(STD_FONT[name])
        fonts.set(name, p)
      }
      return p
    }
  }
}

/** Split a flat [x0,y0,x1,y1,…] polyline into consecutive [x0,y0,x1,y1] segments. */
export function polylineSegments(path: number[]): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = []
  for (let i = 0; i + 3 < path.length; i += 2) {
    out.push([path[i], path[i + 1], path[i + 2], path[i + 3]])
  }
  return out
}

/** Left edge for a line of width `textWidth` within a box [x, x+boxW] given alignment. */
export function alignedX(x: number, boxW: number, textWidth: number, align: TextAlign): number {
  if (align === 'center') return x + (boxW - textWidth) / 2
  if (align === 'right') return x + (boxW - textWidth)
  return x
}

function drawInk(
  page: PDFPage,
  paths: number[][],
  width: number,
  color: RGB,
  opacity: number
): void {
  const c = toColor(color)
  for (const path of paths) {
    for (const [x1, y1, x2, y2] of polylineSegments(path)) {
      page.drawLine({
        start: { x: x1, y: y1 },
        end: { x: x2, y: y2 },
        thickness: width,
        color: c,
        opacity
      })
    }
  }
}

async function drawTextOverlay(
  page: PDFPage,
  o: Extract<Overlay, { type: 'text' }>,
  res: FlattenResources
): Promise<void> {
  const font = await res.getFont(o.font)
  const { x, y, w, h } = o.geom
  const color = toColor(o.color)
  const lineHeight = o.fontSize * 1.2
  const lines = o.text.split('\n')
  let lineTop = y + h - o.fontSize // first baseline near the top of the box
  for (const line of lines) {
    if (lineTop < y) break // don't spill text below the box (e.g. a tiny signature appearance)
    const width = font.widthOfTextAtSize(line, o.fontSize)
    page.drawText(line, {
      x: alignedX(x, w, width, o.align),
      y: lineTop,
      size: o.fontSize,
      font,
      color,
      opacity: o.geom.opacity,
      rotate: degrees(o.geom.rotation)
    })
    lineTop -= lineHeight
  }
}

function drawShape(page: PDFPage, o: Extract<Overlay, { type: 'shape' }>): void {
  const { x, y, w, h } = o.geom
  const color = toColor(o.color)
  const thickness = o.strokeWidth
  const opacity = o.geom.opacity
  switch (o.shape) {
    case 'rect':
      page.drawRectangle({
        x,
        y,
        width: w,
        height: h,
        borderColor: color,
        borderWidth: thickness,
        opacity: 0,
        borderOpacity: opacity
      })
      break
    case 'ellipse':
      page.drawEllipse({
        x: x + w / 2,
        y: y + h / 2,
        xScale: w / 2,
        yScale: h / 2,
        borderColor: color,
        borderWidth: thickness,
        opacity: 0,
        borderOpacity: opacity
      })
      break
    case 'underline':
      page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness, color, opacity })
      break
    case 'strike':
      page.drawLine({
        start: { x, y: y + h / 2 },
        end: { x: x + w, y: y + h / 2 },
        thickness,
        color,
        opacity
      })
      break
    case 'line':
    case 'arrow': {
      const [x1, y1, x2, y2] = o.points ?? [x, y + h, x + w, y]
      page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color, opacity })
      if (o.shape === 'arrow') {
        const ang = Math.atan2(y2 - y1, x2 - x1)
        const head = Math.max(8, thickness * 3.5)
        for (const da of [2.5, -2.5]) {
          page.drawLine({
            start: { x: x2, y: y2 },
            end: { x: x2 + head * Math.cos(ang + da), y: y2 + head * Math.sin(ang + da) },
            thickness,
            color,
            opacity
          })
        }
      }
      break
    }
  }
}

/**
 * Paint a filled form value over its field rectangle. Booleans render as an X (a checked box);
 * strings render as left-aligned text vertically centred in the field, auto-sized to its height
 * and wrapped across lines on explicit newlines.
 */
async function drawFormValue(
  page: PDFPage,
  o: Extract<Overlay, { type: 'formValue' }>,
  res: FlattenResources
): Promise<void> {
  const { x, y, w, h } = o.geom
  if (typeof o.value === 'boolean') {
    if (!o.value) return
    const pad = Math.min(w, h) * 0.22
    const t = Math.max(1, Math.min(w, h) * 0.12)
    const c = rgb(0.1, 0.1, 0.12)
    page.drawLine({ start: { x: x + pad, y: y + pad }, end: { x: x + w - pad, y: y + h - pad }, thickness: t, color: c }) // prettier-ignore
    page.drawLine({ start: { x: x + pad, y: y + h - pad }, end: { x: x + w - pad, y: y + pad }, thickness: t, color: c }) // prettier-ignore
    return
  }
  if (!o.value) return
  const font = await res.getFont('Helvetica')
  const lines = String(o.value).split('\n')
  const size = Math.min(12, Math.max(6, (h / Math.max(lines.length, 1)) * 0.7))
  const lineHeight = size * 1.18
  const color = rgb(0.1, 0.1, 0.12)
  // Top baseline so the block sits centred-ish in the field; clamp into the box.
  let baseline = y + h - (h - lines.length * lineHeight) / 2 - size
  for (const line of lines) {
    page.drawText(line, { x: x + 2, y: Math.max(y + 2, baseline), size, font, color })
    baseline -= lineHeight
  }
}

/** Bake every drawable overlay for one page, in z-order. Overlays must be pre-sorted. */
export async function flattenPageOverlays(
  page: PDFPage,
  overlays: Overlay[],
  res: FlattenResources
): Promise<void> {
  for (const o of overlays) {
    const { x, y, w, h, rotation, opacity } = o.geom
    switch (o.type) {
      case 'image': {
        const img = await res.embedImage(o.attachmentId)
        page.drawImage(img, { x, y, width: w, height: h, opacity, rotate: degrees(rotation) })
        break
      }
      case 'highlight':
        page.drawRectangle({
          x,
          y,
          width: w,
          height: h,
          color: toColor(o.color),
          opacity: opacity || HIGHLIGHT_ALPHA
        })
        break
      case 'ink':
        drawInk(page, o.paths, o.strokeWidth, o.color, opacity)
        break
      case 'shape':
        drawShape(page, o)
        break
      case 'text':
        await drawTextOverlay(page, o, res)
        break
      case 'signatureVisual':
        if (o.attachmentId) {
          const img = await res.embedImage(o.attachmentId)
          page.drawImage(img, { x, y, width: w, height: h, opacity, rotate: degrees(rotation) })
        } else if (o.paths) {
          drawInk(page, o.paths, 1.5, { r: 0, g: 0, b: 0 }, opacity || 1)
        }
        break
      case 'formValue':
        await drawFormValue(page, o, res)
        break
      case 'redaction':
        // Applied by the external PDFium pre-pass, not the draw pass (see file header).
        break
    }
  }
}
