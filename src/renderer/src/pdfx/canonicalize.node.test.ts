import { describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, PDFRawStream, StandardFonts } from 'pdf-lib'

import {
  CANON_ALG,
  canonicalNumber,
  compareIntegrity,
  computeIntegrity,
  integrityOf
} from './canonicalize'

async function makePdf(body: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const page of [doc.addPage([400, 600]), doc.addPage([400, 600])]) {
    page.drawText(body, { x: 40, y: 540, size: 16, font })
    page.drawRectangle({ x: 40, y: 60, width: 120.12345, height: 80, borderWidth: 1.5 })
  }
  return doc.save()
}

// One buildPdfx-style assembly round-trip (copy pages into a fresh doc, then save).
async function roundTrip(bytes: Uint8Array, useObjectStreams = true): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes)
  const out = await PDFDocument.create()
  const copied = await out.copyPages(src, src.getPageIndices())
  copied.forEach((p) => out.addPage(p))
  return out.save({ useObjectStreams })
}

describe('canonicalNumber', () => {
  it('rounds to 1e-4, trims, and normalizes -0', () => {
    expect(canonicalNumber(1.5)).toBe('1.5')
    expect(canonicalNumber(2)).toBe('2')
    expect(canonicalNumber(-0)).toBe('0')
    expect(canonicalNumber(0.00001)).toBe('0')
    expect(canonicalNumber(1.23456)).toBe('1.2346')
    expect(canonicalNumber(-1.2)).toBe('-1.2')
  })
})

describe('pdfx-canon/1 integrity', () => {
  it('T1: hash is stable across repeated assemble→save→reopen cycles', async () => {
    const src = await makePdf('Confidential contract')
    const h0 = (await integrityOf(src)).flattenedSha256
    let bytes = src
    const seen = new Set<string>()
    for (let i = 0; i < 6; i++) {
      bytes = await roundTrip(bytes)
      seen.add((await integrityOf(bytes)).flattenedSha256)
    }
    expect(seen.size).toBe(1) // identical every cycle
    expect([...seen][0]).toBe(h0) // and equal to the original content's hash
  })

  it('T2: object-streams on/off produce the identical hash', async () => {
    const src = await makePdf('Same content')
    const on = (await integrityOf(await roundTrip(src, true))).flattenedSha256
    const off = (await integrityOf(await roundTrip(src, false))).flattenedSha256
    expect(on).toBe(off)
  })

  it('T3: an external content edit is detected and localized to the changed page', async () => {
    const a = await integrityOf(await makePdf('Original wording'))
    const b = await integrityOf(await makePdf('Tampered wording'))
    expect(b.flattenedSha256).not.toBe(a.flattenedSha256)
    // Both pages carry the changed text, so both page hashes differ; the per-page hashes localize it.
    expect(b.pageHashes[0]).not.toBe(a.pageHashes[0])
    expect(b.pageHashes.length).toBe(a.pageHashes.length)
  })

  it('T4: never throws on a filter-chain or corrupt Flate content stream', async () => {
    const doc = await PDFDocument.create()
    const ctx = doc.context
    // Page 1: a stream that ADVERTISES a [/ASCII85Decode /FlateDecode] chain — unzlibSync alone can't
    // decode it, and the old `String(filter).includes('FlateDecode')` path threw. Now: raw passthrough.
    const chained = PDFRawStream.of(
      ctx.obj({ Filter: [PDFName.of('ASCII85Decode'), PDFName.of('FlateDecode')], Length: 5 }),
      new Uint8Array([1, 2, 3, 4, 5])
    )
    doc.addPage([200, 200]).node.set(PDFName.of('Contents'), ctx.register(chained))
    // Page 2: sole /FlateDecode but the bytes are not valid zlib — the try/catch must swallow it.
    const corrupt = PDFRawStream.of(
      ctx.obj({ Filter: PDFName.of('FlateDecode'), Length: 4 }),
      new Uint8Array([9, 9, 9, 9])
    )
    doc.addPage([200, 200]).node.set(PDFName.of('Contents'), ctx.register(corrupt))

    const bytes = await doc.save()
    const rec = await integrityOf(bytes)
    expect(rec.pageHashes).toHaveLength(2) // both pages hashed, no throw
  })

  it('records the algorithm tag and one hash per page', async () => {
    const rec = await computeIntegrity(await PDFDocument.load(await makePdf('x')))
    expect(rec.canonAlg).toBe(CANON_ALG)
    expect(rec.pageHashes).toHaveLength(2)
    expect(rec.flattenedSha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('compareIntegrity (the import tamper gate)', () => {
  it('is not tampered when the recomputed record matches the embedded one', async () => {
    const rec = await integrityOf(await makePdf('Same content'))
    expect(compareIntegrity(rec, rec)).toEqual({ tampered: false, changedPages: [] })
  })

  it('flags tampering and lists every changed page on a content mismatch', async () => {
    const original = await integrityOf(await makePdf('Original wording'))
    const edited = await integrityOf(await makePdf('Tampered wording'))
    const cmp = compareIntegrity(edited, original)
    expect(cmp.tampered).toBe(true)
    expect(cmp.changedPages).toEqual([1, 2]) // both pages carry the changed text
  })

  it('localizes the mismatch to only the page(s) that differ', async () => {
    const actual = await integrityOf(await makePdf('Body'))
    // A record whose page-1 hash still matches but page-2 hash (and the whole-doc hash) does not.
    const record = {
      ...actual,
      flattenedSha256: 'deadbeef',
      pageHashes: [actual.pageHashes[0], 'changed']
    }
    expect(compareIntegrity(actual, record)).toEqual({ tampered: true, changedPages: [2] })
  })

  it('treats an absent record or unknown algorithm as clean (cannot prove tampering)', async () => {
    const actual = await integrityOf(await makePdf('Body'))
    expect(compareIntegrity(actual, undefined)).toEqual({ tampered: false, changedPages: [] })
    expect(
      compareIntegrity(actual, { ...actual, canonAlg: 'pdfx-canon/2', flattenedSha256: 'x' })
    ).toEqual({ tampered: false, changedPages: [] })
  })

  it('still reports tampered (never throws → fails open) when pageHashes is malformed', async () => {
    const actual = await integrityOf(await makePdf('Body'))
    // Right alg + a definite whole-doc mismatch, but a corrupt pageHashes: must NOT crash to clean.
    const malformed = { canonAlg: CANON_ALG, flattenedSha256: 'wrong' } as unknown as Parameters<
      typeof compareIntegrity
    >[1]
    expect(() => compareIntegrity(actual, malformed)).not.toThrow()
    expect(compareIntegrity(actual, malformed).tampered).toBe(true)
  })
})
