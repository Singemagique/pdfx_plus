// PAdES B-LTA document timestamp. Appends an invisible /Type /DocTimeStamp signature whose /Contents
// is an RFC3161 token over the WHOLE document (including any prior signature + DSS), as a strict
// append-only incremental update — so the existing signature(s) stay valid and the timestamp anchors
// them (and the DSS) to a trusted time. We hand-write the placeholder (a clean /DocTimeStamp dict +
// an invisible signature field merged into the existing AcroForm + page) because @signpdf only emits
// /Type /Sig; then reuse @signpdf's SignPdf.sign for the ByteRange computation + token splice. Runs
// in the MAIN process. The token issuer is injectable so tests run offline.
import { webcrypto } from 'node:crypto'
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray } from 'pdf-lib'
import { SignPdf } from '@signpdf/signpdf'
import { Signer } from '@signpdf/utils'
import { type TokenIssuer } from './timestamp'

// Room (bytes) for the RFC3161 token + the TSA's certificate chain in /Contents. Matches the B-T
// signature-timestamp budget in sign.ts (placeAndSign uses 32768 when a TSA is configured): a TSA
// whose token + cross-cert chain lands in the 16–26 KB band must not overflow a smaller placeholder
// here and make the archive timestamp throw "Signature exceeds placeholder".
const TOKEN_LENGTH = 32768
// @signpdf's findByteRange recognizes the placeholder as [0 /********** /********** /**********].
const BR = '/ByteRange [0 /********** /********** /**********]'

const latin1 = (s: string): Buffer => Buffer.from(s, 'latin1')

// Byte offset of the most recent xref section (the value after the final `startxref`), for /Prev.
function lastStartxref(pdf: Uint8Array): number {
  const s = Buffer.from(pdf).toString('latin1')
  const eof = s.lastIndexOf('%%EOF')
  const i = s.lastIndexOf('startxref', eof === -1 ? s.length : eof)
  const m = i === -1 ? null : /startxref\s+(\d+)/.exec(s.slice(i))
  if (!m) throw new Error('DocTimeStamp: no startxref (not an incrementally-updatable PDF)')
  return parseInt(m[1], 10)
}

// Largest /Size declared by the trailers / xref-stream dicts (the true next-free object number).
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

// Carry a dict's entries forward as text, dropping `omit` keys; used to rewrite the AcroForm + page.
function entriesExcept(dict: PDFDict, omit: string[]): string {
  return dict
    .entries()
    .filter(([k]) => !omit.includes(k.toString()))
    .map(([k, v]) => `${k.toString()} ${v.toString()}`)
    .join('\n')
}

// Existing members of an array-valued key (resolving an indirect array), as "n 0 R" / literal text.
function arrayItems(dict: PDFDict, key: string): string[] {
  const v = dict.get(PDFName.of(key))
  const arr = v instanceof PDFArray ? v : v instanceof PDFRef ? dict.context.lookupMaybe(v, PDFArray) : undefined // prettier-ignore
  return arr ? arr.asArray().map((x) => x.toString()) : []
}

/** A @signpdf Signer whose output is the RFC3161 TimeStampToken over the ByteRange content's SHA-256
 *  — i.e. the /Contents of the document timestamp. */
class DocTimestampSigner extends Signer {
  constructor(private readonly getToken: TokenIssuer) {
    super()
  }
  async sign(pdfBuffer: Buffer): Promise<Buffer> {
    const digest = await webcrypto.subtle.digest('SHA-256', pdfBuffer)
    return Buffer.from(await this.getToken(digest))
  }
}

/**
 * Append a document timestamp (PAdES B-LTA). Returns the augmented bytes; throws (without output) if
 * the PDF can't be read or the TSA fails — never emits a half-written file.
 */
export async function addDocTimeStamp(pdf: Uint8Array, getToken: TokenIssuer): Promise<Uint8Array> {
  const withPlaceholder = await addDocTimeStampPlaceholder(pdf)
  const signed = await new SignPdf().sign(withPlaceholder, new DocTimestampSigner(getToken))
  return new Uint8Array(signed)
}

