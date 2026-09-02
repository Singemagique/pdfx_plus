// Revocation collection for PAdES B-LT/LTV: gather OCSP responses (AIA id-ad-ocsp) and CRLs (CDP) for
// a certificate chain, to embed in the DSS so the signature is verifiable after the signer cert
// expires. The HTTP fetcher is INJECTABLE (mirrors timestamp.ts's TokenIssuer) so tests run offline.
// OCSP is preferred over CRL — DoD CRLs run to tens of MB. Runs in the MAIN process.
import * as pkijs from 'pkijs'
import * as asn1js from 'asn1js'
import './pkijs-engine'
import { isSelfIssuedDer, revocationPointers, toArrayBuffer } from './cert-chain'

/** DER revocation material to feed into the DSS writer. */
export interface RevocationData {
  /** DER OCSPResponse blobs. */
  ocsps: Uint8Array[]
  /** DER CRL blobs. */
  crls: Uint8Array[]
  /** True if an authoritative OCSP/CRL response proves a chain cert is REVOKED — the caller must not
   *  then claim LTV success (the embedded material would be proof-of-revocation, not validity).
   *  Every cert in the chain is covered except a self-issued (self-signed) root, which is a trust
   *  anchor with nothing to revoke it. A chain that stops short of a root (e.g. a card holding only
   *  the leaf) still has its top cert checked — via CRL, the only mechanism that needs no issuer
   *  certificate. Known gap: if that top cert advertises OCSP but no CRL distribution point, it goes
   *  unchecked and `revoked` stays false (see collectRevocation). */
  revoked: boolean
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
    const resp = new pkijs.OCSPResponse({ schema: asn1js.fromBER(toArrayBuffer(der)).result })
    return resp.responseStatus.valueBlock.valueDec === 0
  } catch {
    return false
  }
}

/** Extract the BasicOCSPResponse from a successful OCSPResponse, or null (error status / unparseable
 *  / not id-pkix-ocsp-basic). */
function basicOcspResponse(der: Uint8Array): pkijs.BasicOCSPResponse | null {
  try {
    const resp = new pkijs.OCSPResponse({ schema: asn1js.fromBER(toArrayBuffer(der)).result })
    if (resp.responseStatus.valueBlock.valueDec !== 0 || !resp.responseBytes) return null
    const inner = resp.responseBytes.response.valueBlock.valueHexView
    return new pkijs.BasicOCSPResponse({ schema: asn1js.fromBER(inner).result })
  } catch {
    return null
  }
}

/** True if `respDer` (an OCSPResponse we fetched for `certDer`, issued by `issuerDer`) reports THIS
 *  cert as REVOKED. Uses pkijs's CertID-matched status only: a response that doesn't provably concern
 *  our cert can't mark it revoked (a shared/delegated responder may carry a `[1] revoked` entry about
 *  a DIFFERENT cert — scanning those blindly would falsely abort a valid signature). Exported for
 *  tests. */
export async function ocspResponseRevoked(
  respDer: Uint8Array,
  certDer: ArrayBuffer,
  issuerDer: ArrayBuffer
): Promise<boolean> {
  const basic = basicOcspResponse(respDer)
  if (!basic) return false
  try {
    // getCertificateStatus recomputes the CertID (with the response's own hash) and matches; status:
    // 0 good, 1 revoked, 2 unknown. isForCertificate is false when no entry concerns our cert.
    const status = await basic.getCertificateStatus(parseCert(certDer), parseCert(issuerDer))
    return status.isForCertificate && status.status === 1
  } catch {
    return false // can't determine → not revoked (fail-open, matching graceful degradation)
  }
}

/** True if a CRL revokes `certDer` — same issuer AND its serial listed. The issuer check matters:
 *  serial numbers are unique only per issuer, so a CRL for a different CA scope that happens to list
 *  the same serial must NOT be read as revoking this cert. Exported for tests. */
