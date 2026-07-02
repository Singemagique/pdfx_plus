// PAdES B-B signing. Runs in the MAIN process: @signpdf + node-forge are Node libraries (Buffer,
// JS crypto), and keeping the PKCS#12 credential / passphrase out of the renderer is also safer.
// Adds an ETSI.CAdES.detached signature placeholder, then signs with the .p12. See the
// signpdf-pades-api memory note for the flow + gotchas.
import { PDFDocument } from 'pdf-lib'
import { SignPdf } from '@signpdf/signpdf'
import { plainAddPlaceholder } from '@signpdf/placeholder-plain'
import { SUBFILTER_ETSI_CADES_DETACHED, Signer } from '@signpdf/utils'
import { addSignatureTimestamp, tsaIssuer, type TokenIssuer } from './timestamp'
import { CmsSigner } from './sign-pkcs11'
import { p12ToCredential } from './p12'
import { openCard, type Pkcs11Options } from './pkcs11'
import { windowsCertCredential, windowsCertChain } from './windows-cert'
import { addLtv } from './ltv'
import { addDocTimeStamp } from './doc-timestamp'
import { type RevocationFetcher } from './revocation'

export interface SignOptions {
  /** PKCS#12 passphrase (empty string if the credential has none). */
  passphrase?: string
  reason?: string
  name?: string
  location?: string
  contactInfo?: string
  /** RFC3161 Timestamp Authority URL. When set, the signature is upgraded to PAdES B-T. */
  tsaUrl?: string
  /** When true, embed a DSS (cert chain + OCSP/CRL) for long-term validation (PAdES B-LT). */
  ltv?: boolean
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

// After embedding the DSS (B-LT), add a document-level archive timestamp (B-LTA) when a TSA is
// configured — it anchors the signature + DSS to a trusted time. Reuses the same injectable token
// issuer as the B-T signature timestamp, so a missing TSA simply leaves the result at B-LT.
async function archiveTimestamp(
  ltvBytes: Uint8Array,
  opts: SignOptions,
  getToken?: TokenIssuer
): Promise<Uint8Array> {
  if (!opts.tsaUrl) return ltvBytes
  try {
    return await addDocTimeStamp(ltvBytes, getToken ?? tsaIssuer(opts.tsaUrl))
  } catch (e) {
    // ltvBytes is already a complete, valid B-LT signature. If ONLY the archive step fails (a network
    // flake on the second TSA round-trip, or a token larger than the placeholder), return the B-LT
    // rather than discarding a good signature by letting the whole sign reject (audit P1-7).
    console.warn('pdfx: archive timestamp (B-LTA) failed; returning B-LT', e)
    return ltvBytes
  }
}

/** Add the signing placeholder, then run @signpdf with `signer`, returning signed PDF bytes.
 *  `bundledCerts` is how many certificates the CMS will embed (1 = signer only); a chain enlarges
 *  the signature, so the placeholder must grow to fit it. */
async function placeAndSign(
  bytes: Uint8Array,
  signer: Signer,
  opts: SignOptions,
  bundledCerts = 1
): Promise<Uint8Array> {
  // @signpdf/placeholder-plain parses a classic xref TABLE, so re-save without xref streams.
  const doc = await PDFDocument.load(bytes)
  const flat = await doc.save({ useObjectStreams: false })
  // Size the /Contents placeholder to the largest CMS we might produce: a timestamp token + TSA cert
  // chain needs the most room; a bundled signer-cert chain (the .p12 path) also exceeds the 8192-byte
  // default. Over-sizing only pads /Contents with zeros, so err large.
  const signatureLength = opts.tsaUrl ? 32768 : bundledCerts > 1 ? 16384 : undefined
  const withPlaceholder = plainAddPlaceholder({
    pdfBuffer: Buffer.from(flat),
    reason: opts.reason ?? 'Signed with PDFx',
    contactInfo: opts.contactInfo ?? '',
    name: opts.name ?? '',
    location: opts.location ?? '',
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
    ...(signatureLength ? { signatureLength } : {})
  })
  const signed = await new SignPdf().sign(withPlaceholder, signer)
  return new Uint8Array(signed)
}

/**
 * Sign `bytes` with a PKCS#12 (.p12) credential, returning PAdES-B-B-signed PDF bytes. Throws if
 * the credential/passphrase is wrong or the PDF can't be prepared, so callers never get a
 * half-signed file. Routes through the in-house CmsSigner (not @signpdf's P12Signer) so the .p12
 * signature carries the PAdES signing-certificate-v2 attribute, matching the card/Windows paths.
 */
export async function signPdf(
  bytes: Uint8Array,
  p12: Uint8Array,
  opts: SignOptions = {},
  // Injectable token issuer (defaults to the real TSA client) so tests run a local TSA offline.
  getToken?: TokenIssuer,
  // Injectable revocation fetcher (defaults to the real HTTP client) so LTV tests run offline.
  fetcher?: RevocationFetcher
): Promise<Uint8Array> {
  const cred = p12ToCredential(p12, opts.passphrase ?? '')
  const base: Signer = new CmsSigner(cred.certDer, cred.rawSign, cred.chainDer)
  const signer = opts.tsaUrl
    ? new TimestampingSigner(base, getToken ?? tsaIssuer(opts.tsaUrl))
    : base
  const signed = await placeAndSign(bytes, signer, opts, 1 + cred.chainDer.length)
  if (!opts.ltv) return signed
  // The PKCS#12 bag carries the chain, so LTV needs no network for certs — only revocation.
  const ltv = await addLtv(signed, cred.certDer, cred.chainDer, fetcher)
  return archiveTimestamp(ltv, opts, getToken)
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
  getToken?: TokenIssuer,
  fetcher?: RevocationFetcher
): Promise<Uint8Array> {
  const card = openCard(pkcs11)
  try {
    const base: Signer = new CmsSigner(card.certDer, card.rawSign)
    const signer = opts.tsaUrl
      ? new TimestampingSigner(base, getToken ?? tsaIssuer(opts.tsaUrl))
      : base
    const signed = await placeAndSign(bytes, signer, opts)
    if (!opts.ltv) return signed
    // The card holds only the leaf; addLtv completes the chain via AIA caIssuers.
    const ltv = await addLtv(signed, card.certDer, [], fetcher)
    return await archiveTimestamp(ltv, opts, getToken)
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
  getToken?: TokenIssuer,
  fetcher?: RevocationFetcher
): Promise<Uint8Array> {
  const cred = await windowsCertCredential(thumbprint)
  const base: Signer = new CmsSigner(cred.certDer, cred.rawSign)
  const signer = opts.tsaUrl
    ? new TimestampingSigner(base, getToken ?? tsaIssuer(opts.tsaUrl))
    : base
  const signed = await placeAndSign(bytes, signer, opts)
  if (!opts.ltv) return signed
  // Harvest the issuer chain from the Windows store (best-effort: leaf-only DSS if it can't be read)
  // for the DSS. windowsCertChain returns [leaf, …issuers]; pass the issuers as chain candidates.
  const chain = await windowsCertChain(thumbprint).catch(() => [])
  const ltv = await addLtv(signed, cred.certDer, chain.slice(1), fetcher)
  return archiveTimestamp(ltv, opts, getToken)
}
