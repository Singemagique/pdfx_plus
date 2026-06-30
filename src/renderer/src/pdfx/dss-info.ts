// Read a signed PDF's DSS (Document Security Store) to summarize what long-term-validation material
// it carries — the cert chain + OCSP/CRL counts. Used for a post-sign readout, since a local verifier
// that doesn't trust the signer's PKI won't display an "LTV enabled" badge to confirm it. pdf-lib
// only; runs in the renderer.
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray } from 'pdf-lib'

export interface DssSummary {
  /** Certificates embedded (signer leaf + chain). */
  certs: number
  /** OCSP responses embedded. */
  ocsps: number
  /** CRLs embedded. */
  crls: number
}

/** Count the certs / OCSP responses / CRLs in a signed PDF's DSS, or null if there's no DSS (no LTV
 *  data was embedded). Never throws — a parse problem just yields null. */
export async function summarizeDss(bytes: Uint8Array): Promise<DssSummary | null> {
  try {
    const doc = await PDFDocument.load(bytes)
    const ref = doc.catalog.get(PDFName.of('DSS'))
    if (!(ref instanceof PDFRef)) return null
    const dss = doc.context.lookupMaybe(ref, PDFDict)
    if (!dss) return null
    const count = (key: string): number => {
      const arr = dss.get(PDFName.of(key))
      return arr instanceof PDFArray ? arr.size() : 0
    }
    return { certs: count('Certs'), ocsps: count('OCSPs'), crls: count('CRLs') }
  } catch {
    return null
  }
}

/** A short human-readable note for the post-sign toast, or '' when there's no LTV data. */
export function dssNote(summary: DssSummary | null): string {
  if (!summary) return ''
  if (summary.ocsps + summary.crls === 0) {
    return ' · LTV: chain embedded, but no revocation could be fetched (check network access)'
  }
  const parts = [`${summary.certs} cert${summary.certs === 1 ? '' : 's'}`]
  if (summary.ocsps) parts.push(`${summary.ocsps} OCSP`)
  if (summary.crls) parts.push(`${summary.crls} CRL`)
  return ` · LTV: ${parts.join(', ')}`
}
