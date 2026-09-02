import { describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray } from 'pdf-lib'

import { signPdf } from './sign'
import { addLtv } from './ltv'
import { type RevocationFetcher } from './revocation'
import {
  cannedFetcher,
  makeCert as makeTestCert,
  makeP12 as makeCredential,
  makePdf as makeTestPdf,
  makeRevokedCrl,
  makeRevokedOcsp,
  type CertOpts
} from './test-utils/fixtures'

const makeP12 = (passphrase: string): Uint8Array =>
  makeCredential(passphrase, { cn: 'LTV Signer' }).p12

const makePdf = (): Promise<Uint8Array> => makeTestPdf('LTV document')

// Every cert in this suite is issued with serial 7 (the leaf-only CRL case relies on it).
const makeCert = (opts: CertOpts): Promise<ArrayBuffer> => makeTestCert(opts, 7)

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

  it('aborts (throws) rather than embedding proof-of-revocation when the leaf is revoked', async () => {
    const signed = await signPdf(await makePdf(), makeP12('pw'), { passphrase: 'pw' })
    const ca = await makeCert({ subject: 'CA', issuer: 'CA' })
    const leaf = await makeCert({ subject: 'Leaf', issuer: 'CA', ocsp: 'http://ocsp.test/' })
    const revokedResp = await makeRevokedOcsp(leaf, ca)
    const revokedFetcher: RevocationFetcher = {
      fetchOcsp: async () => revokedResp,
      fetchCrl: async () => null,
      fetchCaIssuers: async () => null
    }
    await expect(addLtv(signed, leaf, [ca], revokedFetcher)).rejects.toThrow(/revoked/i)
  })

  it('aborts when a LEAF-ONLY chain is revoked by its CRL', async () => {
    // No chain candidates and no fetchable issuer, so completeChain returns just [leaf] — the case
    // that previously got no revocation check at all (card path, single-cert .p12).
    const signed = await signPdf(await makePdf(), makeP12('pw'), { passphrase: 'pw' })
    const leaf = await makeCert({ subject: 'Leaf', issuer: 'CA', crl: 'http://crl.test/x.crl' })
    const crl = await makeRevokedCrl([7], 'CA') // makeCert issues serial 7 under CN=CA
    const fetcher: RevocationFetcher = {
      fetchOcsp: async () => null,
      fetchCrl: async () => crl,
      fetchCaIssuers: async () => null
    }
    await expect(addLtv(signed, leaf, [], fetcher)).rejects.toThrow(/revoked/i)
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
