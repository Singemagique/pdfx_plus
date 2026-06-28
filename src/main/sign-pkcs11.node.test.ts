import { describe, expect, it } from 'vitest'
import { webcrypto } from 'node:crypto'
import * as pkijs from 'pkijs'
import * as asn1js from 'asn1js'

import { buildDetachedCms, type RawSigner } from './sign-pkcs11'

const ID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4'
const ID_SIGNING_CERTIFICATE_V2 = '1.2.840.113549.1.9.16.2.47'

// A software stand-in for a smart card: an RSA key + self-signed cert, and a RawSigner that signs
// with that key. The card path (PKCS#11) provides the same { certDer, rawSign } shape.
async function makeSoftCard(): Promise<{ certDer: ArrayBuffer; rawSign: RawSigner }> {
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
  const cn = new pkijs.AttributeTypeAndValue({
    type: '2.5.4.3',
    value: new asn1js.PrintableString({ value: 'Card Holder' })
  })
  cert.issuer.typesAndValues.push(cn)
  cert.subject.typesAndValues.push(cn)
  cert.notBefore.value = new Date(Date.now() - 3600_000)
  cert.notAfter.value = new Date(Date.now() + 365 * 24 * 3600_000)
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey)
  await cert.sign(keys.privateKey, 'SHA-256')
  const certDer = cert.toSchema().toBER(false)
  const rawSign: RawSigner = (data) =>
    webcrypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, keys.privateKey, data)
  return { certDer, rawSign }
}

describe('buildDetachedCms (smart-card / external key path)', () => {
  it("builds a CMS whose digest covers the content and verifies against the signer's cert", async () => {
    const { certDer, rawSign } = await makeSoftCard()
    const content = new TextEncoder().encode('the ByteRange bytes the card signs')
    const cms = await buildDetachedCms(certDer, content, rawSign)

    const ci = new pkijs.ContentInfo({ schema: asn1js.fromBER(cms).result })
    const sd = new pkijs.SignedData({ schema: ci.content })

    // The messageDigest signed attribute equals SHA-256 of the content.
    const expected = new Uint8Array(await webcrypto.subtle.digest('SHA-256', content))
    const mdAttr = sd.signerInfos[0].signedAttrs!.attributes.find(
      (a) => a.type === ID_MESSAGE_DIGEST
    )
    const md = new Uint8Array((mdAttr!.values[0] as asn1js.OctetString).valueBlock.valueHexView)
    expect(Buffer.from(md).toString('hex')).toBe(Buffer.from(expected).toString('hex'))

    // PAdES signing-certificate-v2 is present and binds the SHA-256 hash of the signer cert.
    const scAttr = sd.signerInfos[0].signedAttrs!.attributes.find(
      (a) => a.type === ID_SIGNING_CERTIFICATE_V2
    )
    expect(scAttr).toBeTruthy()
    const certHash = new Uint8Array(await webcrypto.subtle.digest('SHA-256', certDer))
    // SigningCertificateV2 → certs (SEQ OF) → ESSCertIDv2 (SEQ) → certHash (OCTET STRING).
    const sc = scAttr!.values[0] as asn1js.Sequence
    const essCertId = (sc.valueBlock.value[0] as asn1js.Sequence).valueBlock
      .value[0] as asn1js.Sequence
    const hashOctet = essCertId.valueBlock.value[0] as asn1js.OctetString
    expect(Buffer.from(new Uint8Array(hashOctet.valueBlock.valueHexView)).toString('hex')).toBe(
      Buffer.from(certHash).toString('hex')
    )

    // The detached signature verifies over the content using the embedded certificate.
    const result = await sd.verify({
      signer: 0,
      data: content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
      checkChain: false,
      extendedMode: true
    })
    expect(result.signatureVerified).toBe(true)
  })
})
