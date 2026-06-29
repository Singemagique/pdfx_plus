import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  PDFDocument,
  PDFName,
  PDFRef,
  PDFDict,
  PDFArray,
  PDFRawStream,
  StandardFonts
} from 'pdf-lib'
import forge from 'node-forge'

import { signPdf } from './sign'
import { appendDss } from './dss'

function makeP12(passphrase: string): Uint8Array {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000)
  const attrs = [{ name: 'commonName', value: 'DSS Test Signer' }]
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
  page.drawText('Document to be LTV-enabled', { x: 40, y: 240, size: 16, font })
  return doc.save()
}

// SHA-256 of the bytes the signature covers (the two /ByteRange segments around /Contents).
function byteRangeDigest(pdf: Uint8Array): string {
  const s = Buffer.from(pdf).toString('latin1')
  const br = s.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/)!
  const [a, b, c, d] = [br[1], br[2], br[3], br[4]].map(Number)
  const content = Buffer.concat([
    Buffer.from(pdf).subarray(a, a + b),
    Buffer.from(pdf).subarray(c, c + d)
  ])
  return createHash('sha256').update(content).digest('hex')
}

// The messageDigest signed attribute carried inside the CMS in /Contents.
function cmsMessageDigest(pdf: Uint8Array): string {
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

describe('appendDss', () => {
  it('adds a /DSS as a strict incremental update without invalidating the existing signature', async () => {
    const signed = await signPdf(await makePdf(), makeP12('pw'), { passphrase: 'pw' })
    // The signature is valid before: its messageDigest equals the digest of the covered bytes.
    expect(cmsMessageDigest(signed)).toBe(byteRangeDigest(signed))

    const cert = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x2a]) // stand-in DER cert blob
    const ocsp = new Uint8Array([0x30, 0x02, 0x05, 0x00])
    const crl = new Uint8Array([0x30, 0x04, 0x02, 0x02, 0x12, 0x34])
    const out = await appendDss(signed, { certs: [cert], ocsps: [ocsp], crls: [crl] })

    // Append-only: every original byte is preserved verbatim.
    expect(Buffer.from(out.subarray(0, signed.length)).equals(Buffer.from(signed))).toBe(true)
    expect(out.length).toBeGreaterThan(signed.length)

    // The signature still verifies: its /ByteRange points into the untouched prefix, so the covered
    // bytes — and thus the digest — are identical to what the CMS messageDigest attests.
    expect(byteRangeDigest(out)).toBe(cmsMessageDigest(out))
    expect(cmsMessageDigest(out)).toBe(cmsMessageDigest(signed))

    // The augmented file re-parses and the catalog now carries a /DSS with the three stores.
    const reloaded = await PDFDocument.load(out)
    const dssRef = reloaded.catalog.get(PDFName.of('DSS'))
    expect(dssRef).toBeInstanceOf(PDFRef)
    const dss = reloaded.context.lookup(dssRef as PDFRef) as PDFDict
    expect((dss.get(PDFName.of('Certs')) as PDFArray).size()).toBe(1)
    expect((dss.get(PDFName.of('OCSPs')) as PDFArray).size()).toBe(1)
    expect((dss.get(PDFName.of('CRLs')) as PDFArray).size()).toBe(1)
  })

  it('returns the input unchanged when there is nothing to add', async () => {
    const signed = await signPdf(await makePdf(), makeP12('pw'), { passphrase: 'pw' })
    const out = await appendDss(signed, { certs: [] })
    expect(out).toBe(signed)
  })

  it('embeds the exact DER bytes of each store object', async () => {
    const signed = await signPdf(await makePdf(), makeP12('pw'), { passphrase: 'pw' })
    const cert = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const out = await appendDss(signed, { certs: [cert] })
    const reloaded = await PDFDocument.load(out)
    const dss = reloaded.context.lookup(
      reloaded.catalog.get(PDFName.of('DSS')) as PDFRef
    ) as PDFDict
    const certStreams = dss.get(PDFName.of('Certs')) as PDFArray
    const stream = reloaded.context.lookup(certStreams.get(0)) as PDFRawStream
    expect(Buffer.from(stream.contents).equals(Buffer.from(cert))).toBe(true)
  })

  it('terminates the prior %%EOF with a newline before the appended section', async () => {
    const signed = await signPdf(await makePdf(), makeP12('pw'), { passphrase: 'pw' })
    const out = await appendDss(signed, { certs: [new Uint8Array([0x30, 0x00])] })
    // A newline separates the original bytes from the first appended object, so a sequential lexer
    // can't fold "%%EOF" and "N 0 obj" into one comment line.
    expect(out[signed.length]).toBe(0x0a)
    expect(Buffer.from(out).toString('latin1')).not.toMatch(/%%EOF\d/)
  })

  it('merges material across repeated passes instead of orphaning the earlier DSS', async () => {
    const signed = await signPdf(await makePdf(), makeP12('pw'), { passphrase: 'pw' })
    const pass1 = await appendDss(signed, {
      certs: [new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x2a])]
    })
    const pass2 = await appendDss(pass1, { ocsps: [new Uint8Array([0x30, 0x02, 0x05, 0x00])] })

    // Append-only holds across both incremental updates, and the signature stays valid.
    expect(Buffer.from(pass2.subarray(0, pass1.length)).equals(Buffer.from(pass1))).toBe(true)
    expect(byteRangeDigest(pass2)).toBe(cmsMessageDigest(pass2))

    // The final /DSS carries BOTH the first pass's cert and the second pass's OCSP (union, not reset).
    const reloaded = await PDFDocument.load(pass2)
    const dss = reloaded.context.lookup(
      reloaded.catalog.get(PDFName.of('DSS')) as PDFRef
    ) as PDFDict
    expect((dss.get(PDFName.of('Certs')) as PDFArray).size()).toBe(1)
    expect((dss.get(PDFName.of('OCSPs')) as PDFArray).size()).toBe(1)
  })
})
