import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray, StandardFonts } from 'pdf-lib'
import forge from 'node-forge'

import { signPdf } from './sign'
import { addDocTimeStamp } from './doc-timestamp'
import { makeLocalTsa } from './tsa-local'
import { verifyTimestampToken } from './timestamp'
import { type RevocationFetcher } from './revocation'

const cannedFetcher: RevocationFetcher = {
  fetchOcsp: async () => new Uint8Array([0x30, 0x03, 0x0a, 0x01, 0x00]),
  fetchCrl: async () => new Uint8Array([0x30, 0x02, 0x05, 0x00]),
  fetchCaIssuers: async () => null
}

function makeP12(passphrase: string): Uint8Array {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000)
  const attrs = [{ name: 'commonName', value: 'TS Signer' }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const der = forge.asn1
    .toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase))
    .getBytes()
  return new Uint8Array(Buffer.from(der, 'binary'))
}

async function makePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([400, 300])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('Timestamp me', { x: 40, y: 240, size: 16, font })
  return doc.save()
}

// SHA-256 of the bytes the FIRST signature covers (its /ByteRange) — the prior approval signature.
function firstByteRangeDigest(pdf: Uint8Array): string {
  const s = Buffer.from(pdf).toString('latin1')
  const br = s.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/)!
  const [a, b, c, d] = [br[1], br[2], br[3], br[4]].map(Number)
  const content = Buffer.concat([
    Buffer.from(pdf).subarray(a, a + b),
    Buffer.from(pdf).subarray(c, c + d)
  ])
  return createHash('sha256').update(content).digest('hex')
}

// The messageDigest signed attribute inside the FIRST signature's CMS (/Contents).
function firstCmsMessageDigest(pdf: Uint8Array): string {
  const s = Buffer.from(pdf).toString('latin1')
  const cmsHex = s.match(/\/Contents\s*<([0-9A-Fa-f]+)>/)![1]
  type Attr = { value: Array<{ value: unknown }> }
  const fromDer = forge.asn1.fromDer as unknown as (
    b: forge.util.ByteStringBuffer,
    o: { parseAllBytes: boolean }
  ) => forge.asn1.Asn1
  const p7 = forge.pkcs7.messageFromAsn1(
    fromDer(forge.util.createBuffer(forge.util.hexToBytes(cmsHex)), { parseAllBytes: false })
  ) as unknown as { rawCapture: { authenticatedAttributes?: Attr[] } }
  for (const attr of p7.rawCapture.authenticatedAttributes ?? []) {
    if (forge.asn1.derToOid(attr.value[0].value as string) === forge.pki.oids.messageDigest) {
      return forge.util.bytesToHex((attr.value[1] as Attr).value[0].value as string)
    }
  }
  throw new Error('no messageDigest')
}

// The LAST signature's token (/Contents) + the bytes its /ByteRange covers — the document timestamp.
function lastTimestamp(pdf: Uint8Array): { token: ArrayBuffer; content: ArrayBuffer } {
  const s = Buffer.from(pdf).toString('latin1')
  const brs = [...s.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)]
  const br = brs[brs.length - 1]
  const [a, b, c, d] = [br[1], br[2], br[3], br[4]].map(Number)
  const content = Buffer.concat([
    Buffer.from(pdf).subarray(a, a + b),
    Buffer.from(pdf).subarray(c, c + d)
  ])
  const cs = [...s.matchAll(/\/Contents\s*<([0-9A-Fa-f]*)>/g)]
  const tokenBuf = Buffer.from(cs[cs.length - 1][1], 'hex') // trailing zero padding is ignored by fromBER
  return {
    token: tokenBuf.buffer.slice(tokenBuf.byteOffset, tokenBuf.byteOffset + tokenBuf.byteLength),
    content: content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength)
  }
}

