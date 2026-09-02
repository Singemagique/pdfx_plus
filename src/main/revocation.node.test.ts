import { afterEach, describe, expect, it, vi } from 'vitest'
import * as pkijs from 'pkijs'
import * as asn1js from 'asn1js'

import {
  buildOcspRequest,
  certFromCaIssuers,
  collectRevocation,
  crlRevokesCert,
  httpRevocationFetcher,
  isSuccessfulOcsp,
  ocspResponseRevoked,
  readCapped,
  type RevocationFetcher
} from './revocation'
import { makeCert, makeRevokedCrl, makeRevokedOcsp } from './test-utils/fixtures'

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

  // The chain's TOP cert has no issuer above it, so the pairwise loop can't cover it. Skipping it
  // outright left a chain that never reached a root (a card holding only the leaf, a single-cert
  // .p12) with zero revocation checks — a revoked cert would then sign with LTV claimed.
  it('CRL-checks a leaf-only chain, whose leaf is not a self-signed root', async () => {
    const leaf = await makeCert({ subject: 'Leaf', issuer: 'CA', crl: 'http://crl.test/x.crl' }, 42)
    const crl = await makeRevokedCrl([42])
    const fetcher: RevocationFetcher = {
      fetchOcsp: async () => null,
      fetchCrl: async () => crl,
      fetchCaIssuers: async () => null
    }

    const out = await collectRevocation([leaf], fetcher)
    expect(out.revoked).toBe(true)
    expect(out.crls.length).toBe(1)
  })

  it('CRL-checks a top intermediate when the chain stops short of a root', async () => {
    const leaf = await makeCert({ subject: 'Leaf', issuer: 'Int' }, 3)
    const int = await makeCert({ subject: 'Int', issuer: 'Root', crl: 'http://crl.test/i.crl' }, 9)
    const crl = await makeRevokedCrl([9], 'Root') // the CRL that Int's own issuer publishes
    const fetcher: RevocationFetcher = {
      fetchOcsp: async () => null,
      fetchCrl: async () => crl,
      fetchCaIssuers: async () => null
    }

    const out = await collectRevocation([leaf, int], fetcher)
    expect(out.revoked).toBe(true)
  })

  it('never fetches revocation for a self-signed root, even when it advertises a CDP', async () => {
    const leaf = await makeCert({ subject: 'Leaf', issuer: 'Root', crl: 'http://leaf.crl/' }, 3)
    const root = await makeCert({ subject: 'Root', issuer: 'Root', crl: 'http://root.crl/' }, 1)
    const fetcher = recordingFetcher()

    await collectRevocation([leaf, root], fetcher)
    expect(fetcher.crlUrls).toEqual(['http://leaf.crl/']) // the root's CDP is never touched
  })

  it('fetches nothing for a lone self-signed certificate (a self-issued .p12 leaf)', async () => {
    const self = await makeCert({ subject: 'Solo', issuer: 'Solo', crl: 'http://solo.crl/' }, 1)
    const fetcher = recordingFetcher()

    const out = await collectRevocation([self], fetcher)
    expect(fetcher.crlUrls).toEqual([])
    expect(out).toEqual({ ocsps: [], crls: [], revoked: false })
  })
})

describe('readCapped (P2-5 size cap)', () => {
  it('returns the body when within the cap', async () => {
    const out = await readCapped(new Response(new Uint8Array([1, 2, 3, 4])), 1024)
    expect(out && Array.from(out)).toEqual([1, 2, 3, 4])
  })

  it('rejects (null) a body that exceeds the cap', async () => {
    const out = await readCapped(new Response(new Uint8Array(2048)), 1024)
    expect(out).toBeNull()
  })

  it('rejects up front on an oversized Content-Length', async () => {
    const res = new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-length': '999999999' }
    })
    expect(await readCapped(res, 1024)).toBeNull()
  })
})

