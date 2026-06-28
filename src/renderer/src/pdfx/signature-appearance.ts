// Synthesize a VISIBLE signature appearance at a chosen placement and splice it into a copy of the
// EditLayer used for flatten-on-sign. The appearance is ordinary page content (a bordered box with
// an optional drawn-signature image + signer metadata), so the cryptographic signature — applied to
// the flattened bytes afterwards — covers it. We reuse the existing 'shape'/'image'/'text' overlay
// types, so the flatten pipeline (build.ts → flattenPageOverlays) handles rotation/crop for free.
import type { EditLayer } from './build'
import { newOverlayId, type Geom, type Overlay, type SignaturePlacement } from '../edit/model'

export interface AppearanceOptions {
  name?: string
  reason?: string
  date: Date
  /** PNG bytes of the user's drawn signature, drawn in the appearance when provided. */
  image?: Uint8Array | null
  /** The signing certificate's identity — drives the standard "digitally signed by …" block. */
  signer?: { subject: string; issuer: string }
}

const pad2 = (n: number): string => String(n).padStart(2, '0')
function formatDate(d: Date): string {
  // PDF/Adobe-style timestamp, e.g. 2026.06.28 14:30:15.
  return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** Common Name out of an X.500 distinguished name, falling back to the whole string. */
const commonName = (dn: string): string => /CN=([^,]+)/i.exec(dn)?.[1].trim() ?? dn.trim()
/** The DoD EDIPI (10-digit ID) trailing a CAC CN like LAST.FIRST.MIDDLE.1234567890. */
const dodId = (cn: string): string | undefined => /(\d{9,16})\s*$/.exec(cn)?.[1]

/** The lines of the appearance text. With a signing cert this is the standard identity block (name,
 *  DoD ID, issuer, timestamp); otherwise a generic "Digitally signed" block. */
function appearanceLines(opts: AppearanceOptions): string[] {
  const reason = opts.reason?.trim()
  if (opts.signer?.subject) {
    const cn = commonName(opts.signer.subject)
    const id = dodId(cn)
    const issuer = commonName(opts.signer.issuer)
    return [
      `Digitally signed by ${cn}`,
      ...(id ? [`DoD ID: ${id}`] : []),
      ...(issuer ? [`Issuer: ${issuer}`] : []),
      `Date: ${formatDate(opts.date)}`,
      ...(reason ? [`Reason: ${reason}`] : [])
    ]
  }
  return [
    ...(opts.name?.trim() ? [opts.name.trim()] : []),
    'Digitally signed',
    `Date: ${formatDate(opts.date)}`,
    ...(reason ? [`Reason: ${reason}`] : [])
  ]
}

// Width/height ratio of a PNG, for fitting the image without distortion (falls back to a wide box).
async function imageAspect(bytes: Uint8Array): Promise<number> {
  try {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
    const a = bmp.width / Math.max(1, bmp.height)
    bmp.close()
    return a > 0 ? a : 2.5
  } catch {
    return 2.5
  }
}

/**
 * Return a clone of `base` with the visible signature appearance added at `placement`. The original
 * EditLayer is untouched (the appearance is sign-time only, never persisted to the editor/undo).
 */
export async function withSignatureAppearance(
  base: EditLayer,
  placement: SignaturePlacement,
  opts: AppearanceOptions
): Promise<EditLayer> {
  const { pageKey, geom } = placement
  const extra: Overlay[] = []
  const attachments = new Map(base.attachments)
  const z0 = 1_000_000 // draw on top of everything else on the page
  let createdAt = Date.now()
  const fullGeom = (g: { x: number; y: number; w: number; h: number }): Geom => ({
    ...g,
    rotation: 0,
    opacity: 1
  })

  const pad = Math.max(2, Math.min(geom.w, geom.h) * 0.06)
  const innerX = geom.x + pad
  const innerW = Math.max(1, geom.w - 2 * pad)
  const innerH = Math.max(1, geom.h - 2 * pad)

  // A near-opaque light fill so the dark text/border stay legible even over a dark page region
  // (a 'highlight' overlay flattens to a filled rectangle). Drawn first, under everything.
  extra.push({
    id: newOverlayId(),
    pageKey,
    z: z0,
    createdAt: createdAt++,
    geom: { ...geom, rotation: 0, opacity: 0.82 },
    type: 'highlight',
    color: { r: 1, g: 1, b: 1 }
  })

  // A thin border so the appearance reads as an intentional signature stamp.
  extra.push({
    id: newOverlayId(),
    pageKey,
    z: z0 + 1,
    createdAt: createdAt++,
    geom: fullGeom(geom),
    type: 'shape',
    shape: 'rect',
    color: { r: 0.45, g: 0.45, b: 0.5 },
    strokeWidth: 0.75
  })

  // The drawn signature image occupies the top portion; metadata text the bottom.
  const hasImage = !!(opts.image && opts.image.length)
  const textBoxH = hasImage ? innerH * 0.45 : innerH
  if (hasImage) {
    const aspect = await imageAspect(opts.image!)
    const areaH = innerH - textBoxH
    let iw = innerW
    let ih = iw / aspect
    if (ih > areaH) {
      ih = areaH
      iw = ih * aspect
    }
    const ix = innerX + (innerW - iw) / 2
    const areaBottom = geom.y + pad + textBoxH
    const iy = areaBottom + (areaH - ih) / 2
    const attId = newOverlayId()
    attachments.set(attId, { bytes: opts.image!, mime: 'image/png' })
    extra.push({
      id: newOverlayId(),
      pageKey,
      z: z0 + 2,
      createdAt: createdAt++,
      geom: fullGeom({ x: ix, y: iy, w: iw, h: ih }),
      type: 'image',
      attachmentId: attId,
      mime: 'image/png'
    })
  }

  // Metadata text, auto-sized to fit the text box (drawTextOverlay lays lines from the box top down).
  const lines = appearanceLines(opts)
  const maxLen = Math.max(...lines.map((l) => l.length), 1)
  const sizeByHeight = textBoxH / lines.length / 1.25
  const sizeByWidth = innerW / (maxLen * 0.52)
  // Floor at 3.5pt (tiny but legible) so more lines fit before drawTextOverlay clips any overflow.
  const fontSize = Math.max(3.5, Math.min(10, sizeByHeight, sizeByWidth))
  extra.push({
    id: newOverlayId(),
    pageKey,
    z: z0 + 3,
    createdAt: createdAt++,
    geom: fullGeom({ x: innerX, y: geom.y + pad, w: innerW, h: textBoxH }),
    type: 'text',
    text: lines.join('\n'),
    fontSize,
    color: { r: 0.1, g: 0.1, b: 0.13 },
    font: 'Helvetica',
    align: 'left'
  })

  const overlays = new Map(base.overlays)
  overlays.set(pageKey, [...(overlays.get(pageKey) ?? []), ...extra])
  return { ...base, overlays, attachments }
}
