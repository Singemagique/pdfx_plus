// Append-only DSS (Document Security Store) writer for PAdES B-LT/LTV. Adds the signer's certificate
// chain + OCSP responses + CRLs to an ALREADY-SIGNED PDF as a strict INCREMENTAL UPDATE: every
// existing byte is preserved, so every existing signature's /ByteRange digest stays valid. pdf-lib's
// save() rewrites the whole file (which would invalidate prior signatures), so we read the structure
// with pdf-lib but hand-write the appended section — new objects + a cross-reference table + a
// trailer chained via /Prev. Runs in the MAIN process. (Per-signature /VRI is a follow-up; Adobe
// recognizes LTV from the document-level /DSS arrays.)
import { PDFDocument, PDFRef, PDFName, PDFDict, PDFArray } from 'pdf-lib'

export interface DssMaterial {
  /** DER certificates: the signer leaf + its chain. */
  certs?: Uint8Array[]
  /** DER OCSP responses (OCSPResponse). */
  ocsps?: Uint8Array[]
  /** DER CRLs. */
  crls?: Uint8Array[]
}

const latin1 = (s: string): Buffer => Buffer.from(s, 'latin1')

// Byte offset of the most recent cross-reference section (the value after the final `startxref`).
// Becomes the new section's /Prev so the xref chain stays intact. Anchored at the last %%EOF so
// trailing junk after it can't redirect /Prev to a bogus offset.
function lastStartxref(pdf: Uint8Array): number {
  const s = Buffer.from(pdf).toString('latin1')
  const eof = s.lastIndexOf('%%EOF')
  const i = s.lastIndexOf('startxref', eof === -1 ? s.length : eof)
  if (i === -1) throw new Error('DSS: no startxref (not an incrementally-updatable PDF)')
  const m = /startxref\s+(\d+)/.exec(s.slice(i))
  if (!m) throw new Error('DSS: malformed startxref')
  return parseInt(m[1], 10)
}

