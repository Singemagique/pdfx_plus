// PAdES B-B signing. Runs in the MAIN process: @signpdf + node-forge are Node libraries (Buffer,
// JS crypto), and keeping the PKCS#12 credential / passphrase out of the renderer is also safer.
// Adds an ETSI.CAdES.detached signature placeholder, then signs with the .p12. See the
// signpdf-pades-api memory note for the flow + gotchas.
import { PDFDocument } from 'pdf-lib'
import { SignPdf } from '@signpdf/signpdf'
import { P12Signer } from '@signpdf/signer-p12'
import { plainAddPlaceholder } from '@signpdf/placeholder-plain'
import { SUBFILTER_ETSI_CADES_DETACHED, Signer } from '@signpdf/utils'
import { addSignatureTimestamp, tsaIssuer, type TokenIssuer } from './timestamp'
import { CmsSigner } from './sign-pkcs11'
import { openCard, type Pkcs11Options } from './pkcs11'
import { windowsCertCredential } from './windows-cert'

export interface SignOptions {
  /** PKCS#12 passphrase (empty string if the credential has none). */
  passphrase?: string
  reason?: string
  name?: string
  location?: string
  contactInfo?: string
  /** RFC3161 Timestamp Authority URL. When set, the signature is upgraded to PAdES B-T. */
  tsaUrl?: string
}

/** Wrap any signer so it grafts an RFC3161 signature timestamp onto its CMS (B-B → B-T). Extends the
 *  @signpdf Signer base because SignPdf.sign rejects anything that isn't an `instanceof Signer`. */
class TimestampingSigner extends Signer {
  constructor(
    private readonly inner: Signer,
    private readonly getToken: TokenIssuer
  ) {
    super()
  }
  async sign(pdfBuffer: Buffer, signingTime?: Date): Promise<Buffer> {
    const bb = new Uint8Array(await this.inner.sign(pdfBuffer, signingTime))
    const bt = await addSignatureTimestamp(
      bb.buffer.slice(bb.byteOffset, bb.byteOffset + bb.byteLength),
      this.getToken
    )
    return Buffer.from(bt)
  }
}

/** Add the signing placeholder, then run @signpdf with `signer`, returning signed PDF bytes. */
async function placeAndSign(
  bytes: Uint8Array,
  signer: Signer,
  opts: SignOptions
): Promise<Uint8Array> {
  // @signpdf/placeholder-plain parses a classic xref TABLE, so re-save without xref streams.
  const doc = await PDFDocument.load(bytes)
  const flat = await doc.save({ useObjectStreams: false })
  const withPlaceholder = plainAddPlaceholder({
    pdfBuffer: Buffer.from(flat),
    reason: opts.reason ?? 'Signed with PDFx',
    contactInfo: opts.contactInfo ?? '',
    name: opts.name ?? '',
    location: opts.location ?? '',
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
    // A timestamp token + TSA cert chain needs more room than the default 8192-byte placeholder.
    ...(opts.tsaUrl ? { signatureLength: 32768 } : {})
  })
  const signed = await new SignPdf().sign(withPlaceholder, signer)
  return new Uint8Array(signed)
}

/**
 * Sign `bytes` with a PKCS#12 (.p12) credential, returning PAdES-B-B-signed PDF bytes. Throws if
 * the credential/passphrase is wrong or the PDF can't be prepared, so callers never get a
 * half-signed file.
 */
export async function signPdf(
  bytes: Uint8Array,
  p12: Uint8Array,
  opts: SignOptions = {},
  // Injectable token issuer (defaults to the real TSA client) so tests run a local TSA offline.
  getToken?: TokenIssuer
): Promise<Uint8Array> {
  const base: Signer = new P12Signer(Buffer.from(p12), { passphrase: opts.passphrase ?? '' })
  const signer = opts.tsaUrl
    ? new TimestampingSigner(base, getToken ?? tsaIssuer(opts.tsaUrl))
    : base
  return placeAndSign(bytes, signer, opts)
}

/**
 * Sign `bytes` with a smart card / HSM via PKCS#11. The private key never leaves the token: only the
 * CMS signed attributes are sent to the card for an RSASSA-PKCS1-v1_5 (SHA-256) signature. Throws
 * (without producing a file) if the module can't be loaded, the PIN is wrong, or no usable
 * certificate/key pair is found.
 */
export async function signPdfWithCard(
  bytes: Uint8Array,
  pkcs11: Pkcs11Options,
  opts: SignOptions = {},
  getToken?: TokenIssuer
): Promise<Uint8Array> {
  const card = openCard(pkcs11)
  try {
    const base: Signer = new CmsSigner(card.certDer, card.rawSign)
    const signer = opts.tsaUrl
      ? new TimestampingSigner(base, getToken ?? tsaIssuer(opts.tsaUrl))
      : base
    return await placeAndSign(bytes, signer, opts)
  } finally {
    card.close()
  }
}

/**
 * Sign `bytes` with a certificate from the Windows certificate store (Windows only). The key may
 * live on a smart card (CAC/PIV) — Windows shows its own PIN prompt and performs the signature, so
 * no PKCS#11 module is needed. Throws (without producing a file) if the cert can't be used.
 */
export async function signPdfWithWindowsCert(
  bytes: Uint8Array,
  thumbprint: string,
  opts: SignOptions = {},
  getToken?: TokenIssuer
): Promise<Uint8Array> {
  const cred = await windowsCertCredential(thumbprint)
  const base: Signer = new CmsSigner(cred.certDer, cred.rawSign)
  const signer = opts.tsaUrl
    ? new TimestampingSigner(base, getToken ?? tsaIssuer(opts.tsaUrl))
    : base
  return placeAndSign(bytes, signer, opts)
}
