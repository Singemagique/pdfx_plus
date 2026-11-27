import { PDFDocument } from 'pdf-lib'

import { jpegOrientation } from './exif'
import { embedPngFaithful } from './png-embed'

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i

export function isImageFile(name: string): boolean {
  return IMAGE_EXT.test(name)
}

export function stripImageExtension(name: string): string {
  return name.replace(IMAGE_EXT, '')
}

function isPng(data: Uint8Array): boolean {
  return data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
}

function isJpeg(data: Uint8Array): boolean {
  return data[0] === 0xff && data[1] === 0xd8
}

export function isImageBytes(data: Uint8Array): boolean {
  return isPng(data) || isJpeg(data)
}

function toBlob(data: Uint8Array): Blob {
  return new Blob([new Uint8Array(data)])
}

// Guard against image decompression bombs: a small, highly-compressed file can
// decode to enormous pixel dimensions and exhaust renderer memory.
const MAX_IMAGE_PIXELS = 100 * 1024 * 1024 // 100 MP cap on a directly-embedded image
const MAX_RASTER_DIM = 8192 // px on the longest edge when re-encoding through a canvas

// The IHDR chunk stores width/height as big-endian uint32s at the start of its data (byte offsets
// 16 and 20 when it is the first chunk, as the spec requires). The chunks are walked up to IEND
// rather than trusting those offsets: a PNG with a second IHDR is malformed, and decoders disagree
// on which one wins (pdf-lib, the embed fallback, takes the last, wherever it is) — so a 1×1 IHDR
// in front of a huge one would slip past the pixel cap. Such a file is rejected outright, before
// any decoder sees it.
function pngSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 24 || !isPng(data)) return null
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let at = 16 // where IHDR's data starts, if it is the first chunk
  let ihdrs = 0
  for (let pos = 8; pos + 8 <= data.length; ) {
    const len = dv.getUint32(pos)
    const type = String.fromCharCode(data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7])
    if (type === 'IHDR') {
      if (++ihdrs > 1) throw new Error('Malformed PNG: more than one IHDR chunk')
      if (pos + 16 <= data.length) at = pos + 8
    } else if (type === 'IEND') break
    pos += 12 + len // length + type + data + CRC
  }
  return { width: dv.getUint32(at), height: dv.getUint32(at + 4) }
}

// JPEG dimensions from the first SOF (start-of-frame) marker, WITHOUT decoding pixels — so a
// decompression-bomb JPEG (e.g. 30000² → ~3.6 GB decoded) is rejected before createImageBitmap runs.
// Exported for tests.
export function jpegSize(data: Uint8Array): { width: number; height: number } | null {
  if (!isJpeg(data)) return null
  let i = 2
  while (i + 9 < data.length) {
    if (data[i] !== 0xff) {
      i++
      continue
    }
    let marker = data[i + 1]
    while (marker === 0xff && i + 2 < data.length) marker = data[++i + 1] // skip fill bytes
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2 // SOI / EOI / RSTn carry no length
      continue
    }
    const len = (data[i + 2] << 8) | data[i + 3]
    // SOF0..SOF15 hold the frame dimensions; skip the non-SOF markers in that range (DHT/DAC/DNL).
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      return { width: (data[i + 7] << 8) | data[i + 8], height: (data[i + 5] << 8) | data[i + 6] }
    }
    if (len <= 0) return null
    i += 2 + len
  }
  return null
}

const oversizePixels = (d: { width: number; height: number }): boolean =>
  d.width * d.height > MAX_IMAGE_PIXELS

/**
 * Whether a JPEG must be re-oriented before it is embedded: true when its EXIF orientation is
 * anything but 1. PDF embedders draw the stored (sensor) frame and ignore EXIF, so a phone photo
 * shot in portrait would otherwise land sideways. Decided from the header bytes alone — comparing
 * createImageBitmap(..., { imageOrientation: 'none' }) against the default can't work: Chromium
 * treats 'none' like 'from-image', and a width comparison misses 180° turns and square images.
 */
export function jpegNeedsReorient(data: Uint8Array): boolean {
  return isJpeg(data) && jpegOrientation(data) !== 1
}

// Pixels per inch assumed for a placed image stamp. Sizing pixels as points (72 DPI) made small
// images blurry when printed; 150 DPI keeps them sharp while still landing at a sensible size.
const STAMP_ASSUMED_DPI = 150

