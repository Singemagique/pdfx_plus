import { describe, expect, it } from 'vitest'
import { certInfoFromDer, certInfoFromP12 } from './cert-info'
import { makeP12 } from './test-utils/fixtures'

// A self-signed test credential: returns its PKCS#12 bytes and the leaf cert's DER.
const makeCred = (passphrase: string): { p12: Uint8Array; der: Uint8Array } =>
  makeP12(passphrase, {
    subject: [
      { name: 'commonName', value: 'JARA.ADAM.1290104722' },
      { shortName: 'OU', value: 'DoD' },
      { name: 'organizationName', value: 'U.S. Government' }
    ],
    issuer: [
      { name: 'commonName', value: 'DOD ID CA-59' },
      { name: 'organizationName', value: 'U.S. Government' }
    ],
    algorithm: '3des'
  })

describe('certInfoFromDer', () => {
  it('formats the subject and issuer as DN strings', () => {
    const { der } = makeCred('pw')
    const info = certInfoFromDer(der)
    expect(info).not.toBeNull()
    expect(info!.subject).toContain('CN=JARA.ADAM.1290104722')
    expect(info!.subject).toContain('OU=DoD')
    expect(info!.issuer).toContain('CN=DOD ID CA-59')
  })

  it('returns null on a malformed cert instead of throwing', () => {
    expect(certInfoFromDer(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull()
  })
})

describe('certInfoFromP12', () => {
  it('reads the signing certificate identity with the right passphrase', () => {
    const { p12 } = makeCred('secret')
    const info = certInfoFromP12(p12, 'secret')
    expect(info).not.toBeNull()
    expect(info!.subject).toContain('CN=JARA.ADAM.1290104722')
    expect(info!.issuer).toContain('CN=DOD ID CA-59')
  })

  it('returns null on a wrong passphrase instead of throwing', () => {
    const { p12 } = makeCred('secret')
    expect(certInfoFromP12(p12, 'wrong')).toBeNull()
  })
})
