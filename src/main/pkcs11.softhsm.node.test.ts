// Integration test for the real PKCS#11 binding, exercised against a SoftHSM2 software token. It is
// skipped unless PKCS11_TEST_MODULE (+ SOFTHSM2_CONF, PIN, label) is set, so CI — which has no
// module — does not run it. Locally it proves the full card → CMS → verify path end-to-end.
//
// To run: point the env at the portable SoftHSM2 set up under scratchpad, then:
//   PKCS11_TEST_MODULE=.../softhsm2-x64.dll SOFTHSM2_CONF=.../softhsm2.conf \
//   PKCS11_TEST_PIN=1234 PKCS11_TEST_LABEL=pdfx-test corepack yarn vitest run pkcs11.softhsm
import { describe, expect, it } from 'vitest'
import { X509Certificate, createPublicKey, createVerify } from 'node:crypto'
import * as pkijs from 'pkijs'
import * as asn1js from 'asn1js'
import { PDFDocument } from 'pdf-lib'

import { listTokens, openCard } from './pkcs11'
import { buildDetachedCms } from './sign-pkcs11'
import { signPdfWithCard } from './sign'

const MODULE = process.env.PKCS11_TEST_MODULE
const PIN = process.env.PKCS11_TEST_PIN ?? '1234'
const LABEL = process.env.PKCS11_TEST_LABEL ?? 'pdfx-test'

describe.skipIf(!MODULE)('PKCS#11 binding against SoftHSM', () => {
  it('lists the test token', () => {
    const tokens = listTokens(MODULE!)
    expect(tokens.some((t) => t.label === LABEL)).toBe(true)
  })

  it('reads the cert and signs over the CMS attributes (verifies against the cert)', async () => {
    const card = openCard({ modulePath: MODULE!, pin: PIN, tokenLabel: LABEL })
    try {
      // The cert read off the token parses as X.509.
      const x509 = new X509Certificate(Buffer.from(card.certDer))
      expect(x509.subject).toContain('PDFx')

      // rawSign over arbitrary bytes verifies against the cert's public key (SHA-256 RSA).
      const data = new TextEncoder().encode('signed-attributes stand-in')
      const sig = await card.rawSign(data.buffer.slice(0))
      const pub = createPublicKey(x509.publicKey.export({ type: 'spki', format: 'pem' }))
      const v = createVerify('RSA-SHA256')
      v.update(Buffer.from(data))
      expect(v.verify(pub, Buffer.from(sig))).toBe(true)

      // The full detached CMS built from the card verifies.
      const cms = await buildDetachedCms(card.certDer, data, card.rawSign)
      const ci = new pkijs.ContentInfo({ schema: asn1js.fromBER(cms).result })
      const sd = new pkijs.SignedData({ schema: ci.content })
      const result = await sd.verify({
        signer: 0,
        data: data.buffer.slice(0),
        checkChain: false,
        extendedMode: true
      })
      expect(result.signatureVerified).toBe(true)
    } finally {
      card.close()
    }
  })

  it('signs a real PDF end-to-end (PAdES B-B) via the card', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([300, 200]).drawText('card-signed')
    const bytes = await doc.save()

    const signed = await signPdfWithCard(bytes, {
      modulePath: MODULE!,
      pin: PIN,
      tokenLabel: LABEL
    })
    const text = Buffer.from(signed).toString('latin1')
    expect(text).toContain('/Type /Sig')
    expect(text).toContain('/SubFilter /ETSI.CAdES.detached')
    // The signed file is a loadable PDF and larger than the input (placeholder + CMS added).
    expect(signed.length).toBeGreaterThan(bytes.length)
    await expect(PDFDocument.load(signed)).resolves.toBeTruthy()
  })
})
