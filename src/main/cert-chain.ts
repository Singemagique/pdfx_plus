// Cert-chain intelligence for PAdES B-LT/LTV. Two pure (no-network) operations the LTV pipeline
// builds on: (1) read a certificate's revocation pointers — AIA → OCSP responder + caIssuers URLs,
// CDP → CRL URLs; (2) order a set of certificates into the issuer chain above a leaf. The OCSP/CRL
// fetching and the DSS/VRI assembly consume these. Runs in the MAIN process.
import * as pkijs from 'pkijs'
import * as asn1js from 'asn1js'
import './pkijs-engine'

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
