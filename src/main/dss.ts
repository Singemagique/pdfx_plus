// Append-only DSS (Document Security Store) writer for PAdES B-LT/LTV. Adds the signer's certificate
// chain + OCSP responses + CRLs to an ALREADY-SIGNED PDF as a strict INCREMENTAL UPDATE: every
// existing byte is preserved, so every existing signature's /ByteRange digest stays valid. pdf-lib's
// save() rewrites the whole file (which would invalidate prior signatures), so we read the structure
// with pdf-lib but hand-write the appended section — new objects + a cross-reference table + a
// trailer chained via /Prev. Runs in the MAIN process. (Per-signature /VRI is a follow-up; Adobe
// recognizes LTV from the document-level /DSS arrays.)
import { PDFDocument, PDFRef, PDFName, PDFDict, PDFArray } from 'pdf-lib'
import { appendIncrementalUpdate, latin1, maxDeclaredSize } from './incremental-update'

export interface DssMaterial {
  /** DER certificates: the signer leaf + its chain. */
  certs?: Uint8Array[]
  /** DER OCSP responses (OCSPResponse). */
  ocsps?: Uint8Array[]
  /** DER CRLs. */
  crls?: Uint8Array[]
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

  // Append the rewritten catalog (rootNum) plus the contiguous block of new objects
  // (firstNew .. dssNum) as an incremental update; /Size lands at dssNum + 1.
  return new Uint8Array(
    appendIncrementalUpdate(
      pdf,
      [
        { num: rootNum, buf: catalogBuf },
        ...certObjs,
        ...ocspObjs,
        ...crlObjs,
        { num: dssNum, buf: dssBuf }
      ],
      {
        rootNum,
        infoNum: infoRef instanceof PDFRef ? infoRef.objectNumber : undefined,
        label: 'DSS'
      }
    )
  )
}
