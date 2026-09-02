import { describe, expect, it } from 'vitest'

import { buildChain, completeChain, revocationPointers } from './cert-chain'
import { type RevocationFetcher } from './revocation'
import { makeCert } from './test-utils/fixtures'

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
