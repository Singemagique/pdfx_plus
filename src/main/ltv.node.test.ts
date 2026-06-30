import { describe, expect, it } from 'vitest'
import { webcrypto } from 'node:crypto'
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray, StandardFonts } from 'pdf-lib'
import forge from 'node-forge'
import * as pkijs from 'pkijs'
import * as asn1js from 'asn1js'

import { signPdf } from './sign'
import { addLtv } from './ltv'
import { type RevocationFetcher } from './revocation'

function makeP12(passphrase: string): Uint8Array {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000)
  const attrs = [{ name: 'commonName', value: 'LTV Signer' }]
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
  page.drawText('LTV document', { x: 40, y: 240, size: 16, font })
  return doc.save()
}

// A DER X.509 cert (RSA, self-signed) with optional AIA(OCSP) + CDP extensions.
async function makeCert(opts: {
  subject: string
  issuer: string
  ocsp?: string
  crl?: string
}): Promise<ArrayBuffer> {
  const keys = (await webcrypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair
  const cert = new pkijs.Certificate()
  cert.version = 2
  cert.serialNumber = new asn1js.Integer({ value: 7 })
  cert.subject.typesAndValues.push(
    new pkijs.AttributeTypeAndValue({
      type: '2.5.4.3',
      value: new asn1js.PrintableString({ value: opts.subject })
    })
  )
  cert.issuer.typesAndValues.push(
    new pkijs.AttributeTypeAndValue({
      type: '2.5.4.3',
      value: new asn1js.PrintableString({ value: opts.issuer })
    })
  )
  cert.notBefore.value = new Date(Date.now() - 3600_000)
  cert.notAfter.value = new Date(Date.now() + 365 * 24 * 3600_000)
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey)
  cert.extensions = []
  if (opts.ocsp) {
    const aia = new pkijs.InfoAccess({
      accessDescriptions: [
        new pkijs.AccessDescription({
          accessMethod: '1.3.6.1.5.5.7.48.1',
          accessLocation: new pkijs.GeneralName({ type: 6, value: opts.ocsp })
        })
      ]
    })
    cert.extensions.push(
      new pkijs.Extension({ extnID: '1.3.6.1.5.5.7.1.1', extnValue: aia.toSchema().toBER(false) })
    )
  }
  if (opts.crl) {
    const cdp = new pkijs.CRLDistributionPoints({
      distributionPoints: [
        new pkijs.DistributionPoint({
          distributionPoint: [new pkijs.GeneralName({ type: 6, value: opts.crl })]
        })
      ]
    })
    cert.extensions.push(
      new pkijs.Extension({ extnID: '2.5.29.31', extnValue: cdp.toSchema().toBER(false) })
    )
  }
  await cert.sign(keys.privateKey, 'SHA-256')
  return cert.toSchema().toBER(false)
}

const cannedFetcher: RevocationFetcher = {
  fetchOcsp: async () => new Uint8Array([0x30, 0x03, 0x0a, 0x01, 0x00]),
  fetchCrl: async () => new Uint8Array([0x30, 0x02, 0x05, 0x00])
}

async function loadDss(pdf: Uint8Array): Promise<PDFDict> {
  const doc = await PDFDocument.load(pdf)
  const ref = doc.catalog.get(PDFName.of('DSS'))
  expect(ref).toBeInstanceOf(PDFRef)
  return doc.context.lookup(ref as PDFRef) as PDFDict
}

describe('addLtv', () => {
  it('embeds the chain + OCSP/CRL as a DSS without disturbing the signature', async () => {
    const signed = await signPdf(await makePdf(), makeP12('pw'), { passphrase: 'pw' })
    const ca = await makeCert({ subject: 'CA', issuer: 'CA' })
    const leaf = await makeCert({
      subject: 'Leaf',
      issuer: 'CA',
      ocsp: 'http://ocsp.test/',
      crl: 'http://crl.test/x.crl'
    })

    const out = await addLtv(signed, leaf, [ca], cannedFetcher)

    // Append-only — the signed prefix is byte-for-byte intact, so the signature stays valid.
    expect(Buffer.from(out.subarray(0, signed.length)).equals(Buffer.from(signed))).toBe(true)

    const dss = await loadDss(out)
    expect((dss.get(PDFName.of('Certs')) as PDFArray).size()).toBe(2) // leaf + CA
    // Leaf is checked via OCSP (it advertises both, OCSP wins); CA is the root → no revocation.
    expect((dss.get(PDFName.of('OCSPs')) as PDFArray).size()).toBe(1)
    expect(dss.get(PDFName.of('CRLs'))).toBeUndefined()
  })
})

describe('signPdf ltv option', () => {
  it('appends a DSS carrying the signing certificate when ltv is set', async () => {
    const out = await signPdf(
      await makePdf(),
      makeP12('pw'),
      { passphrase: 'pw', ltv: true },
      undefined,
      cannedFetcher
    )
    const dss = await loadDss(out)
    // The self-signed test cert has no chain and no AIA/CDP, so just the leaf cert lands in the DSS.
    expect((dss.get(PDFName.of('Certs')) as PDFArray).size()).toBe(1)
  })

  it('does not add a DSS when ltv is not set', async () => {
    const out = await signPdf(await makePdf(), makeP12('pw'), { passphrase: 'pw' })
    const doc = await PDFDocument.load(out)
    expect(doc.catalog.get(PDFName.of('DSS'))).toBeUndefined()
  })
})
