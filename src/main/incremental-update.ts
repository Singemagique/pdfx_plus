// Shared machinery for writing a strict APPEND-ONLY incremental update to an existing PDF. Both the
// DSS writer (dss.ts) and the document-timestamp placeholder (doc-timestamp.ts) append new objects +
// a cross-reference table + a trailer chained via /Prev, leaving every existing byte — and therefore
// every existing signature's /ByteRange digest — untouched. The scan helpers here (lastStartxref,
// maxDeclaredSize) are hardening-sensitive: keeping ONE copy means a fix lands for both writers.
// Runs in the MAIN process.

/** Encode a PDF syntax string as bytes (PDF tokens are latin1, never UTF-8). */
export const latin1 = (s: string): Buffer => Buffer.from(s, 'latin1')

/**
 * Byte offset of the most recent cross-reference section (the value after the final `startxref`).
 * Becomes the new section's /Prev so the xref chain stays intact. Anchored at the last %%EOF so
 * trailing junk after it can't redirect /Prev to a bogus offset. Throws if the file has no usable
 * `startxref` (it isn't incrementally updatable); `label` prefixes the message so the caller's
 * feature name ("DSS", "DocTimeStamp") reaches the user.
 */
export function lastStartxref(pdf: Uint8Array, label = 'PDF'): number {
  const s = Buffer.from(pdf).toString('latin1')
  const eof = s.lastIndexOf('%%EOF')
  const i = s.lastIndexOf('startxref', eof === -1 ? s.length : eof)
  if (i === -1) throw new Error(`${label}: no startxref (not an incrementally-updatable PDF)`)
  const m = /startxref\s+(\d+)/.exec(s.slice(i))
  if (!m) throw new Error(`${label}: malformed startxref`)
  return parseInt(m[1], 10)
}

/**
 * Largest /Size declared by the file's trailers / xref-stream dicts. The true next-free object
 * number is >= this, so allocating new objects below it could collide with a free/reserved slot and
 * a smaller /Size would shrink the table. Only /Size adjacent to a `trailer` keyword or an
 * `/Type /XRef` dict counts — never a stray "/Size N" inside a content stream or string, which could
 * otherwise inflate the allocated numbers. Over-estimating from a legitimate trailer is harmless.
 */
export function maxDeclaredSize(pdf: Uint8Array): number {
  const s = Buffer.from(pdf).toString('latin1')
  let max = 0
  const anchors = [...s.matchAll(/\btrailer\b/g), ...s.matchAll(/\/Type\s*\/XRef\b/g)].map(
    (m) => m.index ?? 0
  )
  for (const a of anchors) {
    const m = /\/Size\s+(\d+)/.exec(s.slice(Math.max(0, a - 300), a + 600))
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return max
}

/** One appended indirect object: its number and its complete `N 0 obj … endobj\n` serialization. */
export interface AppendedObject {
  num: number
  buf: Buffer
}

/**
 * Append `objects` to `pdf` as an incremental update: the original bytes verbatim, then the new
 * objects, then a cross-reference table covering exactly them, then a trailer whose /Prev chains to
 * the file's previous xref section. /Size is the highest appended object number + 1 (every writer
 * here allocates its new objects above the file's declared /Size, so that also stays >= the old
 * /Size). A newline separates the prior %%EOF (which @signpdf writes with no trailing EOL) from the
 * first appended object, so a sequential lexer can't fold "%%EOF" + "N 0 obj" into one comment line.
 */
export function appendIncrementalUpdate(
  pdf: Uint8Array,
  objects: AppendedObject[],
  trailer: { rootNum: number; infoNum?: number; label?: string }
): Buffer {
  const prev = lastStartxref(pdf, trailer.label)

  // Lay out the appended objects, recording each one's absolute byte offset from the file start.
  const offsets = new Map<number, number>()
  const body: Buffer[] = []
  let cursor = pdf.length + 1
  for (const o of objects) {
    offsets.set(o.num, cursor)
    body.push(o.buf)
    cursor += o.buf.length
  }
  const xrefOffset = cursor

  // Cross-reference table: ascending subsections, grouping consecutive object numbers.
  const row = (off: number): string => `${`${off}`.padStart(10, '0')} 00000 n \n`
  const nums = [...offsets.keys()].sort((a, b) => a - b)
  let xref = 'xref\n'
  for (let i = 0; i < nums.length; ) {
    let j = i
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++
    xref += `${nums[i]} ${j - i + 1}\n`
    for (let k = i; k <= j; k++) xref += row(offsets.get(nums[k]) as number)
    i = j + 1
  }

  const trailerBuf =
    'trailer\n<<\n' +
    `/Size ${nums[nums.length - 1] + 1}\n` +
    `/Root ${trailer.rootNum} 0 R\n` +
    (trailer.infoNum !== undefined ? `/Info ${trailer.infoNum} 0 R\n` : '') +
    `/Prev ${prev}\n>>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`

  return Buffer.concat([Buffer.from(pdf), latin1('\n'), ...body, latin1(xref), latin1(trailerBuf)])
}
