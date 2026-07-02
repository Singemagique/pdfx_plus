// Orchestrates PAdES B-LT/LTV: take an already-signed PDF + the signer's leaf cert and the certs
// available to chain it, build the issuer chain, collect OCSP/CRL revocation for that chain, and
// append it all as a DSS (an append-only incremental update that doesn't disturb the signature).
// Composes cert-chain.ts (buildChain) + revocation.ts (collectRevocation) + dss.ts (appendDss).
// Runs in the MAIN process. The revocation fetcher is injectable so tests run offline.
import { completeChain } from './cert-chain'
import { collectRevocation, httpRevocationFetcher, type RevocationFetcher } from './revocation'
import { appendDss } from './dss'

/**
 * Upgrade a signed PDF to PAdES B-LT by embedding the signer's certificate chain plus its OCSP/CRL
 * revocation data in a DSS. `chainCandidates` are the other certs available to build the chain (e.g.
 * the PKCS#12 bag, the CA certs on a card, or the Windows-built chain). Returns the augmented bytes;
 * if no revocation can be fetched the DSS still carries the chain (better than nothing, and the chain
 * alone is what some validators need). Network failures degrade gracefully — never throws for them.
 */
export async function addLtv(
  signedPdf: Uint8Array,
  leafDer: ArrayBuffer,
  chainCandidates: ArrayBuffer[],
  fetcher: RevocationFetcher = httpRevocationFetcher()
): Promise<Uint8Array> {
  // Complete the chain via AIA caIssuers when it stops short (e.g. a card holding only the leaf).
  const chain = await completeChain(leafDer, chainCandidates, fetcher)
  const { ocsps, crls, revoked } = await collectRevocation(chain, fetcher)
  // An authoritative "revoked" response means the signature has no trust value; abort rather than
  // embed proof-of-revocation in a DSS and report a misleading "LTV enabled" success (audit P1-4).
  // Note: this fires only on a definite revoked status, never on a network/parse failure (those
  // degrade to no-revocation, preserving the graceful-degradation contract).
  if (revoked) {
    throw new Error('Signing certificate is revoked (per OCSP/CRL); signing aborted.')
  }
  return appendDss(signedPdf, {
    certs: chain.map((der) => new Uint8Array(der)),
    ocsps,
    crls
  })
}
