import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import forge from 'node-forge'
import * as pkijs from 'pkijs'
import * as asn1js from 'asn1js'

import { signPdf } from './sign'
import { makeLocalTsa } from './tsa-local'

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

// A test credential whose .p12 bundles a CA + a leaf signed by it (to exercise chain inclusion).
function makeP12WithChain(passphrase: string): { p12: Uint8Array; leafCN: string; caCN: string } {
  const year = new Date(Date.now() + 365 * 24 * 3600 * 1000)
  const caKeys = forge.pki.rsa.generateKeyPair(2048)
  const ca = forge.pki.createCertificate()
  ca.publicKey = caKeys.publicKey
  ca.serialNumber = '02'
  ca.validity.notBefore = new Date()
  ca.validity.notAfter = year
  const caCN = 'PDFx Test CA'
  const caAttrs = [{ name: 'commonName', value: caCN }]
  ca.setSubject(caAttrs)
  ca.setIssuer(caAttrs)
  ca.setExtensions([{ name: 'basicConstraints', cA: true }])
  ca.sign(caKeys.privateKey, forge.md.sha256.create())

  const leafKeys = forge.pki.rsa.generateKeyPair(2048)
  const leaf = forge.pki.createCertificate()
  leaf.publicKey = leafKeys.publicKey
  leaf.serialNumber = '03'
  leaf.validity.notBefore = new Date()
  leaf.validity.notAfter = year
  const leafCN = 'PDFx Leaf Signer'
  leaf.setSubject([{ name: 'commonName', value: leafCN }])
  leaf.setIssuer(caAttrs)
  leaf.sign(caKeys.privateKey, forge.md.sha256.create())

  const asn1 = forge.pkcs12.toPkcs12Asn1(leafKeys.privateKey, [leaf, ca], passphrase, {
    algorithm: '3des'
  })
  const der = forge.asn1.toDer(asn1).getBytes()
  return { p12: new Uint8Array(Buffer.from(der, 'binary')), leafCN, caCN }
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

// Parse the embedded CMS (from /Contents) into a pkijs SignedData for signed-attr / cert inspection.
function parseCms(signed: Uint8Array): pkijs.SignedData {
  const s = Buffer.from(signed).toString('latin1')
  const cmsHex = s.match(/\/Contents\s*<([0-9A-Fa-f]+)>/)![1]
  const der = Buffer.from(cmsHex, 'hex') // zero-padded; fromBER reads the CMS prefix
  const ci = new pkijs.ContentInfo({
    schema: asn1js.fromBER(der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength)).result
  })
  return new pkijs.SignedData({ schema: ci.content })
}

// The exact bytes the signature covers (the two /ByteRange segments around the /Contents gap).
function byteRangeContent(signed: Uint8Array): Buffer {
  const s = Buffer.from(signed).toString('latin1')
  const br = s.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/)!
  const [a, b, c, d] = [br[1], br[2], br[3], br[4]].map(Number)
  return Buffer.concat([
    Buffer.from(signed).subarray(a, a + b),
    Buffer.from(signed).subarray(c, c + d)
  ])
}

// CommonName (2.5.4.3) of a pkijs certificate's subject, if present.
function subjectCN(cert: pkijs.Certificate): string | undefined {
  const v = cert.subject.typesAndValues.find((t) => t.type === '2.5.4.3')?.value as
    | { valueBlock: { value: string } }
    | undefined
  return v?.valueBlock?.value
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

  it('upgrades to PAdES B-T when a TSA is configured (timestamp token embedded)', async () => {
    const { p12 } = makeP12('pw')
    const issue = await makeLocalTsa()
    const signed = await signPdf(
      await makePdf(),
      p12,
      { passphrase: 'pw', tsaUrl: 'http://local-tsa' },
      issue // inject the local issuer so the test stays offline
    )
    const s = Buffer.from(signed).toString('latin1')
    expect(s).toContain('/ETSI.CAdES.detached') // still PAdES
    const cmsHex = s.match(/\/Contents\s*<([0-9A-Fa-f]+)>/)![1]
    const der = Buffer.from(cmsHex, 'hex') // zero-padded; fromBER reads the CMS prefix
    const ci = new pkijs.ContentInfo({
      schema: asn1js.fromBER(der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength))
        .result
    })
    const sd = new pkijs.SignedData({ schema: ci.content })
    const attrs = sd.signerInfos[0].unsignedAttrs?.attributes ?? []
    expect(attrs.some((a) => a.type === '1.2.840.113549.1.9.16.2.14')).toBe(true) // id-aa-timeStampToken
  })

  it('emits the PAdES signing-certificate-v2 signed attribute on the .p12 path', async () => {
    const { p12 } = makeP12('pw')
    const signed = await signPdf(await makePdf(), p12, { passphrase: 'pw' })
    const sd = parseCms(signed)
    const oids = (sd.signerInfos[0].signedAttrs?.attributes ?? []).map((a) => a.type)
    // 1.2.840.113549.1.9.16.2.47 = id-aa-signingCertificateV2 (RFC 5035) — the binding @signpdf's
    // P12Signer omitted; required for strict PAdES/CAdES-B. Card/Windows paths already emit it.
    expect(oids).toContain('1.2.840.113549.1.9.16.2.47')
    // Baseline signed attrs are still present.
    expect(oids).toContain('1.2.840.113549.1.9.3') // content-type
    expect(oids).toContain('1.2.840.113549.1.9.4') // message-digest
    // Still a valid PAdES signature whose digest covers the content.
    const v = verify(signed)
    expect(v.pades).toBe(true)
    expect(v.digestMatches).toBe(true)
    // And the actual signature VALUE verifies against the signer cert — proving the node:crypto
    // RawSigner (RSASSA-PKCS1-v1_5/SHA-256 over the signed-attrs SET) is correct, not just present.
    const content = byteRangeContent(signed)
    const result = await sd.verify({
      signer: 0,
      // A Node Buffer is always ArrayBuffer-backed (never SharedArrayBuffer); cast for pkijs's type.
      data: content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength
      ) as ArrayBuffer,
      checkChain: false,
      extendedMode: true
    })
    expect(result.signatureVerified).toBe(true)
  })

  it('bundles the .p12 certificate chain in SignedData.certificates (signer cert first)', async () => {
    const { p12, leafCN, caCN } = makeP12WithChain('pw')
    const signed = await signPdf(await makePdf(), p12, { passphrase: 'pw' })
    const sd = parseCms(signed)
    const certs = (sd.certificates ?? []) as pkijs.Certificate[]
    const cns = certs.map(subjectCN)
    expect(cns).toContain(leafCN)
    expect(cns).toContain(caCN)
    expect(subjectCN(certs[0])).toBe(leafCN) // the signer (leaf) cert is bundled first
  })
})
