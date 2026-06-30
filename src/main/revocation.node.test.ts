import { describe, expect, it } from 'vitest'
import { webcrypto } from 'node:crypto'
import * as pkijs from 'pkijs'
import * as asn1js from 'asn1js'

import {
  buildOcspRequest,
  collectRevocation,
  isSuccessfulOcsp,
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
    const failing: RevocationFetcher = { fetchOcsp: async () => null, fetchCrl: async () => null }

    const out = await collectRevocation([leaf, ca], failing)
    expect(out).toEqual({ ocsps: [], crls: [] })
  })
})
