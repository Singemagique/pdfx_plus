import { describe, expect, it } from 'vitest'
import { webcrypto } from 'node:crypto'
import * as pkijs from 'pkijs'
import * as asn1js from 'asn1js'

import {
  buildOcspRequest,
  certFromCaIssuers,
  collectRevocation,
  crlRevokesCert,
  isSuccessfulOcsp,
  ocspResponseRevoked,
  type RevocationFetcher
} from './revocation'

interface CertOpts {
  subject: string
  issuer: string
  ocsp?: string
  crl?: string
}

// Build a DER X.509 cert (RSA, self-signed) with optional AIA(OCSP) + CDP extensions, via pkijs.
async function makeCert(opts: CertOpts, serial = 1): Promise<ArrayBuffer> {
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

describe('buildOcspRequest', () => {
  it('produces a parseable OCSPRequest whose CertID targets the cert serial', async () => {
    const issuer = await makeCert({ subject: 'CA', issuer: 'CA' }, 1)
    const leaf = await makeCert({ subject: 'Leaf', issuer: 'CA' }, 42)
    const reqDer = await buildOcspRequest(leaf, issuer)

    const req = new pkijs.OCSPRequest({
      schema: asn1js.fromBER(reqDer.buffer as ArrayBuffer).result
    })
    expect(req.tbsRequest.requestList.length).toBe(1)
    const reqSerial = req.tbsRequest.requestList[0].reqCert.serialNumber
    const leafCert = new pkijs.Certificate({ schema: asn1js.fromBER(leaf).result })
    expect(Buffer.from(reqSerial.toBER()).equals(Buffer.from(leafCert.serialNumber.toBER()))).toBe(
      true
    )
  })
})

describe('isSuccessfulOcsp', () => {
  it('accepts a successful OCSPResponse and rejects errors / garbage', () => {
    // OCSPResponse ::= SEQUENCE { responseStatus ENUMERATED }
    expect(isSuccessfulOcsp(new Uint8Array([0x30, 0x03, 0x0a, 0x01, 0x00]))).toBe(true) // successful
    expect(isSuccessfulOcsp(new Uint8Array([0x30, 0x03, 0x0a, 0x01, 0x03]))).toBe(false) // tryLater
    expect(isSuccessfulOcsp(new Uint8Array([0x01, 0x02, 0x03]))).toBe(false) // not parseable
  })
})

describe('certFromCaIssuers', () => {
  it('returns the certificate from a bare DER response', async () => {
    const cert = await makeCert({ subject: 'Issuing CA', issuer: 'Issuing CA' })
    const out = certFromCaIssuers(new Uint8Array(cert))
    expect(out).not.toBeNull()
    const parsed = new pkijs.Certificate({
      schema: asn1js.fromBER(out!.buffer as ArrayBuffer).result
    })
    expect(parsed.subject.typesAndValues[0].value.valueBlock.value).toBe('Issuing CA')
  })

  it('extracts the first certificate from a PKCS#7 certs-only bundle', async () => {
    const cert = await makeCert({ subject: 'Bundle CA', issuer: 'Bundle CA' })
    const ci = new pkijs.ContentInfo({
      contentType: '1.2.840.113549.1.7.2',
      content: new pkijs.SignedData({
        version: 1,
        encapContentInfo: new pkijs.EncapsulatedContentInfo({
          eContentType: '1.2.840.113549.1.7.1'
        }),
        certificates: [new pkijs.Certificate({ schema: asn1js.fromBER(cert).result })],
        signerInfos: []
      }).toSchema()
    })
    const p7c = new Uint8Array(ci.toSchema().toBER(false))
    expect(certFromCaIssuers(p7c)).not.toBeNull()
  })

  it('returns null on bytes that are neither a cert nor a bundle', () => {
    expect(certFromCaIssuers(new Uint8Array([1, 2, 3, 4]))).toBeNull()
  })
})

describe('collectRevocation', () => {
  // A fetcher that returns canned blobs and records the URLs it was asked for.
  function recordingFetcher(): RevocationFetcher & { ocspUrls: string[]; crlUrls: string[] } {
    const ocspUrls: string[] = []
    const crlUrls: string[] = []
    return {
      ocspUrls,
      crlUrls,
      async fetchOcsp(_cert, _issuer, url) {
        ocspUrls.push(url)
        return new Uint8Array([0x30, 0x03, 0x0a, 0x01, 0x00])
      },
      async fetchCrl(url) {
        crlUrls.push(url)
        return new Uint8Array([0x30, 0x02, 0x05, 0x00])
      },
      async fetchCaIssuers() {
        return null
      }
    }
  }

  it('fetches OCSP for an AIA cert and CRL for a CDP-only cert, skipping the root', async () => {
    const leaf = await makeCert({ subject: 'Leaf', issuer: 'Int', ocsp: 'http://ocsp.test/' }, 3)
    const int = await makeCert({ subject: 'Int', issuer: 'Root', crl: 'http://crl.test/x.crl' }, 2)
    const root = await makeCert({ subject: 'Root', issuer: 'Root' }, 1)
    const fetcher = recordingFetcher()

    const out = await collectRevocation([leaf, int, root], fetcher)
    expect(out.ocsps.length).toBe(1) // leaf via OCSP
    expect(out.crls.length).toBe(1) // intermediate via CRL
    expect(fetcher.ocspUrls).toEqual(['http://ocsp.test/'])
    expect(fetcher.crlUrls).toEqual(['http://crl.test/x.crl'])
  })

  it('prefers OCSP over CRL when a cert advertises both', async () => {
    const leaf = await makeCert(
      { subject: 'Leaf', issuer: 'CA', ocsp: 'http://ocsp.test/', crl: 'http://crl.test/x.crl' },
      3
    )
    const ca = await makeCert({ subject: 'CA', issuer: 'CA' }, 1)
    const fetcher = recordingFetcher()

    const out = await collectRevocation([leaf, ca], fetcher)
    expect(out.ocsps.length).toBe(1)
    expect(out.crls.length).toBe(0) // CRL not fetched because OCSP succeeded
    expect(fetcher.crlUrls).toEqual([])
  })

  it('degrades to an empty result (no throw) when every fetch fails', async () => {
    const leaf = await makeCert(
      { subject: 'Leaf', issuer: 'CA', ocsp: 'http://ocsp.test/', crl: 'http://crl.test/x.crl' },
      3
    )
    const ca = await makeCert({ subject: 'CA', issuer: 'CA' }, 1)
    const failing: RevocationFetcher = {
      fetchOcsp: async () => null,
      fetchCrl: async () => null,
      fetchCaIssuers: async () => null
    }

    const out = await collectRevocation([leaf, ca], failing)
    expect(out).toEqual({ ocsps: [], crls: [], revoked: false })
  })

  it('does not flag revoked when responders report good status', async () => {
    const leaf = await makeCert({ subject: 'Leaf', issuer: 'CA', ocsp: 'http://ocsp.test/' }, 3)
    const ca = await makeCert({ subject: 'CA', issuer: 'CA' }, 1)
    const out = await collectRevocation([leaf, ca], recordingFetcher())
    expect(out.revoked).toBe(false)
  })
})

// A CRL/OCSP signature is not verified by our detectors (they read status/serials), so a
// throwaway key suffices to produce parseable DER.
async function genKeys(): Promise<CryptoKeyPair> {
  return (await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, // prettier-ignore
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair
}

async function makeRevokedCrl(serials: number[], issuer = 'CA'): Promise<Uint8Array> {
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

async function makeRevokedOcsp(leafDer: ArrayBuffer, issuerDer: ArrayBuffer): Promise<Uint8Array> {
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

describe('revoked-status detection (P1-4)', () => {
  it('crlRevokesCert matches a serial listed in the CRL, and ignores others', async () => {
    const leaf = await makeCert({ subject: 'Leaf', issuer: 'CA' }, 42)
    const other = await makeCert({ subject: 'Other', issuer: 'CA' }, 7)
    const crl = await makeRevokedCrl([42])
    expect(crlRevokesCert(crl, leaf)).toBe(true)
    expect(crlRevokesCert(crl, other)).toBe(false)
  })

  it('crlRevokesCert does not match a same-serial cert from a DIFFERENT issuer', async () => {
    // Serial 42 is revoked, but by EvilCA — our leaf (serial 42) was issued by CA.
    const leaf = await makeCert({ subject: 'Leaf', issuer: 'CA' }, 42)
    const evilCrl = await makeRevokedCrl([42], 'EvilCA')
    expect(crlRevokesCert(evilCrl, leaf)).toBe(false)
  })

  it('ocspResponseRevoked reads a revoked CertStatus', async () => {
    const issuer = await makeCert({ subject: 'CA', issuer: 'CA' }, 1)
    const leaf = await makeCert({ subject: 'Leaf', issuer: 'CA' }, 42)
    const revokedResp = await makeRevokedOcsp(leaf, issuer)
    expect(await ocspResponseRevoked(revokedResp, leaf, issuer)).toBe(true)
  })

  it('ocspResponseRevoked ignores a revoked entry about a DIFFERENT cert', async () => {
    // A shared/delegated responder's reply revokes a neighbor (serial 7); it says nothing about our
    // leaf (serial 42). Must not be read as revoking the leaf.
    const issuer = await makeCert({ subject: 'CA', issuer: 'CA' }, 1)
    const neighbor = await makeCert({ subject: 'Neighbor', issuer: 'CA' }, 7)
    const leaf = await makeCert({ subject: 'Leaf', issuer: 'CA' }, 42)
    const respAboutNeighbor = await makeRevokedOcsp(neighbor, issuer)
    expect(await ocspResponseRevoked(respAboutNeighbor, leaf, issuer)).toBe(false)
  })

  it('collectRevocation flags revoked when the OCSP responder says so', async () => {
    const issuer = await makeCert({ subject: 'CA', issuer: 'CA' }, 1)
    const leaf = await makeCert({ subject: 'Leaf', issuer: 'CA', ocsp: 'http://ocsp.test/' }, 42)
    const revokedResp = await makeRevokedOcsp(leaf, issuer)
    const fetcher: RevocationFetcher = {
      fetchOcsp: async () => revokedResp,
      fetchCrl: async () => null,
      fetchCaIssuers: async () => null
    }
    const out = await collectRevocation([leaf, issuer], fetcher)
    expect(out.revoked).toBe(true)
    expect(out.ocsps.length).toBe(1) // the proof is still collected, the caller decides to abort
  })

  it('collectRevocation flags revoked via a CRL fallback', async () => {
    const issuer = await makeCert({ subject: 'CA', issuer: 'CA' }, 1)
    const leaf = await makeCert({ subject: 'Leaf', issuer: 'CA', crl: 'http://crl.test/x.crl' }, 42)
    const crl = await makeRevokedCrl([42])
    const fetcher: RevocationFetcher = {
      fetchOcsp: async () => null,
      fetchCrl: async () => crl,
      fetchCaIssuers: async () => null
    }
    const out = await collectRevocation([leaf, issuer], fetcher)
    expect(out.revoked).toBe(true)
  })
})
