// PAdES B-B signing. Runs in the MAIN process: @signpdf + node-forge are Node libraries (Buffer,
// JS crypto), and keeping the PKCS#12 credential / passphrase out of the renderer is also safer.
// Adds an ETSI.CAdES.detached signature placeholder, then signs with the .p12. See the
// signpdf-pades-api memory note for the flow + gotchas.
import { PDFDocument } from 'pdf-lib'
import { SignPdf } from '@signpdf/signpdf'
import { P12Signer } from '@signpdf/signer-p12'
import { plainAddPlaceholder } from '@signpdf/placeholder-plain'
import { SUBFILTER_ETSI_CADES_DETACHED } from '@signpdf/utils'

export interface SignOptions {
  /** PKCS#12 passphrase (empty string if the credential has none). */
  passphrase?: string
  reason?: string
  name?: string
  location?: string
  contactInfo?: string
}

/**
 * Sign `bytes` with a PKCS#12 (.p12) credential, returning PAdES-B-B-signed PDF bytes. Throws if
 * the credential/passphrase is wrong or the PDF can't be prepared, so callers never get a
 * half-signed file.
 */
export async function signPdf(
  bytes: Uint8Array,
  p12: Uint8Array,
  opts: SignOptions = {}
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
    subFilter: SUBFILTER_ETSI_CADES_DETACHED
  })
  const signer = new P12Signer(Buffer.from(p12), { passphrase: opts.passphrase ?? '' })
  const signed = await new SignPdf().sign(withPlaceholder, signer)
  return new Uint8Array(signed)
}
