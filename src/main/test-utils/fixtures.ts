// Shared fixtures for the main-process signing tests (sign / dss / ltv / doc-timestamp /
// cert-chain / revocation / cert-info). These are test-only helpers — they live inside
// src/main so tsconfig.node.json type-checks them, and are excluded from coverage.

import { createHash, webcrypto } from 'node:crypto'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import forge from 'node-forge'
import * as pkijs from 'pkijs'
import * as asn1js from 'asn1js'

import { type RevocationFetcher } from '../revocation'

export interface MakeP12Options {
  /** Common name of the self-signed subject/issuer. Ignored when `subject` is given. */
  cn?: string
  /** Full subject attribute list, for certs that need more than a CN. */
  subject?: forge.pki.CertificateField[]
  /** Full issuer attribute list; defaults to the subject (self-signed). */
  issuer?: forge.pki.CertificateField[]
  /** PKCS#12 bulk-encryption algorithm. Omit for node-forge's own default. */
  algorithm?: '3des' | 'aes128' | 'aes192' | 'aes256'
}

/**
 * A self-signed RSA-2048 test credential: its PKCS#12 bytes (protected by `passphrase`) plus the
 * leaf certificate's DER, for the callers that inspect the cert directly.
 */
export function makeP12(
  passphrase: string,
  opts: MakeP12Options = {}
): { p12: Uint8Array; der: Uint8Array } {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000)
  const subject = opts.subject ?? [{ name: 'commonName', value: opts.cn ?? 'PDFx Test Signer' }]
  cert.setSubject(subject)
  cert.setIssuer(opts.issuer ?? subject)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  // An empty options object is what node-forge itself defaults to, so omitting `algorithm`
  // keeps the library's own choice.
  const p12Options = opts.algorithm ? { algorithm: opts.algorithm } : {}
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, p12Options)
  const p12 = new Uint8Array(Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'))
  const der = new Uint8Array(
    Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary')
  )
  return { p12, der }
}

/** A one-page 400x300 PDF carrying a single line of text. */
export async function makePdf(text: string, size = 16): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([400, 300])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText(text, { x: 40, y: 240, size, font })
  return doc.save()
}

