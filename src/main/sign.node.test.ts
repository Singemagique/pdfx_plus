import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import forge from 'node-forge'

import { signPdf } from './sign'

// A self-signed test credential as PKCS#12 bytes + its expected common name.
function makeP12(passphrase: string): { p12: Uint8Array; cn: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000)
  const cn = 'PDFx Test Signer'
  const attrs = [
    { name: 'commonName', value: cn },
    { name: 'organizationName', value: 'PDFx' }
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, { algorithm: '3des' })
  const der = forge.asn1.toDer(asn1).getBytes()
  return { p12: new Uint8Array(Buffer.from(der, 'binary')), cn }
}

async function makePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([400, 300])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('Contract to be signed', { x: 40, y: 240, size: 18, font })
  return doc.save()
}

// Verify a detached signature: the messageDigest signed attribute must equal sha256 of the
// ByteRange-covered content, and the embedded signer cert must match.
function verify(signed: Uint8Array): { pades: boolean; digestMatches: boolean; signerCN?: string } {
  const s = Buffer.from(signed).toString('latin1')
  const pades = s.includes('/ETSI.CAdES.detached')
  const br = s.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/)!
  const [a, b, c, d] = [br[1], br[2], br[3], br[4]].map(Number)
  const content = Buffer.concat([
    Buffer.from(signed).subarray(a, a + b),
    Buffer.from(signed).subarray(c, c + d)
  ])
  const sha = createHash('sha256').update(content).digest('hex')
  const cmsHex = s.match(/\/Contents\s*<([0-9A-Fa-f]+)>/)![1]
  // node-forge's bundled types are outdated; cast around them. /Contents is zero-padded to the
  // placeholder length, so parse the CMS prefix only (parseAllBytes: false).
  type Attr = { value: Array<{ value: unknown }> }
  const fromDer = forge.asn1.fromDer as unknown as (
    b: forge.util.ByteStringBuffer,
    o: { parseAllBytes: boolean }
  ) => forge.asn1.Asn1
  const asn1 = fromDer(forge.util.createBuffer(forge.util.hexToBytes(cmsHex)), {
    parseAllBytes: false
  })
  const p7 = forge.pkcs7.messageFromAsn1(asn1) as unknown as {
    rawCapture: { authenticatedAttributes?: Attr[] }
    certificates?: forge.pki.Certificate[]
  }
  let messageDigest: string | undefined
  for (const attr of p7.rawCapture.authenticatedAttributes ?? []) {
    const oid = forge.asn1.derToOid(attr.value[0].value as string)
    if (oid === forge.pki.oids.messageDigest) {
      messageDigest = forge.util.bytesToHex((attr.value[1] as Attr).value[0].value as string)
    }
  }
  const signerCN = p7.certificates?.[0]?.subject?.getField('CN')?.value
  return { pades, digestMatches: messageDigest === sha, signerCN }
}

describe('signPdf', () => {
  it('produces a PAdES signature whose digest covers the content', async () => {
    const { p12, cn } = makeP12('pw')
    const signed = await signPdf(await makePdf(), p12, { passphrase: 'pw', reason: 'I approve' })
    const v = verify(signed)
    expect(v.pades).toBe(true) // ETSI.CAdES.detached
    expect(v.digestMatches).toBe(true) // signature covers the actual bytes
    expect(v.signerCN).toBe(cn) // signed by our credential
  })

  it('throws on a wrong passphrase (never returns a half-signed file)', async () => {
    const { p12 } = makeP12('correct')
    await expect(signPdf(await makePdf(), p12, { passphrase: 'wrong' })).rejects.toBeTruthy()
  })
})
