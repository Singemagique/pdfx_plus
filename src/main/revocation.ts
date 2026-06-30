// Revocation collection for PAdES B-LT/LTV: gather OCSP responses (AIA id-ad-ocsp) and CRLs (CDP) for
// a certificate chain, to embed in the DSS so the signature is verifiable after the signer cert
// expires. The HTTP fetcher is INJECTABLE (mirrors timestamp.ts's TokenIssuer) so tests run offline.
// OCSP is preferred over CRL — DoD CRLs run to tens of MB. Runs in the MAIN process.
import * as pkijs from 'pkijs'
import * as asn1js from 'asn1js'
import './pkijs-engine'
import { revocationPointers } from './cert-chain'

/** DER revocation material to feed into the DSS writer. */
export interface RevocationData {
  /** DER OCSPResponse blobs. */
  ocsps: Uint8Array[]
  /** DER CRL blobs. */
  crls: Uint8Array[]
}

/** Fetches revocation material over the network. Injectable so tests don't hit real responders. */
export interface RevocationFetcher {
  /** POST an OCSP request for `cert` (issued by `issuer`) to `url`; resolve the DER OCSPResponse, or
   *  null on any failure (so collection degrades gracefully instead of throwing). */
  fetchOcsp(cert: ArrayBuffer, issuer: ArrayBuffer, url: string): Promise<Uint8Array | null>
  /** GET the DER CRL at `url`, or null on any failure. */
  fetchCrl(url: string): Promise<Uint8Array | null>
  /** GET the issuer certificate at an AIA caIssuers `url` (DER, PEM or a PKCS#7 bundle → first cert),
   *  or null on any failure. Used to complete a chain that's missing intermediates. */
  fetchCaIssuers(url: string): Promise<Uint8Array | null>
}

function parseCert(der: ArrayBuffer): pkijs.Certificate {
  return new pkijs.Certificate({ schema: asn1js.fromBER(der).result })
}

/** Build the DER OCSPRequest for `cert` (issued by `issuer`). The CertID uses SHA-1 — the RFC 6960
 *  default that responders universally accept (independent of the signature's hash strength). */
export async function buildOcspRequest(
  certDer: ArrayBuffer,
  issuerDer: ArrayBuffer
): Promise<Uint8Array> {
  const ocspReq = new pkijs.OCSPRequest()
  await ocspReq.createForCertificate(parseCert(certDer), {
    hashAlgorithm: 'SHA-1',
    issuerCertificate: parseCert(issuerDer)
  })
  // OCSPRequest.toSchema needs encodeFlag=true to emit real values (not ASN.1 schema placeholders).
  return new Uint8Array(ocspReq.toSchema(true).toBER(false))
}

/** True if `der` is an OCSPResponse with responseStatus = successful (0). Error responses (tryLater,
 *  unauthorized, …) carry no revocation info, so we must not embed them in the DSS. */
export function isSuccessfulOcsp(der: Uint8Array): boolean {
  try {
    const ab = der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer
    const resp = new pkijs.OCSPResponse({ schema: asn1js.fromBER(ab).result })
    return resp.responseStatus.valueBlock.valueDec === 0
  } catch {
    return false
  }
}

// A latin1 "-----BEGIN" prefix means PEM; decode the first base64 block to DER. Some CRL distribution
// points serve PEM even though DER is far more common.
function toDer(bytes: Uint8Array): Uint8Array {
  const head = Buffer.from(bytes.subarray(0, 32)).toString('latin1')
  if (!head.includes('-----BEGIN')) return bytes
  const b64 = Buffer.from(bytes)
    .toString('latin1')
    .replace(/-----BEGIN[^-]+-----/, '')
    .replace(/-----END[^-]+-----/, '')
    .replace(/\s+/g, '')
  try {
    return new Uint8Array(Buffer.from(b64, 'base64'))
  } catch {
    return bytes
  }
}

// Normalize an AIA caIssuers response to a single DER certificate. Most responders serve a bare DER
// (or PEM) cert; some serve a PKCS#7 "certs-only" bundle (.p7c) — take its first certificate. Returns
// null if no certificate can be recovered.
export function certFromCaIssuers(bytes: Uint8Array): Uint8Array | null {
  const der = toDer(bytes)
  const ab = der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer
  // (1) a single X.509 certificate.
  try {
    const cert = new pkijs.Certificate({ schema: asn1js.fromBER(ab).result })
    return new Uint8Array(cert.toSchema().toBER(false))
  } catch {
    /* not a bare cert — try a PKCS#7 bundle */
  }
  // (2) a PKCS#7 SignedData "certs-only" bundle → its first certificate.
  try {
    const ci = new pkijs.ContentInfo({ schema: asn1js.fromBER(ab).result })
    const sd = new pkijs.SignedData({ schema: ci.content })
    const first = sd.certificates?.[0]
    if (first instanceof pkijs.Certificate) return new Uint8Array(first.toSchema().toBER(false))
  } catch {
    /* not a PKCS#7 bundle either */
  }
  return null
}

/** The real HTTP fetcher. OCSP via POST application/ocsp-request; CRL via GET. Both time-bounded. */
export function httpRevocationFetcher(timeoutMs = 15000): RevocationFetcher {
  return {
    async fetchOcsp(cert, issuer, url) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/ocsp-request' },
          body: Buffer.from(await buildOcspRequest(cert, issuer)),
          signal: AbortSignal.timeout(timeoutMs)
        })
        if (!res.ok) return null
        const buf = new Uint8Array(await res.arrayBuffer())
        // Only keep a genuinely successful response; an error OCSPResponse has no revocation value.
        return buf.length && isSuccessfulOcsp(buf) ? buf : null
      } catch {
        return null
      }
    },
    async fetchCrl(url) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
        if (!res.ok) return null
        const buf = new Uint8Array(await res.arrayBuffer())
        return buf.length ? toDer(buf) : null
      } catch {
        return null
      }
    },
    async fetchCaIssuers(url) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
        if (!res.ok) return null
        const buf = new Uint8Array(await res.arrayBuffer())
        return buf.length ? certFromCaIssuers(buf) : null
      } catch {
        return null
      }
    }
  }
}

/**
 * Collect revocation data for an ordered chain ([leaf, issuer, …, root]). For each non-root cert, try
 * its OCSP responders first (via the issuer above it in the chain) and fall back to its CRLs. The
 * root needs no revocation (it's the trust anchor). Failures are skipped — a partial result is fine;
 * the caller decides whether it's complete enough to claim LTV.
 */
export async function collectRevocation(
  chainDer: ArrayBuffer[],
  fetcher: RevocationFetcher
): Promise<RevocationData> {
  const ocsps: Uint8Array[] = []
  const crls: Uint8Array[] = []
  for (let i = 0; i < chainDer.length - 1; i++) {
    const cert = chainDer[i]
    const issuer = chainDer[i + 1]
    const ptrs = revocationPointers(cert)

    let gotOcsp = false
    for (const url of ptrs.ocsp) {
      const resp = await fetcher.fetchOcsp(cert, issuer, url)
      if (resp) {
        ocsps.push(resp)
        gotOcsp = true
        break
      }
    }
    if (gotOcsp) continue

    for (const url of ptrs.crl) {
      const crl = await fetcher.fetchCrl(url)
      if (crl) {
        crls.push(crl)
        break
      }
    }
  }
  return { ocsps, crls }
}