describe('httpRevocationFetcher', () => {
  afterEach(() => vi.unstubAllGlobals())

  // Answer every fetch with one canned Response; returns the URLs that were requested.
  function stubFetch(make: () => Response): string[] {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      return make()
    })
    return urls
  }

  const OCSP_OK = new Uint8Array([0x30, 0x03, 0x0a, 0x01, 0x00]) // responseStatus successful
  const OCSP_TRY_LATER = new Uint8Array([0x30, 0x03, 0x0a, 0x01, 0x03])

  async function ocspPair(): Promise<{ cert: ArrayBuffer; issuer: ArrayBuffer }> {
    const issuer = await makeCert({ subject: 'CA', issuer: 'CA' }, 1)
    const cert = await makeCert({ subject: 'Leaf', issuer: 'CA' }, 42)
    return { cert, issuer }
  }

  it('fetchOcsp POSTs the OCSP request and keeps a successful response', async () => {
    const { cert, issuer } = await ocspPair()
    const urls = stubFetch(() => new Response(OCSP_OK))
    const out = await httpRevocationFetcher().fetchOcsp(cert, issuer, 'http://ocsp.test/')
    expect(out && Array.from(out)).toEqual(Array.from(OCSP_OK))
    expect(urls).toEqual(['http://ocsp.test/'])
  })

  it('fetchOcsp returns null on a non-OK HTTP status', async () => {
    const { cert, issuer } = await ocspPair()
    stubFetch(() => new Response(OCSP_OK, { status: 500 }))
    expect(await httpRevocationFetcher().fetchOcsp(cert, issuer, 'http://ocsp.test/')).toBeNull()
  })

  it('fetchOcsp discards a parseable but UNSUCCESSFUL OCSPResponse (tryLater)', async () => {
    // An error OCSPResponse carries no revocation information — embedding it in the DSS would claim
    // validation data we never obtained.
    const { cert, issuer } = await ocspPair()
    stubFetch(() => new Response(OCSP_TRY_LATER))
    expect(await httpRevocationFetcher().fetchOcsp(cert, issuer, 'http://ocsp.test/')).toBeNull()
  })

  it('fetchCrl decodes a PEM-wrapped CRL to DER', async () => {
    const der = await makeRevokedCrl([42])
    const pem = `-----BEGIN X509 CRL-----\n${Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END X509 CRL-----\n` // prettier-ignore
    stubFetch(() => new Response(Buffer.from(pem, 'latin1')))

    const out = await httpRevocationFetcher().fetchCrl('http://crl.test/x.crl')
    expect(out).not.toBeNull()
    expect(Buffer.from(out!).equals(Buffer.from(der))).toBe(true)
  })

  it('fetchCrl returns null on a non-OK HTTP status', async () => {
    stubFetch(() => new Response(new Uint8Array([0x30, 0x00]), { status: 404 }))
    expect(await httpRevocationFetcher().fetchCrl('http://crl.test/x.crl')).toBeNull()
  })

  it('caps OCSP well below CRL: a 600 KiB body is refused as OCSP but accepted as a CRL', async () => {
    // Trailing zeros after the DER value still parse as a successful OCSPResponse, so only the size
    // cap can reject this body.
    const { cert, issuer } = await ocspPair()
    const big = Buffer.concat([Buffer.from(OCSP_OK), Buffer.alloc(600 * 1024)])
    stubFetch(() => new Response(new Uint8Array(big)))

    expect(await httpRevocationFetcher().fetchOcsp(cert, issuer, 'http://ocsp.test/')).toBeNull()
    expect(await httpRevocationFetcher().fetchCrl('http://crl.test/x.crl')).not.toBeNull()
  })

  it('fetchCrl refuses a body whose declared size exceeds the CRL cap', async () => {
    const der = await makeRevokedCrl([42])
    const oversized = { headers: { 'content-length': '20000000' } } // 20 MB; the CRL cap is 16 MiB
    stubFetch(() => new Response(new Uint8Array(der), oversized))
    expect(await httpRevocationFetcher().fetchCrl('http://crl.test/x.crl')).toBeNull()
  })

  it('fetchCaIssuers returns the certificate, but refuses one over the AIA cap', async () => {
    const cert = await makeCert({ subject: 'Issuing CA', issuer: 'Issuing CA' })
    stubFetch(() => new Response(cert))
    expect(await httpRevocationFetcher().fetchCaIssuers('http://aia.test/ca.cer')).not.toBeNull()

    stubFetch(() => new Response(cert, { headers: { 'content-length': '2000000' } })) // > 1 MiB
    expect(await httpRevocationFetcher().fetchCaIssuers('http://aia.test/ca.cer')).toBeNull()
  })

  it('returns null instead of throwing when the request itself fails', async () => {
    const { cert, issuer } = await ocspPair()
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down')
    })
    const f = httpRevocationFetcher()
    expect(await f.fetchOcsp(cert, issuer, 'http://ocsp.test/')).toBeNull()
    expect(await f.fetchCrl('http://crl.test/x.crl')).toBeNull()
    expect(await f.fetchCaIssuers('http://aia.test/ca.cer')).toBeNull()
  })
})

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
