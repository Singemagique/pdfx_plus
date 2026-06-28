// Extract a certificate's subject + issuer (as DN strings) so the visible signature appearance can
// show the standard "digitally signed by …" identity for the .p12 and PKCS#11 paths too. The
// Windows-store path already gets this from the renderer (the cert picker). Runs in the MAIN process.
import forge from 'node-forge'

export interface SignerInfo {
  subject: string
  issuer: string
}

interface NameAttr {
  shortName?: string
  name?: string
  type?: string
  value: unknown
}

// Format an X.500 name as "CN=…, OU=…, O=…" in the order the certificate lists it.
function dnString(attrs: NameAttr[]): string {
  return attrs.map((a) => `${a.shortName || a.name || a.type || '?'}=${String(a.value)}`).join(', ')
}

function infoFromCert(cert: forge.pki.Certificate): SignerInfo {
  return {
    subject: dnString(cert.subject.attributes as NameAttr[]),
    issuer: dnString(cert.issuer.attributes as NameAttr[])
  }
}

// node-forge's bundled types reject the lenient { parseAllBytes:false } option; cast around them.
const fromDer = (bytes: string): forge.asn1.Asn1 =>
  (
    forge.asn1.fromDer as unknown as (
      b: forge.util.ByteStringBuffer,
      opts: { parseAllBytes: boolean }
    ) => forge.asn1.Asn1
  )(forge.util.createBuffer(bytes), { parseAllBytes: false })

/** Subject + issuer of a DER-encoded X.509 certificate (e.g. read off a PKCS#11 token). */
export function certInfoFromDer(der: Uint8Array): SignerInfo {
  return infoFromCert(forge.pki.certificateFromAsn1(fromDer(Buffer.from(der).toString('binary'))))
}

function isCa(cert: forge.pki.Certificate): boolean {
  const bc = cert.getExtension('basicConstraints') as { cA?: boolean } | undefined
  return !!bc?.cA
}

/** Subject + issuer of the signing (leaf) certificate in a PKCS#12, or null if it can't be read. */
export function certInfoFromP12(p12: Uint8Array, passphrase: string): SignerInfo | null {
  try {
    const p12obj = forge.pkcs12.pkcs12FromAsn1(
      fromDer(Buffer.from(p12).toString('binary')),
      false,
      passphrase
    )
    const bags = p12obj.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []
    // Prefer the end-entity cert (not a CA); fall back to the first certificate present.
    const leaf = bags.find((b) => b.cert && !isCa(b.cert)) ?? bags[0]
    return leaf?.cert ? infoFromCert(leaf.cert) : null
  } catch {
    return null
  }
}