/**
 * The initial size (PDF points) of an image stamp whose upright pixel size is `natural`: the
 * image's size at STAMP_ASSUMED_DPI, capped at `widthFrac` of the page width, aspect preserved.
 */
export function imageStampSize(
  natural: { width: number; height: number },
  pageWidth: number,
  widthFrac = 0.4
): { width: number; height: number } {
  const natW = natural.width > 0 ? natural.width : 1
  const natH = natural.height > 0 ? natural.height : 1
  const width = Math.min(pageWidth * widthFrac, (natW * 72) / STAMP_ASSUMED_DPI)
  return { width, height: (width * natH) / natW }
}

/**
 * Where a new image stamp lands: sized by the VISIBLE width (a cropped page's crop, else the whole
 * page) and centred on that area, so it is never placed in a cropped-away margin. `visible` and the
 * result are in PDF points, bottom-left origin.
 */
export function stampGeom(
  visible: { x: number; y: number; w: number; h: number },
  natural: { width: number; height: number },
  widthFrac = 0.4
): { x: number; y: number; w: number; h: number } {
  const { width, height } = imageStampSize(natural, visible.w, widthFrac)
  return {
    x: visible.x + (visible.w - width) / 2,
    y: visible.y + (visible.h - height) / 2,
    w: width,
    h: height
  }
}

/**
 * Normalise an image picked for an image stamp so the editor overlay and the flattened export agree:
 * returns the bytes/mime to store as the attachment plus the upright pixel size. A JPEG carrying a
 * non-identity EXIF orientation is decoded (which applies the orientation) and re-encoded as PNG —
 * flatten's embedJpg would otherwise draw the raw sideways frame squeezed into the upright box.
 * Everything else passes through untouched. Throws if the image can't be decoded.
 */
export async function prepareImageStamp(
  bytes: Uint8Array,
  mime: 'image/png' | 'image/jpeg'
): Promise<{
  bytes: Uint8Array
  mime: 'image/png' | 'image/jpeg'
  width: number
  height: number
}> {
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }))
  try {
    const { width, height } = bitmap
    if (mime === 'image/jpeg' && jpegNeedsReorient(bytes)) {
      return { bytes: await rasterToPng(bitmap), mime: 'image/png', width, height }
    }
    return { bytes, mime, width, height }
  } finally {
    bitmap.close()
  }
}

async function rasterToPng(bitmap: ImageBitmap): Promise<Uint8Array> {
  const scale = Math.min(1, MAX_RASTER_DIM / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('PNG encoding failed')
  return new Uint8Array(await blob.arrayBuffer())
}

export async function imageToPdf(
  data: Uint8Array,
  pageSize?: { width: number; height: number }
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const tooLarge = new Error('Image is too large to import')
  let image
  if (isPng(data)) {
    const dim = pngSize(data)
    if (dim && oversizePixels(dim)) throw tooLarge
    image = await embedPngFaithful(doc, data)
  } else if (isJpeg(data)) {
    const dim = jpegSize(data)
    if (dim && oversizePixels(dim)) throw tooLarge // reject the bomb before decoding it
    if (jpegNeedsReorient(data)) {
      // createImageBitmap's default ('from-image') applies the EXIF orientation, so re-encoding the
      // decoded bitmap bakes the upright frame into pixels that embedPng can't misread.
      const oriented = await createImageBitmap(toBlob(data))
      try {
        image = await embedPngFaithful(doc, await rasterToPng(oriented))
      } finally {
        oriented.close()
      }
    } else {
      image = await doc.embedJpg(data) // already upright: embed the original bytes losslessly
    }
  } else {
    // WebP/GIF/BMP/AVIF: no cheap header parse here, so cap on the decoded bitmap's dimensions.
    const bitmap = await createImageBitmap(toBlob(data))
    if (oversizePixels(bitmap)) {
      bitmap.close()
      throw tooLarge
    }
    image = await embedPngFaithful(doc, await rasterToPng(bitmap))
    bitmap.close()
  }

  const pageWidth = pageSize?.width ?? image.width
  const pageHeight = pageSize?.height ?? image.height
  const scale = Math.min(pageWidth / image.width, pageHeight / image.height)
  const width = image.width * scale
  const height = image.height * scale

  const page = doc.addPage([pageWidth, pageHeight])
  page.drawImage(image, {
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2,
    width,
    height
  })
  return doc.save()
}
