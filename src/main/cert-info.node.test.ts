import { describe, expect, it } from 'vitest'
import forge from 'node-forge'
import { certInfoFromDer, certInfoFromP12 } from './cert-info'

// A self-signed test credential: returns its PKCS#12 bytes and the leaf cert's DER.
function makeCred(passphrase: string): { p12: Uint8Array; der: Uint8Array } {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000)
  cert.setSubject([
    { name: 'commonName', value: 'JARA.ADAM.1290104722' },
    { shortName: 'OU', value: 'DoD' },
    { name: 'organizationName', value: 'U.S. Government' }
  ])
  cert.setIssuer([
    { name: 'commonName', value: 'DOD ID CA-59' },
    { name: 'organizationName', value: 'U.S. Government' }
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, { algorithm: '3des' })
  const p12 = new Uint8Array(Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'))
  const der = new Uint8Array(
    Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary')
  )
  return { p12, der }
}

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
