// Cert-chain intelligence for PAdES B-LT/LTV. Two pure (no-network) operations the LTV pipeline
// builds on: (1) read a certificate's revocation pointers — AIA → OCSP responder + caIssuers URLs,
// CDP → CRL URLs; (2) order a set of certificates into the issuer chain above a leaf. The OCSP/CRL
// fetching and the DSS/VRI assembly consume these. Runs in the MAIN process.
import * as pkijs from 'pkijs'
import * as asn1js from 'asn1js'
import './pkijs-engine'
import type { RevocationFetcher } from './revocation'

const ID_AIA = '1.3.6.1.5.5.7.1.1' // authorityInfoAccess
const ID_CDP = '2.5.29.31' // cRLDistributionPoints
const ACCESS_OCSP = '1.3.6.1.5.5.7.48.1' // id-ad-ocsp
const ACCESS_CA_ISSUERS = '1.3.6.1.5.5.7.48.2' // id-ad-caIssuers
const GN_URI = 6 // GeneralName uniformResourceIdentifier

export interface RevocationPointers {
  /** OCSP responder URLs (AIA id-ad-ocsp). */
  ocsp: string[]
  /** CA-issuers URLs (AIA id-ad-caIssuers) — where to fetch a missing issuer certificate. */
  caIssuers: string[]
  /** CRL distribution-point URLs (CDP). */
  crl: string[]
}

function parseCert(der: ArrayBuffer): pkijs.Certificate {
  return new pkijs.Certificate({ schema: asn1js.fromBER(der).result })
}

// HTTP(S) URLs only — the fetchers speak HTTP, and this filters out ldap:// / other GeneralName forms.
function httpUris(names: pkijs.GeneralName[] | undefined): string[] {
  return (names ?? [])
    .filter(
      (gn) => gn.type === GN_URI && typeof gn.value === 'string' && /^https?:\/\//i.test(gn.value)
    )
    .map((gn) => gn.value as string)
}

/** Read the OCSP / caIssuers / CRL HTTP URLs out of a DER X.509 certificate (empty arrays if absent
 *  or unparseable — this never throws, so a malformed cert just yields no pointers). */
export function revocationPointers(der: ArrayBuffer): RevocationPointers {
  const out: RevocationPointers = { ocsp: [], caIssuers: [], crl: [] }
  let cert: pkijs.Certificate
  try {
    cert = parseCert(der)
  } catch {
    return out
  }
  for (const ext of cert.extensions ?? []) {
    if (ext.extnID === ID_AIA && ext.parsedValue instanceof pkijs.InfoAccess) {
      for (const ad of ext.parsedValue.accessDescriptions) {
        const loc = ad.accessLocation
        if (
          loc.type !== GN_URI ||
          typeof loc.value !== 'string' ||
          !/^https?:\/\//i.test(loc.value)
        ) {
          continue
        }
        if (ad.accessMethod === ACCESS_OCSP) out.ocsp.push(loc.value)
        else if (ad.accessMethod === ACCESS_CA_ISSUERS) out.caIssuers.push(loc.value)
      }
    } else if (ext.extnID === ID_CDP && ext.parsedValue instanceof pkijs.CRLDistributionPoints) {
      for (const dp of ext.parsedValue.distributionPoints ?? []) {
        if (Array.isArray(dp.distributionPoint)) out.crl.push(...httpUris(dp.distributionPoint))
      }
    }
  }
  return out
}

/** True if `cert` is self-issued (subject === issuer), i.e. a (self-signed) root — the chain top. */
function isSelfIssued(cert: pkijs.Certificate): boolean {
  return cert.subject.isEqual(cert.issuer)
}

/**
 * Order `candidateDers` into the issuer chain above `leafDer`: [leaf, issuer, issuer-of-issuer, …],
 * stopping at a self-signed root or when no issuer is found among the candidates. Deduplicates and is
 * iteration-bounded, so a cyclic / self-referential candidate set can't loop. Unmatched candidates
 * are dropped. Returns at least [leafDer]; never throws (a bad cert yields just the leaf).
 */
export function buildChain(leafDer: ArrayBuffer, candidateDers: ArrayBuffer[]): ArrayBuffer[] {
  let leaf: pkijs.Certificate
  try {
    leaf = parseCert(leafDer)
  } catch {
    return [leafDer]
  }
  const pool = candidateDers
    .map((der) => {
      try {
        return { der, cert: parseCert(der) }
      } catch {
        return null
      }
    })
    .filter((x): x is { der: ArrayBuffer; cert: pkijs.Certificate } => x !== null)

  const chain: ArrayBuffer[] = [leafDer]
  const used = new Set<ArrayBuffer>([leafDer])
  let current = leaf
  for (let i = 0; i <= pool.length && !isSelfIssued(current); i++) {
    const parent = pool.find((c) => !used.has(c.der) && c.cert.subject.isEqual(current.issuer))
    if (!parent) break
    chain.push(parent.der)
    used.add(parent.der)
    current = parent.cert
  }
  return chain
}

const toArrayBuffer = (u8: Uint8Array): ArrayBuffer =>
  u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer

// Subject DN of a cert, as a stable string for cycle detection (null if unparseable).
function subjectKey(der: ArrayBuffer): string | null {
  try {
    return parseCert(der).subject.typesAndValues.map((t) => `${t.type}=${t.value.valueBlock.value}`).join(',') // prettier-ignore
  } catch {
    return null
  }
}

/**
 * Like buildChain, but when the chain stops short of a self-signed root, fetch the missing issuer
 * certificates over the network via each top cert's AIA caIssuers URL (so e.g. a smart card that holds
 * only the leaf still yields a full chain for the DSS). Stops at a self-signed root, when no issuer
 * can be fetched, on a cycle, or after `maxFetch` fetches. Best-effort — returns whatever it has.
 */
export async function completeChain(
  leafDer: ArrayBuffer,
  knownCerts: ArrayBuffer[],
  fetcher: RevocationFetcher,
  maxFetch = 8
): Promise<ArrayBuffer[]> {
  const chain = buildChain(leafDer, knownCerts)
  const seen = new Set(chain.map(subjectKey).filter((k): k is string => k !== null))
  for (let i = 0; i < maxFetch; i++) {
    let top: pkijs.Certificate
    try {
      top = parseCert(chain[chain.length - 1])
    } catch {
      break
    }
    if (isSelfIssued(top)) break

    let fetched: ArrayBuffer | null = null
    for (const url of revocationPointers(chain[chain.length - 1]).caIssuers) {
      const bytes = await fetcher.fetchCaIssuers(url)
      if (!bytes) continue
      const der = toArrayBuffer(bytes)
      let cert: pkijs.Certificate
      try {
        cert = parseCert(der)
      } catch {
        continue
      }
      // Only accept the genuine issuer (its subject == the top cert's issuer).
      if (cert.subject.isEqual(top.issuer)) {
        fetched = der
        break
      }
    }
    if (!fetched) break
    const key = subjectKey(fetched)
    if (key && seen.has(key)) break // cycle / already present
    if (key) seen.add(key)
    chain.push(fetched)
  }
  return chain
}