export function crlRevokesCert(crlDer: Uint8Array, certDer: ArrayBuffer): boolean {
  try {
    const crl = new pkijs.CertificateRevocationList({
      schema: asn1js.fromBER(toArrayBuffer(toDer(crlDer))).result
    })
    const cert = parseCert(certDer)
    if (!crl.issuer.isEqual(cert.issuer)) return false
    const serial = Buffer.from(cert.serialNumber.valueBlock.valueHexView).toString('hex')
    return (crl.revokedCertificates ?? []).some(
      (rc) => Buffer.from(rc.userCertificate.valueBlock.valueHexView).toString('hex') === serial
    )
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
  const ab = toArrayBuffer(toDer(bytes))
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

// Size caps on revocation responses. A hostile .p12 supplies the AIA/CDP URLs, and DoD CRLs already
// run to tens of MB — an uncapped fetch is a main-process memory-spike vector and bloats the DSS.
const MAX_OCSP_BYTES = 512 * 1024 // OCSP responses are small
const MAX_CRL_BYTES = 16 * 1024 * 1024 // real CRLs can be large, but not unbounded
const MAX_AIA_BYTES = 1024 * 1024 // a single issuer cert / small bundle

/** Read a response body, streaming, and reject (null) once it exceeds `maxBytes` — so an oversized
 *  or lying Content-Length can't force a huge allocation. Exported for tests. */
export async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return null
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer())
    return buf.byteLength > maxBytes ? null : buf
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

/** The real HTTP fetcher. OCSP via POST application/ocsp-request; CRL via GET. Both time- and
 *  size-bounded. */
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
        const buf = await readCapped(res, MAX_OCSP_BYTES)
        // Only keep a genuinely successful response; an error OCSPResponse has no revocation value.
        return buf && buf.length && isSuccessfulOcsp(buf) ? buf : null
      } catch {
        return null
      }
    },
    async fetchCrl(url) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
        if (!res.ok) return null
        const buf = await readCapped(res, MAX_CRL_BYTES)
        return buf && buf.length ? toDer(buf) : null
      } catch {
        return null
      }
    },
    async fetchCaIssuers(url) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
        if (!res.ok) return null
        const buf = await readCapped(res, MAX_AIA_BYTES)
        return buf && buf.length ? certFromCaIssuers(buf) : null
      } catch {
        return null
      }
    }
  }
}

/**
 * Collect revocation data for an ordered chain ([leaf, issuer, …, root]). For each cert that HAS an
 * issuer above it in the chain, try its OCSP responders first (an OCSP request needs the issuer
 * certificate) and fall back to its CRLs.
 *
 * The chain's top cert is handled separately: a self-issued root is the trust anchor and needs no
 * revocation, but the chain does not always reach one — completeChain returns [leaf] when no issuer
 * is fetchable (a smart card that holds only the leaf, or a single-cert .p12). Skipping that cert
 * would leave a leaf-only chain with ZERO revocation checks, so a revoked certificate would sign
 * "successfully" with LTV claimed. It is therefore CRL-checked here; OCSP is not possible for it
 * (no issuer certificate to build the CertID against).
 *
 * Failures are skipped — a partial result is fine; the caller decides whether it's complete enough
 * to claim LTV.
 */
export async function collectRevocation(
  chainDer: ArrayBuffer[],
  fetcher: RevocationFetcher
): Promise<RevocationData> {
  const ocsps: Uint8Array[] = []
  const crls: Uint8Array[] = []
  let revoked = false

  // Store the first usable CRL for `cert` and fold its verdict in; a cert with no reachable CRL is
  // simply left uncovered (graceful degradation).
  const tryCrl = async (cert: ArrayBuffer, urls: string[]): Promise<void> => {
    for (const url of urls) {
      const crl = await fetcher.fetchCrl(url)
      if (crl) {
        crls.push(crl)
        if (crlRevokesCert(crl, cert)) revoked = true
        return
      }
    }
  }

  for (let i = 0; i < chainDer.length - 1; i++) {
    const cert = chainDer[i]
    const issuer = chainDer[i + 1]
    const ptrs = revocationPointers(cert)

    let gotOcsp = false
    for (const url of ptrs.ocsp) {
      const resp = await fetcher.fetchOcsp(cert, issuer, url)
      if (resp) {
        ocsps.push(resp)
        if (await ocspResponseRevoked(resp, cert, issuer)) revoked = true
        gotOcsp = true
        break
      }
    }
    if (gotOcsp) continue

    await tryCrl(cert, ptrs.crl)
  }

  // The chain's top cert: no issuer above it, so the loop skipped it. A self-issued root is rightly
  // skipped (a trust anchor has nothing to revoke it), but a chain that never reached a root must
  // still be checked — otherwise a leaf-only chain gets no revocation check at all.
  //
  // CRL ONLY, and that leaves a KNOWN GAP: an OCSPRequest's CertID hashes the issuer's name and
  // public key, so OCSP is impossible without the issuer certificate — which is exactly what we do
  // not have here. A top cert that advertises OCSP but publishes no CDP therefore still gets zero
  // revocation checks, and the caller still claims LTV. Accepted for now; the honest fixes are to
  // stop claiming LTV in that case, or to surface "revocation unchecked" to the user.
  const top = chainDer[chainDer.length - 1]
  if (top !== undefined && !isSelfIssuedDer(top)) {
    await tryCrl(top, revocationPointers(top).crl)
  }

  return { ocsps, crls, revoked }
}
