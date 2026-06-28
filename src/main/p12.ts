// Extract a signing credential (leaf cert DER + chain + an RSA RawSigner) from a PKCS#12 (.p12/.pfx),
// so the .p12 signing path can run through the SAME in-house CmsSigner/buildDetachedCms pipeline as
// the smart-card and Windows-cert paths — and therefore emit the PAdES signing-certificate-v2 signed
// attribute that @signpdf's P12Signer does not. RSA only (matches the rest of the signing stack).
// Runs in the MAIN process; the passphrase and private key never reach the renderer.
import forge from 'node-forge'
import { sign as rsaSign } from 'node:crypto'
import type { RawSigner } from './sign-pkcs11'

export interface P12Credential {
  /** The signer (leaf) certificate, DER-encoded. */
  certDer: ArrayBuffer
  /** Other certificates bundled in the PKCS#12 (intermediates/roots), DER-encoded. */
  chainDer: ArrayBuffer[]
  /** Sign `data` with the PKCS#12's private key (RSASSA-PKCS1-v1_5, SHA-256). */
  rawSign: RawSigner
}

function certToDer(cert: forge.pki.Certificate): ArrayBuffer {
  const bytes = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
  const u8 = Uint8Array.from(Buffer.from(bytes, 'binary'))
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
}

// node-forge's bundled types don't surface the jsbn modulus/exponent on RSA keys; describe what we use.
interface RsaNums {
  n?: { compareTo(o: unknown): number }
  e?: { compareTo(o: unknown): number }
}

/**
 * Parse a PKCS#12 and return the credential whose private key matches one of its certificates. Throws
 * (so a caller never produces a half-signed file) on a wrong passphrase, a missing private key, a
 * missing/mismatched certificate, or a non-RSA key.
 */
export function p12ToCredential(p12: Uint8Array, passphrase: string): P12Credential {
  const der = forge.util.createBuffer(Buffer.from(p12).toString('binary'))
  // fromDer is strict (a real .p12 is exactly its DER); pkcs12FromAsn1 is lenient, like @signpdf.
  const p12obj = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), false, passphrase)

  const keyBag =
    (p12obj.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ] ?? [])[0] ??
    (p12obj.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? [])[0]
  const key = keyBag?.key as (forge.pki.PrivateKey & RsaNums) | undefined
  if (!key) throw new Error('No private key found in the PKCS#12')

  const certBags = p12obj.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []
  if (!certBags.length) throw new Error('No certificate found in the PKCS#12')

  // The leaf is the cert whose RSA public key matches the private key (same rule as @signpdf
  // P12Signer); every other certificate in the bag is part of the chain.
  let leaf: forge.pki.Certificate | undefined
  const chain: forge.pki.Certificate[] = []
  for (const bag of certBags) {
    const cert = bag.cert
    if (!cert) continue
    const pub = cert.publicKey as RsaNums
    const matches =
      !leaf &&
      !!key.n &&
      !!key.e &&
      !!pub.n &&
      !!pub.e &&
      key.n.compareTo(pub.n) === 0 &&
      key.e.compareTo(pub.e) === 0
    if (matches) leaf = cert
    else chain.push(cert)
  }
  if (!leaf) throw new Error('Failed to find a certificate that matches the private key')

  let keyPem: string
  try {
    keyPem = forge.pki.privateKeyToPem(key)
  } catch (e) {
    throw new Error(`Unsupported PKCS#12 private key (RSA expected): ${(e as Error).message}`)
  }

  const rawSign: RawSigner = async (data) => {
    // Default RSA padding is PKCS#1 v1.5 → RSASSA-PKCS1-v1_5, matching the card/Windows raw signers.
    const sig = rsaSign('sha256', Buffer.from(data), keyPem)
    return sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength)
  }

  return { certDer: certToDer(leaf), chainDer: chain.map(certToDer), rawSign }
}
