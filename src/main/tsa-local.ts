// A local in-process RFC3161 Timestamp Authority for tests/dev: a self-signed cert carrying the
// timeStamping EKU plus an issuer that mints valid TimeStampToken (ContentInfo) DER for a digest —
// so the signing tests never touch the network. Not used by the app (tree-shaken from the build).
import { webcrypto } from 'node:crypto'
import * as pkijs from 'pkijs'
import * as asn1js from 'asn1js'
import type { TokenIssuer } from './timestamp'

const SHA256_OID = '2.16.840.1.101.3.4.2.1'
const ID_SIGNED_DATA = '1.2.840.113549.1.7.2'
const ID_CT_TSTINFO = '1.2.840.113549.1.9.16.1.4'

export async function makeLocalTsa(): Promise<TokenIssuer> {
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
  cert.serialNumber = new asn1js.Integer({ value: 1 })
  const cn = new pkijs.AttributeTypeAndValue({
    type: '2.5.4.3',
    value: new asn1js.PrintableString({ value: 'Test TSA' })
  })
  cert.issuer.typesAndValues.push(cn)
  cert.subject.typesAndValues.push(cn)
  cert.notBefore.value = new Date(Date.now() - 3600_000)
  cert.notAfter.value = new Date(Date.now() + 365 * 24 * 3600_000)
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey)
  cert.extensions = [
    new pkijs.Extension({
      extnID: '2.5.29.37', // extKeyUsage
      critical: true,
      extnValue: new pkijs.ExtKeyUsage({ keyPurposes: ['1.3.6.1.5.5.7.3.8'] })
        .toSchema()
        .toBER(false)
    })
  ]
  await cert.sign(keys.privateKey, 'SHA-256')

  return async (digest) => {
    const tstInfo = new pkijs.TSTInfo({
      version: 1,
      policy: '1.2.3.4.1',
      messageImprint: new pkijs.MessageImprint({
        hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: SHA256_OID }),
        hashedMessage: new asn1js.OctetString({ valueHex: digest })
      }),
      serialNumber: new asn1js.Integer({ value: 42 }),
      genTime: new Date()
    })
    const sd = new pkijs.SignedData({
      version: 3,
      encapContentInfo: new pkijs.EncapsulatedContentInfo({
        eContentType: ID_CT_TSTINFO,
        eContent: new asn1js.OctetString({ valueHex: tstInfo.toSchema().toBER(false) })
      }),
      signerInfos: [
        new pkijs.SignerInfo({
          version: 1,
          sid: new pkijs.IssuerAndSerialNumber({
            issuer: cert.issuer,
            serialNumber: cert.serialNumber
          })
        })
      ],
      certificates: [cert]
    })
    await sd.sign(keys.privateKey, 0, 'SHA-256')
    const ci = new pkijs.ContentInfo({ contentType: ID_SIGNED_DATA, content: sd.toSchema() })
    return ci.toSchema().toBER(false)
  }
}
