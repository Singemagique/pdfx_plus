// Stage 0 (DESIGN.md §3.4.1): the renderer-side gate in front of OCR triage. The pure decision at
// its thresholds, how many pages it reads (the first min(8, n) and the page in view, stopping at
// the first candidate), imported-image sources skipping it, and the real search extractor (pdf.js
// getTextContent) on a scan, a near-scanned page and a text page.

import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
// pdf.js's worker in-process (its "fake worker" picks up globalThis.pdfjsWorker).
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { afterAll, describe, expect, it } from 'vitest'

import { fillPage, scan } from '../../../main/ocr/test-utils/triage-fixtures'
import { extractPageText, type PageText } from '../search/extract'
import {
  CANDIDATE_MAX_CHARS,
  STAGE0_PAGES,
  isCandidatePage,
  runStage0,
  stage0Decision,
  stage0Pages,
  visibleChars
} from './stage0'

const text = (s: string): Pick<PageText, 'items'> => ({
  items: [{ str: s } as PageText['items'][number]]
})
const chars = (n: number): Pick<PageText, 'items'> => text('x'.repeat(n))

const docs: PDFDocumentProxy[] = []
afterAll(async () => {
  for (const d of docs) await d.destroy()
})

async function open(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const d = (await getDocument({ data: bytes.slice(), verbosity: 0 })
    .promise) as unknown as PDFDocumentProxy
  docs.push(d)
  return d
}

describe('the pure Stage 0 decision', () => {
  it('counts visible non-space characters and flags pages under 200', () => {
    expect(visibleChars(text(' a b\tc\n d '))).toBe(4)
    expect(visibleChars({ items: [{ str: 'ab' }, { str: ' ' }, { str: 'cd' }] as never })).toBe(4)
    // Code points, not UTF-16 units.
    expect(visibleChars(text('𝔸𝔹'))).toBe(2)
    expect(isCandidatePage(chars(CANDIDATE_MAX_CHARS - 1))).toBe(true)
    expect(isCandidatePage(chars(CANDIDATE_MAX_CHARS))).toBe(false)
  })

  it('reads the first min(8, n) pages and the page in view', () => {
    expect(STAGE0_PAGES).toBe(8)
    expect(stage0Pages(3)).toEqual([0, 1, 2])
    expect(stage0Pages(20)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(stage0Pages(20, 14)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 14])
    expect(stage0Pages(20, 3)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(stage0Pages(20, 99)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(stage0Pages(0, 0)).toEqual([])
  })

  it('decides: image-origin skips, one candidate triggers, all text does not, gaps are pending', () => {
    const full = new Map(Array.from({ length: 8 }, (_, i) => [i, chars(500)] as const))
    expect(stage0Decision({ origin: 'image', pageCount: 5, texts: new Map() })).toEqual({
      kind: 'image-origin'
    })
    expect(stage0Decision({ pageCount: 8, texts: full })).toEqual({ kind: 'not-candidate' })
    expect(stage0Decision({ pageCount: 8, texts: new Map([...full, [5, chars(10)]]) })).toEqual({
      kind: 'candidate',
      pages: [5]
    })
    // The page in view is a scan, the first 8 are text.
    expect(
      stage0Decision({ pageCount: 30, inView: 20, texts: new Map([...full, [20, chars(0)]]) })
    ).toEqual({ kind: 'candidate', pages: [20] })
    expect(stage0Decision({ pageCount: 30, inView: 20, texts: full })).toEqual({
      kind: 'pending',
      missing: [20]
    })
    expect(stage0Decision({ pageCount: 0, texts: new Map() })).toEqual({ kind: 'not-candidate' })
  })
})

describe('runStage0', () => {
  const fakePdf = (numPages: number): PDFDocumentProxy => ({ numPages }) as PDFDocumentProxy

  it('reads at most 8 pages plus the page in view of a text PDF', async () => {
    const seen: number[] = []
    const d = await runStage0(
      { pdf: fakePdf(40) },
      {
        inView: 33,
        extract: async (_pdf, i) => {
          seen.push(i)
          return chars(400)
        }
      }
    )
    expect(d).toEqual({ kind: 'not-candidate' })
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 33])
  })

  it('stops at the first candidate; an unreadable page counts as one', async () => {
    const seen: number[] = []
    const d = await runStage0(
      { pdf: fakePdf(40) },
      {
        extract: async (_pdf, i) => {
          seen.push(i)
          if (i === 2) throw new Error('broken page')
          return chars(400)
        }
      }
    )
    expect(d).toEqual({ kind: 'candidate', pages: [2] })
    expect(seen).toEqual([0, 1, 2])
  })

  it('never extracts an imported-image source', async () => {
    // Counted, not thrown: runStage0 swallows an extractor error (the page becomes a candidate),
    // so a throwing extractor could not tell whether it was called.
    let calls = 0
    const d = await runStage0(
      { pdf: fakePdf(3), origin: 'image' },
      {
        extract: async () => {
          calls++
          return chars(0)
        }
      }
    )
    expect(d).toEqual({ kind: 'image-origin' })
    expect(calls).toBe(0)
  })

  it('stops when aborted (the source closed)', async () => {
    const ac = new AbortController()
    const seen: number[] = []
    const d = await runStage0(
      { pdf: fakePdf(8) },
      {
        signal: ac.signal,
        extract: async (_pdf, i) => {
          seen.push(i)
          if (i === 1) ac.abort()
          return chars(400)
        }
      }
    )
    expect(seen).toEqual([0, 1])
    expect(d.kind).toBe('pending')
  })

  it('with the real search extractor: scan and near-scanned pages are candidates, text is not', async () => {
    const s = await scan('near-scanned-bates')
    const scanPdf = await open(await fillPage(s.raster, 150))
    expect(await runStage0({ pdf: scanPdf })).toEqual({ kind: 'candidate', pages: [0] })

    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const words = 'The harbour office opens at seven and closes when the last ferry has docked.'
    const textPage = doc.addPage([612, 792])
    for (let i = 0; i < 6; i++) textPage.drawText(words, { x: 72, y: 700 - i * 14, size: 10, font })
    const stamp = doc.addPage([612, 792])
    stamp.drawText('PDFX-000123', { x: 500, y: 20, size: 9, font })
    const pdf = await open(await doc.save())
    const t0 = await extractPageText(pdf, 0)
    expect(visibleChars(t0)).toBeGreaterThan(CANDIDATE_MAX_CHARS)
    expect(await runStage0({ pdf }, { extract: extractPageText })).toEqual({
      kind: 'candidate',
      pages: [1]
    })
  })
})
