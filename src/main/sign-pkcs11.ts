// Build a detached CMS SignedData where the actual signing of the signed attributes is delegated to
// an arbitrary RawSigner — so the private key can live anywhere (a smart card via PKCS#11, an HSM,
// or a software key in tests). The CMS structure is built with pkijs; only the RSA signature over
// the signed-attributes SET is produced by the injected signer. Runs in the main process.
import { webcrypto } from 'node:crypto'
import * as pkijs from 'pkijs'
import * as asn1js from 'asn1js'
import { Signer } from '@signpdf/utils'
import './pkijs-engine'

const ID_DATA = '1.2.840.113549.1.7.1'
const ID_SIGNED_DATA = '1.2.840.113549.1.7.2'
const SHA256_OID = '2.16.840.1.101.3.4.2.1'
const SHA256_RSA_OID = '1.2.840.113549.1.1.11' // sha256WithRSAEncryption
const ID_CONTENT_TYPE = '1.2.840.113549.1.9.3'
const ID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4'
const ID_SIGNING_TIME = '1.2.840.113549.1.9.5'
const ID_SIGNING_CERTIFICATE_V2 = '1.2.840.113549.1.9.16.2.47'

/** Produce an RSASSA-PKCS1-v1_5 (SHA-256) signature over `data`. */
export type RawSigner = (data: ArrayBuffer) => Promise<ArrayBuffer>

/** Build a detached CMS SignedData over `content`, signing the signed attributes with `sign`.
 *  `chainDer` are any additional (intermediate/root) certificates to bundle alongside the signer
 *  cert — included in SignedData.certificates to help validators build the path. */
export async function buildDetachedCms(
  certDer: ArrayBuffer,
  content: Uint8Array,
  sign: RawSigner,
  signingTime = new Date(),
  chainDer: ArrayBuffer[] = []
): Promise<ArrayBuffer> {
  const cert = new pkijs.Certificate({ schema: asn1js.fromBER(certDer).result })
  const chainCerts = chainDer.map(
    (der) => new pkijs.Certificate({ schema: asn1js.fromBER(der).result })
  )
  const digest = await webcrypto.subtle.digest('SHA-256', content as unknown as BufferSource)
  // PAdES/CAdES requires signing-certificate-v2: bind the signer cert by its hash so the signature
  // can't be re-attributed to a different certificate. SHA-256 is the DEFAULT ESSCertIDv2
  // hashAlgorithm, so it's omitted; we include only certHash (RFC 5035).
  const certHash = await webcrypto.subtle.digest('SHA-256', certDer)
  const signingCertificateV2 = new asn1js.Sequence({
    value: [
      new asn1js.Sequence({
        // certs SEQUENCE OF ESSCertIDv2
        value: [new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: certHash })] })]
      })
    ]
  })

  const attrs = [
    new pkijs.Attribute({
      type: ID_CONTENT_TYPE,
      values: [new asn1js.ObjectIdentifier({ value: ID_DATA })]
    }),
    new pkijs.Attribute({
      type: ID_SIGNING_TIME,
      values: [new asn1js.UTCTime({ valueDate: signingTime })]
    }),
    new pkijs.Attribute({
      type: ID_MESSAGE_DIGEST,
      values: [new asn1js.OctetString({ valueHex: digest })]
    }),
    new pkijs.Attribute({ type: ID_SIGNING_CERTIFICATE_V2, values: [signingCertificateV2] })
  ]

  // The signature is computed over the signed attributes encoded as an explicit SET (tag 0x31).
  const toSign = new asn1js.Set({ value: attrs.map((a) => a.toSchema()) }).toBER(false)
  const signature = await sign(toSign)

  const sha256Alg = (): pkijs.AlgorithmIdentifier =>
    new pkijs.AlgorithmIdentifier({ algorithmId: SHA256_OID, algorithmParams: new asn1js.Null() })

  const signerInfo = new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
    digestAlgorithm: sha256Alg(),
    signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes: attrs }),
    signatureAlgorithm: new pkijs.AlgorithmIdentifier({
      algorithmId: SHA256_RSA_OID,
      algorithmParams: new asn1js.Null()
    }),
    signature: new asn1js.OctetString({ valueHex: signature })
  })

  const sd = new pkijs.SignedData({
    version: 1,
    digestAlgorithms: [sha256Alg()],
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: ID_DATA }), // detached
    certificates: [cert, ...chainCerts],
    signerInfos: [signerInfo]
  })
  const ci = new pkijs.ContentInfo({ contentType: ID_SIGNED_DATA, content: sd.toSchema() })
  return ci.toSchema().toBER(false)
}

/** A @signpdf Signer that detaches CMS over the ByteRange content via a RawSigner. `chainDer` are
 *  optional intermediate/root certs to bundle (the .p12 path passes the certs from its bag). */
export class CmsSigner extends Signer {
  constructor(
    private readonly certDer: ArrayBuffer,
    private readonly rawSign: RawSigner,
    private readonly chainDer: ArrayBuffer[] = []
  ) {
    super()
  }
  async sign(pdfBuffer: Buffer, signingTime?: Date): Promise<Buffer> {
    const cms = await buildDetachedCms(
      this.certDer,
      new Uint8Array(pdfBuffer),
      this.rawSign,
      signingTime,
      this.chainDer
    )
    return Buffer.from(cms)
  }
}
