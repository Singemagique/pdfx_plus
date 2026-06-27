import { describe, expect, it, beforeAll } from 'vitest'
import forge from 'node-forge'
import * as pkijs from 'pkijs'
import * as asn1js from 'asn1js'

import { addSignatureTimestamp, verifyTimestampToken, type TokenIssuer } from './timestamp'
import { makeLocalTsa } from './tsa-local'

const ID_AA_TIMESTAMPTOKEN = '1.2.840.113549.1.9.16.2.14'

// A minimal B-B detached CMS (as @signpdf/signer-p12 produces) over some bytes.
function makeBbCms(): ArrayBuffer {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600_000)
  const attrs = [{ name: 'commonName', value: 'BB Signer' }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const p7 = forge.pkcs7.createSignedData()
  p7.content = forge.util.createBuffer('the signed document bytes', 'utf8')
  p7.addCertificate(cert)
  p7.addSigner({
    key: keys.privateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date().toString() }
    ]
  })
  p7.sign({ detached: true })
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes()
  const u8 = Uint8Array.from(der, (c) => c.charCodeAt(0))
  return u8.buffer
}

let issue: TokenIssuer

beforeAll(async () => {
  issue = await makeLocalTsa()
})

// Read signerInfo[0].signature value + the signedAttrs DER from a CMS (for the regression guard).
function readSigner(cmsDer: ArrayBuffer): {
  sig: string
  signedAttrs: string
  unsignedCount: number
} {
  const ci = new pkijs.ContentInfo({ schema: asn1js.fromBER(cmsDer).result })
  const sd = new pkijs.SignedData({ schema: ci.content })
  const si = sd.signerInfos[0]
  const hex = (v: Uint8Array): string => Buffer.from(v).toString('hex')
  return {
    sig: hex(si.signature.valueBlock.valueHexView),
    signedAttrs: hex(new Uint8Array(si.signedAttrs!.toSchema().toBER(false))),
    unsignedCount: si.unsignedAttrs?.attributes.length ?? 0
  }
}

describe('addSignatureTimestamp (PAdES B-T)', () => {
  it('grafts a timestamp token without disturbing the original signature', async () => {
    const bb = makeBbCms()
    const before = readSigner(bb)
    const bt = await addSignatureTimestamp(bb, issue)
    const after = readSigner(bt)

    // The original signed bytes are untouched (the guard that proves B-B stays valid).
    expect(after.sig).toBe(before.sig)
    expect(after.signedAttrs).toBe(before.signedAttrs)
    // Exactly one unsigned attr was added: the timestamp token.
    expect(before.unsignedCount).toBe(0)
    expect(after.unsignedCount).toBe(1)
    const ci = new pkijs.ContentInfo({ schema: asn1js.fromBER(bt).result })
    const sd = new pkijs.SignedData({ schema: ci.content })
    expect(sd.signerInfos[0].unsignedAttrs!.attributes[0].type).toBe(ID_AA_TIMESTAMPTOKEN)
  })

  it('the embedded token timestamps the signature value (imprint covers the right bytes)', async () => {
    const bb = makeBbCms()
    const sigBytes = (() => {
      const ci = new pkijs.ContentInfo({ schema: asn1js.fromBER(bb).result })
      const sd = new pkijs.SignedData({ schema: ci.content })
      return sd.signerInfos[0].signature.valueBlock.valueHexView.slice()
    })()
    const bt = await addSignatureTimestamp(bb, issue)
    const ci = new pkijs.ContentInfo({ schema: asn1js.fromBER(bt).result })
    const sd = new pkijs.SignedData({ schema: ci.content })
    const tokenDer = (
      sd.signerInfos[0].unsignedAttrs!.attributes[0].values[0] as asn1js.Sequence
    ).toBER(false)

    const okView = await verifyTimestampToken(
      tokenDer,
      sigBytes.buffer.slice(sigBytes.byteOffset, sigBytes.byteOffset + sigBytes.byteLength)
    )
    // The critical property: the token's imprint covers the signature value (the #1 pitfall).
    expect(okView.imprintOk).toBe(true)
    expect(okView.genTime).toBeInstanceOf(Date)

    // Negative: the imprint must NOT match a different byte string.
    const wrong = await verifyTimestampToken(
      tokenDer,
      new TextEncoder().encode('not the signature').buffer
    )
    expect(wrong.imprintOk).toBe(false)
  })

  it('fails closed when the issuer rejects', async () => {
    const bb = makeBbCms()
    const failing: TokenIssuer = async () => {
      throw new Error('TSA rejected the request (status 2)')
    }
    await expect(addSignatureTimestamp(bb, failing)).rejects.toThrow(/TSA rejected/)
  })
})
