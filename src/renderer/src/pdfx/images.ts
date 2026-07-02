import { PDFDocument } from 'pdf-lib'

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

// PNG IHDR stores width/height as big-endian uint32 at byte offsets 16 and 20.
function pngSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 24 || !isPng(data)) return null
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return { width: dv.getUint32(16), height: dv.getUint32(20) }
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
    image = await doc.embedPng(data)
  } else if (isJpeg(data)) {
    const dim = jpegSize(data)
    if (dim && oversizePixels(dim)) throw tooLarge // reject the bomb before decoding it
    const oriented = await createImageBitmap(toBlob(data))
    const raw = await createImageBitmap(toBlob(data), { imageOrientation: 'none' })
    const rotated = oriented.width !== raw.width
    raw.close()
    image = rotated ? await doc.embedPng(await rasterToPng(oriented)) : await doc.embedJpg(data)
    oriented.close()
  } else {
    // WebP/GIF/BMP/AVIF: no cheap header parse here, so cap on the decoded bitmap's dimensions.
    const bitmap = await createImageBitmap(toBlob(data))
    if (oversizePixels(bitmap)) {
      bitmap.close()
      throw tooLarge
    }
    image = await doc.embedPng(await rasterToPng(bitmap))
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
