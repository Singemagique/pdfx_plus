import { describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray, PDFRawStream } from 'pdf-lib'

import { signPdf } from './sign'
import { appendDss } from './dss'
import {
  byteRangeDigest,
  cmsMessageDigest,
  makeP12 as makeCredential,
  makePdf as makeTestPdf
} from './test-utils/fixtures'

const makeP12 = (passphrase: string): Uint8Array =>
  makeCredential(passphrase, { cn: 'DSS Test Signer' }).p12

const makePdf = (): Promise<Uint8Array> => makeTestPdf('Document to be LTV-enabled')

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