/** A throwaway RSA key pair — CRL/OCSP signatures are not verified by the code under test. */
export async function genKeys(): Promise<CryptoKeyPair> {
  return (await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, // prettier-ignore
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair
}

export interface CertOpts {
  subject: string
  issuer: string
  /** AIA accessMethod id-ad-ocsp URL. */
  ocsp?: string
  /** AIA accessMethod id-ad-caIssuers URL. */
  caIssuers?: string
  /** CRL distribution point URL. */
  crl?: string
}

/**
 * A DER X.509 cert (RSA, self-signed for simplicity) with optional AIA + CDP extensions, built
 * with pkijs — the same library the code under test parses with, so the extensions round-trip
 * faithfully.
 */
export async function makeCert(opts: CertOpts, serial = 1): Promise<ArrayBuffer> {
  const keys = await genKeys()
  const cert = new pkijs.Certificate()
  cert.version = 2
  cert.serialNumber = new asn1js.Integer({ value: serial })
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
  if (opts.ocsp || opts.caIssuers) {
    const accessDescriptions: pkijs.AccessDescription[] = []
    if (opts.ocsp) {
      accessDescriptions.push(
        new pkijs.AccessDescription({
          accessMethod: '1.3.6.1.5.5.7.48.1',
          accessLocation: new pkijs.GeneralName({ type: 6, value: opts.ocsp })
        })
      )
    }
    if (opts.caIssuers) {
      accessDescriptions.push(
        new pkijs.AccessDescription({
          accessMethod: '1.3.6.1.5.5.7.48.2',
          accessLocation: new pkijs.GeneralName({ type: 6, value: opts.caIssuers })
        })
      )
    }
    const aia = new pkijs.InfoAccess({ accessDescriptions })
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

/**
 * A CRL (issued by `issuer`) listing `serials` as revoked. Its signature isn't verified by the
 * detector, so a throwaway key is fine.
 */
export async function makeRevokedCrl(serials: number[], issuer = 'CA'): Promise<Uint8Array> {
  const keys = await genKeys()
  const crl = new pkijs.CertificateRevocationList()
  crl.version = 1
  crl.issuer.typesAndValues.push(
    new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.PrintableString({ value: issuer }) }) // prettier-ignore
  )
  crl.thisUpdate = new pkijs.Time({ type: 0, value: new Date() })
  crl.revokedCertificates = serials.map(
    (s) =>
      new pkijs.RevokedCertificate({
        userCertificate: new asn1js.Integer({ value: s }),
        revocationDate: new pkijs.Time({ type: 0, value: new Date() })
      })
  )
  await crl.sign(keys.privateKey, 'SHA-256')
  return new Uint8Array(crl.toSchema().toBER(false))
}

/**
 * A signed OCSPResponse reporting `leafDer` (issued by `issuerDer`) as REVOKED. The signature
 * isn't verified by the detector, so a throwaway key is fine.
 */
export async function makeRevokedOcsp(
  leafDer: ArrayBuffer,
  issuerDer: ArrayBuffer
): Promise<Uint8Array> {
  const keys = await genKeys()
  const leaf = new pkijs.Certificate({ schema: asn1js.fromBER(leafDer).result })
  const issuer = new pkijs.Certificate({ schema: asn1js.fromBER(issuerDer).result })
  const single = new pkijs.SingleResponse()
  await single.certID.createForCertificate(leaf, {
    hashAlgorithm: 'SHA-1',
    issuerCertificate: issuer
  })
  // certStatus CHOICE [1] revoked → RevokedInfo { revocationTime GeneralizedTime }
  single.certStatus = new asn1js.Constructed({
    idBlock: { tagClass: 3, tagNumber: 1 },
    value: [new asn1js.GeneralizedTime({ valueDate: new Date() })]
  })
  single.thisUpdate = new Date()
  const basic = new pkijs.BasicOCSPResponse()
  basic.tbsResponseData.responses.push(single)
  basic.tbsResponseData.responderID = issuer.subject
  basic.tbsResponseData.producedAt = new Date()
  await basic.sign(keys.privateKey, 'SHA-256')
  const resp = new pkijs.OCSPResponse()
  resp.responseStatus.valueBlock.valueDec = 0
  resp.responseBytes = new pkijs.ResponseBytes({
    responseType: '1.3.6.1.5.5.7.48.1.1',
    response: new asn1js.OctetString({ valueHex: basic.toSchema().toBER(false) })
  })
  return new Uint8Array(resp.toSchema().toBER(false))
}

/** A fetcher that always answers with a minimal successful OCSP response and an empty CRL. */
export const cannedFetcher: RevocationFetcher = {
  fetchOcsp: async () => new Uint8Array([0x30, 0x03, 0x0a, 0x01, 0x00]),
  fetchCrl: async () => new Uint8Array([0x30, 0x02, 0x05, 0x00]),
  fetchCaIssuers: async () => null
}

/**
 * The exact bytes the (first) signature covers — the two /ByteRange segments around the
 * /Contents gap.
 */
export function byteRangeContent(pdf: Uint8Array): Buffer {
  const s = Buffer.from(pdf).toString('latin1')
  const br = s.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/)!
  const [a, b, c, d] = [br[1], br[2], br[3], br[4]].map(Number)
  return Buffer.concat([Buffer.from(pdf).subarray(a, a + b), Buffer.from(pdf).subarray(c, c + d)])
}

/** SHA-256 (hex) of the bytes the (first) signature covers. */
export function byteRangeDigest(pdf: Uint8Array): string {
  return createHash('sha256').update(byteRangeContent(pdf)).digest('hex')
}

/** The messageDigest signed attribute carried inside the (first) CMS in /Contents. */
export function cmsMessageDigest(pdf: Uint8Array): string {
  const s = Buffer.from(pdf).toString('latin1')
  const cmsHex = s.match(/\/Contents\s*<([0-9A-Fa-f]+)>/)![1]
  // node-forge's bundled types are outdated; cast around them. /Contents is zero-padded to the
  // placeholder length, so parse the CMS prefix only (parseAllBytes: false).
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