// Hand-write the incremental update: the /DocTimeStamp dict (N1) + an invisible signature field (N2)
// merged into the existing AcroForm (its /Fields) and the first page (its /Annots), plus the xref +
// /Prev trailer. The result has exactly one ByteRange placeholder for SignPdf.sign to fill.
async function addDocTimeStampPlaceholder(pdf: Uint8Array): Promise<Buffer> {
  const doc = await PDFDocument.load(pdf)
  const rootRef = doc.context.trailerInfo.Root
  if (!(rootRef instanceof PDFRef)) throw new Error('DocTimeStamp: catalog (/Root) not found')
  const acroRef = doc.catalog.get(PDFName.of('AcroForm'))
  if (!(acroRef instanceof PDFRef))
    throw new Error('DocTimeStamp: no AcroForm (sign the PDF first)')
  const acro = doc.context.lookupMaybe(acroRef, PDFDict)
  if (!acro) throw new Error('DocTimeStamp: AcroForm is not a dictionary')
  const page = doc.getPage(0)
  const pageRef = page.ref

  const infoRef = doc.context.trailerInfo.Info
  const largest = Math.max(
    0,
    ...doc.context.enumerateIndirectObjects().map(([r]) => r.objectNumber)
  )
  const firstNew = Math.max(largest, maxDeclaredSize(pdf) - 1) + 1
  const sigNum = firstNew // N1: the /DocTimeStamp signature dict
  const fieldNum = firstNew + 1 // N2: the invisible signature field/widget
  const prev = lastStartxref(pdf)

  const sigObj = latin1(
    `${sigNum} 0 obj\n<< /Type /DocTimeStamp /Filter /Adobe.PPKLite /SubFilter /ETSI.RFC3161 ` +
      `${BR} /Contents <${'0'.repeat(TOKEN_LENGTH * 2)}> >>\nendobj\n`
  )
  // Unique field name: re-timestamping (archive refresh) is a legal PAdES operation, and AcroForm
  // field names must be unique — derive the suffix from the current field count.
  const existingFields = arrayItems(acro, 'Fields')
  const tsName = `PDFx Document Timestamp ${existingFields.length}`
  // Invisible field (zero /Rect): it carries the timestamp, so it's not a fillable "sign here" box.
  const fieldObj = latin1(
    `${fieldNum} 0 obj\n<< /Type /Annot /Subtype /Widget /FT /Sig /F 2 /Rect [0 0 0 0] ` +
      `/T (${tsName}) /V ${sigNum} 0 R /P ${pageRef.objectNumber} ${pageRef.generationNumber} R >>\nendobj\n`
  )
  const acroObj = latin1(
    `${acroRef.objectNumber} 0 obj\n<<\n${entriesExcept(acro, ['/Fields', '/SigFlags'])}\n` +
      `/Fields [ ${[...existingFields, `${fieldNum} 0 R`].join(' ')} ]\n/SigFlags 3\n>>\nendobj\n`
  )
  const pageObj = latin1(
    `${pageRef.objectNumber} 0 obj\n<<\n${entriesExcept(page.node, ['/Annots'])}\n` +
      `/Annots [ ${[...arrayItems(page.node, 'Annots'), `${fieldNum} 0 R`].join(' ')} ]\n>>\nendobj\n`
  )

  // Lay out the appended objects (a newline first so the prior %%EOF is line-terminated), recording
  // each object's absolute byte offset for the xref.
  const objects: { num: number; buf: Buffer }[] = [
    { num: acroRef.objectNumber, buf: acroObj },
    { num: pageRef.objectNumber, buf: pageObj },
    { num: sigNum, buf: sigObj },
    { num: fieldNum, buf: fieldObj }
  ]
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

  const trailer =
    'trailer\n<<\n' +
    `/Size ${Math.max(maxDeclaredSize(pdf), fieldNum + 1)}\n` +
    `/Root ${rootRef.objectNumber} 0 R\n` +
    (infoRef instanceof PDFRef ? `/Info ${infoRef.objectNumber} 0 R\n` : '') +
    `/Prev ${prev}\n>>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`

  return Buffer.concat([Buffer.from(pdf), latin1('\n'), ...body, latin1(xref), latin1(trailer)])
}
