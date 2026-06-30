import { describe, expect, it } from 'vitest'
import { webcrypto } from 'node:crypto'
import * as pkijs from 'pkijs'
import * as asn1js from 'asn1js'

import { buildChain, completeChain, revocationPointers } from './cert-chain'
import { type RevocationFetcher } from './revocation'

interface CertOpts {
  subject: string
  issuer: string
  ocsp?: string
  caIssuers?: string
  crl?: string
}

// Build a DER X.509 cert (RSA, self-signed for simplicity) with optional AIA + CDP extensions, via
// pkijs — the same library cert-chain.ts parses with, so the extensions round-trip faithfully.
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

describe('revocationPointers', () => {
  it('extracts OCSP, caIssuers and CRL URLs from a certificate', async () => {
    const der = await makeCert({
      subject: 'Leaf',
      issuer: 'Issuing CA',
      ocsp: 'http://ocsp.example.mil/',
      caIssuers: 'http://aia.example.mil/ca.cer',
      crl: 'http://crl.example.mil/ca.crl'
    })
    expect(revocationPointers(der)).toEqual({
      ocsp: ['http://ocsp.example.mil/'],
      caIssuers: ['http://aia.example.mil/ca.cer'],
      crl: ['http://crl.example.mil/ca.crl']
    })
  })

  it('returns empty arrays for a certificate with no AIA/CDP extensions', async () => {
    const der = await makeCert({ subject: 'Bare', issuer: 'Bare' })
    expect(revocationPointers(der)).toEqual({ ocsp: [], caIssuers: [], crl: [] })
  })

  it('never throws on malformed certificate bytes', () => {
    expect(revocationPointers(new Uint8Array([1, 2, 3, 4]).buffer)).toEqual({
      ocsp: [],
      caIssuers: [],
      crl: []
    })
  })
})

describe('buildChain', () => {
  it('orders leaf → intermediate → root and stops at the self-signed root', async () => {
    const root = await makeCert({ subject: 'Root CA', issuer: 'Root CA' }, 1)
    const intermediate = await makeCert({ subject: 'Int CA', issuer: 'Root CA' }, 2)
    const leaf = await makeCert({ subject: 'Leaf', issuer: 'Int CA' }, 3)
    // Candidates supplied out of order; buildChain must still order them correctly.
    const chain = buildChain(leaf, [root, intermediate])
    expect(chain).toEqual([leaf, intermediate, root])
  })

  it('stops at the first gap when an issuer is missing from the candidates', async () => {
    const intermediate = await makeCert({ subject: 'Int CA', issuer: 'Root CA' }, 2)
    const leaf = await makeCert({ subject: 'Leaf', issuer: 'Int CA' }, 3)
    // Root absent → chain ends at the intermediate.
    expect(buildChain(leaf, [intermediate])).toEqual([leaf, intermediate])
  })

  it('returns just the leaf when no issuer is found', async () => {
    const leaf = await makeCert({ subject: 'Leaf', issuer: 'Unknown CA' }, 3)
    const unrelated = await makeCert({ subject: 'Other', issuer: 'Other' }, 9)
    expect(buildChain(leaf, [unrelated])).toEqual([leaf])
  })
})

describe('completeChain', () => {
  // A fetcher that serves issuer certs by AIA URL and nothing else.
  function caFetcher(byUrl: Record<string, ArrayBuffer>): RevocationFetcher {
    return {
      fetchOcsp: async () => null,
      fetchCrl: async () => null,
      fetchCaIssuers: async (url) => (byUrl[url] ? new Uint8Array(byUrl[url]) : null)
    }
  }

  it('fetches missing issuers via AIA caIssuers up to a self-signed root', async () => {
    const root = await makeCert({ subject: 'Root', issuer: 'Root' }, 1)
    const int = await makeCert(
      { subject: 'Int', issuer: 'Root', caIssuers: 'http://aia/root.cer' },
      2
    )
    const leaf = await makeCert(
      { subject: 'Leaf', issuer: 'Int', caIssuers: 'http://aia/int.cer' },
      3
    )
    // Card-style: only the leaf is known; the rest is fetched via AIA.
    const chain = await completeChain(
      leaf,
      [],
      caFetcher({ 'http://aia/int.cer': int, 'http://aia/root.cer': root })
    )
    expect(chain).toEqual([leaf, int, root])
  })

  it('stops at the leaf when the issuer cannot be fetched', async () => {
    const leaf = await makeCert(
      { subject: 'Leaf', issuer: 'Int', caIssuers: 'http://aia/int.cer' },
      3
    )
    expect(await completeChain(leaf, [], caFetcher({}))).toEqual([leaf])
  })

  it('does not fetch when the chain already reaches a self-signed root', async () => {
    const root = await makeCert({ subject: 'Root', issuer: 'Root' }, 1)
    let calls = 0
    const fetcher: RevocationFetcher = {
      fetchOcsp: async () => null,
      fetchCrl: async () => null,
      fetchCaIssuers: async () => {
        calls++
        return null
      }
    }
    expect(await completeChain(root, [], fetcher)).toEqual([root])
    expect(calls).toBe(0)
  })
})