describe('addDocTimeStamp', () => {
  it('appends a verifiable /DocTimeStamp without breaking the existing signature', async () => {
    const signed = await signPdf(await makePdf(), makeP12('pw'), { passphrase: 'pw' })
    const priorDigest = firstCmsMessageDigest(signed)
    expect(firstByteRangeDigest(signed)).toBe(priorDigest) // sanity: prior signature is valid

    const out = await addDocTimeStamp(signed, await makeLocalTsa())

    // 1. The prior approval signature is untouched: its ByteRange digest still equals its CMS digest.
    expect(firstByteRangeDigest(out)).toBe(firstCmsMessageDigest(out))
    expect(firstCmsMessageDigest(out)).toBe(priorDigest)

    // 2. A clean, invisible document timestamp dict was written.
    const text = Buffer.from(out).toString('latin1')
    expect(text).toContain('/Type /DocTimeStamp')
    expect(text).toContain('/SubFilter /ETSI.RFC3161')

    // 3. The embedded RFC3161 token timestamps the whole document (its imprint covers the ByteRange).
    const { token, content } = lastTimestamp(out)
    const info = await verifyTimestampToken(token, content)
    expect(info.imprintOk).toBe(true)

    // 4. Re-parses, and the AcroForm gained exactly the timestamp field.
    const before = await PDFDocument.load(signed)
    const after = await PDFDocument.load(out)
    const fieldCount = (doc: PDFDocument): number => {
      const acro = doc.context.lookupMaybe(
        doc.catalog.get(PDFName.of('AcroForm')) as PDFRef,
        PDFDict
      )
      const fields = acro?.get(PDFName.of('Fields'))
      const arr = fields instanceof PDFArray ? fields : doc.context.lookupMaybe(fields as PDFRef, PDFArray) // prettier-ignore
      return arr ? arr.size() : 0
    }
    expect(fieldCount(after)).toBe(fieldCount(before) + 1)
  })

  it('signPdf produces full B-LTA (DSS + DocTimeStamp) when ltv and a TSA are set', async () => {
    const getToken = await makeLocalTsa()
    const out = await signPdf(
      await makePdf(),
      makeP12('pw'),
      { passphrase: 'pw', ltv: true, tsaUrl: 'http://local-tsa' },
      getToken, // local TSA for both the B-T signature timestamp and the archive timestamp
      cannedFetcher
    )
    const text = Buffer.from(out).toString('latin1')
    expect(text).toContain('/DSS') // B-LT: validation data embedded
    expect(text).toContain('/Type /DocTimeStamp') // B-LTA: archive timestamp added
    // The approval signature is still valid through both incremental updates.
    expect(firstByteRangeDigest(out)).toBe(firstCmsMessageDigest(out))
    const { token, content } = lastTimestamp(out)
    expect((await verifyTimestampToken(token, content)).imprintOk).toBe(true)
  })

  it('gives each timestamp a unique field name when re-timestamping (archive refresh)', async () => {
    const getToken = await makeLocalTsa()
    const signed = await signPdf(await makePdf(), makeP12('pw'), { passphrase: 'pw' })
    const twice = await addDocTimeStamp(await addDocTimeStamp(signed, getToken), getToken)

    // The two document-timestamp field names are distinct (AcroForm names must be unique).
    const names = [
      ...Buffer.from(twice)
        .toString('latin1')
        .matchAll(/\/T \(PDFx Document Timestamp[^)]*\)/g)
    ].map((m) => m[0])
    expect(names.length).toBe(2)
    expect(new Set(names).size).toBe(2)

    // The approval signature and the latest timestamp are still valid through both updates.
    expect(firstByteRangeDigest(twice)).toBe(firstCmsMessageDigest(twice))
    const { token, content } = lastTimestamp(twice)
    expect((await verifyTimestampToken(token, content)).imprintOk).toBe(true)
  })

  it('leaves the result at B-LT (no DocTimeStamp) when ltv is set without a TSA', async () => {
    const out = await signPdf(
      await makePdf(),
      makeP12('pw'),
      { passphrase: 'pw', ltv: true },
      undefined,
      cannedFetcher
    )
    expect(Buffer.from(out).toString('latin1')).not.toContain('/Type /DocTimeStamp')
  })
})