// Largest /Size declared by the file's trailers / xref-stream dicts. The true next-free object
// number is >= this, so allocating new objects below it could collide with a free/reserved slot and
// a smaller /Size would shrink the table. Only /Size adjacent to a `trailer` keyword or an
// `/Type /XRef` dict counts — never a stray "/Size N" inside a content stream or string, which could
// otherwise inflate the allocated numbers. Over-estimating from a legitimate trailer is harmless.
function maxDeclaredSize(pdf: Uint8Array): number {
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

/**
 * Append a Document Security Store to an already-signed PDF as a strict incremental update, leaving
 * every existing byte — and therefore every existing signature's /ByteRange digest — untouched.
 * Returns the augmented bytes (or the input unchanged if there's nothing to add). Throws, without
 * producing output, if the PDF can't be read.
 */
export async function appendDss(pdf: Uint8Array, material: DssMaterial): Promise<Uint8Array> {
  const certs = material.certs ?? []
  const ocsps = material.ocsps ?? []
  const crls = material.crls ?? []
  if (!certs.length && !ocsps.length && !crls.length) return pdf

  const doc = await PDFDocument.load(pdf)
  const rootRef = doc.context.trailerInfo.Root
  if (!(rootRef instanceof PDFRef)) throw new Error('DSS: catalog (/Root) not found')
  const rootNum = rootRef.objectNumber
  const infoRef = doc.context.trailerInfo.Info
  const largest = Math.max(
    0,
    ...doc.context.enumerateIndirectObjects().map(([r]) => r.objectNumber)
  )
  // Allocate new objects above BOTH the largest used number and the declared /Size, so they can't
  // collide with a free/deleted slot the existing xref chain still reserves.
  const firstNew = Math.max(largest, maxDeclaredSize(pdf) - 1) + 1
  const prev = lastStartxref(pdf)

  // Catalog entries to carry forward (drop the old /DSS pointer — we replace it with a merged one).
  const catalogEntries = doc.catalog
    .entries()
    .filter(([k]) => k.toString() !== '/DSS')
    .map(([k, v]) => `${k.toString()} ${v.toString()}`)

  // If a /DSS already exists (a prior LTV pass), merge it forward: its stream objects stay in the
  // file (append-only), so we keep referencing them and union the new refs in — otherwise a second
  // pass would orphan the first pass's certs/OCSPs/CRLs. Other entries (e.g. /VRI) are carried as-is.
  const existingDss = ((): PDFDict | undefined => {
    const ref = doc.catalog.get(PDFName.of('DSS'))
    const d = ref ? doc.context.lookup(ref) : undefined
    return d instanceof PDFDict ? d : undefined
  })()
  const existingRefs = (key: string): string[] => {
    const a = existingDss?.get(PDFName.of(key))
    return a instanceof PDFArray ? a.asArray().map((x) => x.toString()) : []
  }
  const otherDssEntries = (existingDss?.entries() ?? [])
    .filter(([k]) => !['/Certs', '/OCSPs', '/CRLs'].includes(k.toString()))
    .map(([k, v]) => `${k.toString()} ${v.toString()}`)

  // New object numbers: one stream per cert/OCSP/CRL (in that order), then the DSS dict.
  let next = firstNew - 1
  const stream = (bytes: Uint8Array): { num: number; buf: Buffer } => {
    const num = ++next
    const body = Buffer.from(bytes)
    const buf = Buffer.concat([
      latin1(`${num} 0 obj\n<< /Length ${body.length} >>\nstream\n`),
      body,
      latin1('\nendstream\nendobj\n')
    ])
    return { num, buf }
  }
  const certObjs = certs.map(stream)
  const ocspObjs = ocsps.map(stream)
  const crlObjs = crls.map(stream)
  const dssNum = ++next

  // Each store array = the certs/OCSPs/CRLs already in the file's /DSS (if any) + the newly added.
  const merged = (key: string, objs: { num: number }[]): string[] => [
    ...existingRefs(key),
    ...objs.map((o) => `${o.num} 0 R`)
  ]
  const certAll = merged('Certs', certObjs)
  const ocspAll = merged('OCSPs', ocspObjs)
  const crlAll = merged('CRLs', crlObjs)
  const dssParts: string[] = []
  if (certAll.length) dssParts.push(`/Certs [ ${certAll.join(' ')} ]`)
  if (ocspAll.length) dssParts.push(`/OCSPs [ ${ocspAll.join(' ')} ]`)
  if (crlAll.length) dssParts.push(`/CRLs [ ${crlAll.join(' ')} ]`)
  dssParts.push(...otherDssEntries)
  const dssBuf = latin1(`${dssNum} 0 obj\n<< ${dssParts.join(' ')} >>\nendobj\n`)
  const catalogBuf = latin1(
    `${rootNum} 0 obj\n<<\n${catalogEntries.join('\n')}\n/DSS ${dssNum} 0 R\n>>\nendobj\n`
  )

  // Lay out the appended objects, recording each one's absolute byte offset from the file start.
  const objects: { num: number; buf: Buffer }[] = [
    { num: rootNum, buf: catalogBuf },
    ...certObjs,
    ...ocspObjs,
    ...crlObjs,
    { num: dssNum, buf: dssBuf }
  ]
  // A newline separates the prior %%EOF (which @signpdf writes with no trailing EOL) from the first
  // appended object, so a sequential lexer can't fold "%%EOF" + "N 0 obj" into one comment line.
  const offsets = new Map<number, number>()
  const body: Buffer[] = []
  let cursor = pdf.length + 1
  for (const o of objects) {
    offsets.set(o.num, cursor)
    body.push(o.buf)
    cursor += o.buf.length
  }
  const xrefOffset = cursor

  // Cross-reference table, subsections in ascending object-number order: the rewritten catalog
  // (rootNum) sits below the contiguous block of new objects (firstNew .. dssNum).
  const row = (off: number): string => `${`${off}`.padStart(10, '0')} 00000 n \n`
  const newNums: number[] = []
  for (let n = firstNew; n <= dssNum; n++) newNums.push(n)
  const xref =
    'xref\n' +
    `${rootNum} 1\n${row(offsets.get(rootNum)!)}` +
    `${firstNew} ${newNums.length}\n${newNums.map((n) => row(offsets.get(n)!)).join('')}`

  const trailer =
    'trailer\n<<\n' +
    `/Size ${dssNum + 1}\n` +
    `/Root ${rootNum} 0 R\n` +
    (infoRef instanceof PDFRef ? `/Info ${infoRef.objectNumber} 0 R\n` : '') +
    `/Prev ${prev}\n>>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`

  return new Uint8Array(
    Buffer.concat([Buffer.from(pdf), latin1('\n'), ...body, latin1(xref), latin1(trailer)])
  )
}
