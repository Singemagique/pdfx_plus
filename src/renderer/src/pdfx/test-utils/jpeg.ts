// Hand-built JPEG byte fixtures for the EXIF/orientation tests. Nothing here is decodable image data:
// the parsers under test only read headers (segment markers, SOF dimensions, the EXIF IFD).

/** SOI, then the given segments, then an SOF0 frame header for `size`, then EOI. */
export function jpegWith(
  segments: number[][],
  size: { width: number; height: number } = { width: 200, height: 100 }
): Uint8Array {
  const { width: w, height: h } = size
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01] // prettier-ignore
  return new Uint8Array([0xff, 0xd8, ...segments.flat(), ...sof, 0xff, 0xd9])
}

/**
 * An APP1 'Exif\0\0' segment whose IFD0 holds an Orientation (0x0112, SHORT) entry, optionally after
 * `leadingEntries` unrelated SHORT entries (tags 0x0100.., e.g. ImageWidth) so the scan must walk.
 */
export function exifApp1(
  orientation: number,
  opts: { little: boolean; leadingEntries?: number }
): number[] {
  const { little, leadingEntries = 0 } = opts
  const u16 = (v: number): number[] => (little ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff])
  const u32 = (v: number): number[] =>
    little
      ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24]
      : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
  const entry = (tag: number, value: number): number[] => [
    ...u16(tag),
    ...u16(3), // SHORT
    ...u32(1), // count
    ...u16(value),
    0,
    0 // value field padding
  ]
  const entries: number[] = []
  for (let n = 0; n < leadingEntries; n++) entries.push(...entry(0x0100 + n, 640))
  entries.push(...entry(0x0112, orientation))
  const count = leadingEntries + 1
  const tiff = [
    ...(little ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(42),
    ...u32(8), // IFD0 immediately after the 8-byte header
    ...u16(count),
    ...entries,
    ...u32(0) // no next IFD
  ]
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff] // 'Exif\0\0'
  const len = payload.length + 2
  return [0xff, 0xe1, len >> 8, len & 0xff, ...payload]
}
