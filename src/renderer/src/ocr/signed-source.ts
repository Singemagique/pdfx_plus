// Does a source carry a digital signature? (DESIGN.md §3.7.7 "Signed sources": the OCR dialog and
// the export confirm say that exporting makes a new file in which the source's signature is not
// valid.) A cheap byte scan for a signature dictionary's `/ByteRange`: signature dictionaries are
// written uncompressed (their /ByteRange and /Contents are patched in place after hashing), so a
// signed PDF shows the key in plain bytes. A false positive only shows a neutral note.

const NEEDLE = new TextEncoder().encode('/ByteRange')
const cache = new WeakMap<Uint8Array, boolean>()

export function isSignedSource(bytes: Uint8Array | undefined): boolean {
  // ArrayBuffer.isView, not instanceof: bytes can come from another realm (a structured clone).
  if (!bytes || !ArrayBuffer.isView(bytes) || bytes.byteLength < NEEDLE.length) return false
  const known = cache.get(bytes)
  if (known !== undefined) return known
  let found = false
  const first = NEEDLE[0]
  for (let i = bytes.indexOf(first); i >= 0; i = bytes.indexOf(first, i + 1)) {
    let j = 1
    while (j < NEEDLE.length && bytes[i + j] === NEEDLE[j]) j++
    if (j === NEEDLE.length) {
      found = true
      break
    }
  }
  cache.set(bytes, found)
  return found
}

export const SIGNED_SOURCE_NOTE =
  'Exporting creates a new file; the source’s digital signature won’t be valid in it. You can sign the new copy with Sign.'
