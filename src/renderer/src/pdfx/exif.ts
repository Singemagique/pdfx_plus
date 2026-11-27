// Minimal EXIF reader: just enough to recover a JPEG's orientation tag (0x0112) without decoding
// any pixels. Phone cameras store the sensor's native (usually landscape) frame and record how to
// turn it upright here; PDF embedders (pdf-lib's embedJpg) ignore it, so a portrait photo comes out
// sideways unless the caller re-orients it first.
//
// Every read is bounds-checked against both the segment and the buffer: malformed or hostile input
// yields 1 ("upright, no transform") and never throws.

export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

const ORIENTATION_TAG = 0x0112
const MAX_SEGMENTS = 64 // EXIF lives in an APPn segment near the start; real files have a handful
const MAX_IFD_ENTRIES = 512 // IFD0 has a few dozen entries in practice

function isJpeg(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0xff && data[1] === 0xd8
}

/** The EXIF orientation of a JPEG, 1..8; 1 (upright) when absent, invalid or not a JPEG. */
export function jpegOrientation(data: Uint8Array): ExifOrientation {
  if (!isJpeg(data)) return 1
  let i = 2
  for (let seg = 0; seg < MAX_SEGMENTS && i + 4 <= data.length; seg++) {
    if (data[i] !== 0xff) return 1 // lost marker sync: give up rather than guess
    let marker = data[i + 1]
    while (marker === 0xff && i + 2 < data.length) marker = data[++i + 1] // skip fill bytes
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2 // SOI / RSTn / TEM carry no length
      continue
    }
    // SOS starts entropy-coded data and EOI ends the file: no metadata segments follow either.
    if (marker === 0xda || marker === 0xd9) return 1
    if (i + 4 > data.length) return 1
    const len = (data[i + 2] << 8) | data[i + 3] // includes the two length bytes themselves
    if (len < 2) return 1
    const start = i + 4
    const end = Math.min(i + 2 + len, data.length)
    if (marker === 0xe1) {
      const o = exifSegmentOrientation(data, start, end)
      if (o !== null) return o
    }
    i += 2 + len
  }
  return 1
}

// 'Exif\0\0' — the APP1 identifier that precedes the TIFF header (XMP also uses APP1).
const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]

// Orientation from one APP1 payload [start, end): null if it isn't an EXIF segment at all (so the
// scan continues to the next APP1), otherwise the orientation it records (1 when unreadable).
function exifSegmentOrientation(
  data: Uint8Array,
  start: number,
  end: number
): ExifOrientation | null {
  if (end - start < EXIF_ID.length) return null
  for (let k = 0; k < EXIF_ID.length; k++) if (data[start + k] !== EXIF_ID[k]) return null

  const tiff = start + EXIF_ID.length // TIFF offsets are relative to this byte
  const size = end - tiff
  if (size < 8) return 1
  // Byte-order mark: 'II' (Intel, little-endian) or 'MM' (Motorola, big-endian).
  const bom = (data[tiff] << 8) | data[tiff + 1]
  if (bom !== 0x4949 && bom !== 0x4d4d) return 1
  const little = bom === 0x4949
  const dv = new DataView(data.buffer, data.byteOffset + tiff, size)
  if (dv.getUint16(2, little) !== 42) return 1

  const ifd0 = dv.getUint32(4, little)
  if (ifd0 < 8 || ifd0 + 2 > size) return 1
  const count = Math.min(dv.getUint16(ifd0, little), MAX_IFD_ENTRIES)
  for (let n = 0; n < count; n++) {
    const entry = ifd0 + 2 + n * 12
    if (entry + 12 > size) return 1
    if (dv.getUint16(entry, little) !== ORIENTATION_TAG) continue
    // SHORT (type 3), count 1: the value sits left-justified in the 4-byte value field.
    if (dv.getUint16(entry + 2, little) !== 3) return 1
    const value = dv.getUint16(entry + 8, little)
    return value >= 1 && value <= 8 ? (value as ExifOrientation) : 1
  }
  return 1
}
