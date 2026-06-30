import { describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, PDFRef } from 'pdf-lib'

import { summarizeDss, dssNote } from './dss-info'

// Build a PDF whose catalog carries a /DSS with the given store sizes.
async function makePdfWithDss(certs: number, ocsps: number, crls: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([100, 100])
  const ctx = doc.context
  const arr = (n: number): PDFRef[] => Array.from({ length: n }, () => ctx.register(ctx.obj({})))
  const dss = ctx.register(ctx.obj({ Certs: arr(certs), OCSPs: arr(ocsps), CRLs: arr(crls) }))
  doc.catalog.set(PDFName.of('DSS'), dss)
  return doc.save()
}

describe('summarizeDss', () => {
  it('counts the certs / OCSPs / CRLs in a DSS', async () => {
    expect(await summarizeDss(await makePdfWithDss(5, 1, 2))).toEqual({
      certs: 5,
      ocsps: 1,
      crls: 2
    })
  })

  it('returns null for a PDF without a DSS', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([100, 100])
    expect(await summarizeDss(await doc.save())).toBeNull()
  })

  it('never throws on garbage bytes', async () => {
    expect(await summarizeDss(new Uint8Array([1, 2, 3, 4]))).toBeNull()
  })
})

describe('dssNote', () => {
  it('lists the embedded material when revocation is present', () => {
    expect(dssNote({ certs: 5, ocsps: 1, crls: 2 })).toBe(' · LTV: 5 certs, 1 OCSP, 2 CRL')
    expect(dssNote({ certs: 1, ocsps: 1, crls: 0 })).toBe(' · LTV: 1 cert, 1 OCSP')
  })

  it('warns when the chain embedded but no revocation could be fetched', () => {
    expect(dssNote({ certs: 3, ocsps: 0, crls: 0 })).toContain('no revocation could be fetched')
  })

  it('is empty when there is no DSS', () => {
    expect(dssNote(null)).toBe('')
  })
})
