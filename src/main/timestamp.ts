// PAdES B-T: upgrade a B-B signature to Baseline-T by grafting an RFC3161 timestamp token onto the
// CMS signerInfo as the unsigned attribute id-aa-timeStampToken. The token is requested from a
// Timestamp Authority over the hash of the signer's signature value. Because unsigned attributes
// are excluded from the message digest and the signature (RFC5652 §5.4), the original B-B signature
// (and the PDF /ByteRange digest) stays valid. Runs in the main process. Token issuance is injected
// so tests use a local in-process TSA with no network.
import { webcrypto } from 'node:crypto'
import * as pkijs from 'pkijs'
import * as asn1js from 'asn1js'

// pkijs needs a WebCrypto engine or every digest/parse-with-crypto throws.
pkijs.setEngine('pdfx', new pkijs.CryptoEngine({ name: 'pdfx', crypto: webcrypto as Crypto }))

const ID_AA_TIMESTAMPTOKEN = '1.2.840.113549.1.9.16.2.14'
const ID_SIGNED_DATA = '1.2.840.113549.1.7.2'
const SHA256_OID = '2.16.840.1.101.3.4.2.1'

/** Issues an RFC3161 TimeStampToken (a CMS ContentInfo, DER) for a SHA-256 digest. */
export type TokenIssuer = (digest: ArrayBuffer) => Promise<ArrayBuffer>

function positiveNonce(): ArrayBuffer {
  const n = webcrypto.getRandomValues(new Uint8Array(16))
  n[0] &= 0x7f // keep the ASN.1 INTEGER positive
  return n.buffer
}

/** Real TSA client: POST an RFC3161 query and return the TimeStampToken (ContentInfo) DER. */
export function tsaIssuer(tsaUrl: string): TokenIssuer {
  let url: URL
  try {
    url = new URL(tsaUrl)
  } catch {
    throw new Error('Invalid timestamp authority URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Timestamp authority URL must use http or https')
  }
  return async (digest) => {
    const tsq = new pkijs.TimeStampReq({
      version: 1,
      messageImprint: new pkijs.MessageImprint({
        hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: SHA256_OID }),
        hashedMessage: new asn1js.OctetString({ valueHex: digest })
      }),
      certReq: true,
      nonce: new asn1js.Integer({ valueHex: positiveNonce() })
    })
    const reqDer = tsq.toSchema().toBER(false)
    const res = await fetch(tsaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query' },
      body: Buffer.from(reqDer),
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) throw new Error(`TSA HTTP ${res.status}`)
    const resp = new pkijs.TimeStampResp({
      schema: asn1js.fromBER(await res.arrayBuffer()).result
    })
    const status = resp.status.status
    if (status !== 0 && status !== 1) throw new Error(`TSA rejected the request (status ${status})`)
    if (!resp.timeStampToken) throw new Error('TSA returned no timestamp token')
    return resp.timeStampToken.toSchema().toBER(false)
  }
}

/**
 * Graft a signature timestamp onto a B-B CMS (DER), returning the B-T CMS (DER). The original
 * signed attributes and signature are re-emitted unchanged, so the signature stays valid.
 */
export async function addSignatureTimestamp(
  bbCmsDer: ArrayBuffer,
  getToken: TokenIssuer
): Promise<ArrayBuffer> {
  const ci = new pkijs.ContentInfo({ schema: asn1js.fromBER(bbCmsDer).result })
  const sd = new pkijs.SignedData({ schema: ci.content })
  const si = sd.signerInfos[0]
  // Hash the CONTENT bytes of the signature value (raw RSA bytes) — not the PDF or signed attrs.
  const sigBytes = si.signature.valueBlock.valueHexView
  const digest = await webcrypto.subtle.digest('SHA-256', sigBytes)
  const tokenDer = await getToken(digest)
  if (!si.unsignedAttrs) {
    si.unsignedAttrs = new pkijs.SignedAndUnsignedAttributes({ type: 1 }) // [1] IMPLICIT
  }
  si.unsignedAttrs.attributes.push(
    new pkijs.Attribute({ type: ID_AA_TIMESTAMPTOKEN, values: [asn1js.fromBER(tokenDer).result] })
  )
  const out = new pkijs.ContentInfo({ contentType: ID_SIGNED_DATA, content: sd.toSchema(true) })
  return out.toSchema().toBER(false)
}

export interface TimestampInfo {
  imprintOk: boolean
  signatureVerified: boolean
  genTime?: Date
}

/** Verify an embedded TimeStampToken: its imprint covers `sigBytes` and the token CMS is valid. */
export async function verifyTimestampToken(
  tokenDer: ArrayBuffer,
  sigBytes: ArrayBuffer
): Promise<TimestampInfo> {
  const ci = new pkijs.ContentInfo({ schema: asn1js.fromBER(tokenDer).result })
  const sd = new pkijs.SignedData({ schema: ci.content })
  const tstInfo = new pkijs.TSTInfo({ schema: asn1js.fromBER(eContentOf(sd)).result })
  const imprintOk = await tstInfo.verify({ data: sigBytes })
  let signatureVerified = false
  try {
    const result = await sd.verify({ signer: 0, checkChain: false, extendedMode: true })
    signatureVerified = result.signatureVerified ?? false
  } catch {
    signatureVerified = false // token CMS couldn't be checked here; imprint is the key property
  }
  return { imprintOk, signatureVerified, genTime: tstInfo.genTime }
}

/** Extract the encapsulated content bytes as a fresh ArrayBuffer (handles constructed OctetStrings
 *  and avoids the byteOffset trap of passing a Uint8Array view to fromBER). */
function eContentOf(sd: pkijs.SignedData): ArrayBuffer {
  const block = sd.encapContentInfo.eContent!.valueBlock as unknown as {
    isConstructed?: boolean
    value?: Array<{ valueBlock: { valueHexView: Uint8Array } }>
    valueHexView: Uint8Array
  }
  if (block.isConstructed && Array.isArray(block.value)) {
    const parts = block.value.map((p) => p.valueBlock.valueHexView)
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let off = 0
    for (const p of parts) {
      out.set(p, off)
      off += p.length
    }
    return out.buffer
  }
  return block.valueHexView.slice().buffer
}
