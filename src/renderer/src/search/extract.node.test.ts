// extractPageText against real pdf.js (the legacy build, pdf.js's Node entry) on a pdf-lib fixture:
// the searchable text, and where a match lands on a page with an intrinsic /Rotate.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { degrees, PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { extractPageText } from './extract'
import { textMatchRects } from './geometry'

const SIZE = 12
let helloWidth = 0
let helloWorldWidth = 0
let pdf: PDFDocumentProxy

beforeAll(async () => {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  helloWidth = font.widthOfTextAtSize('Hello ', SIZE)
  helloWorldWidth = font.widthOfTextAtSize('Hello World', SIZE)

  const rotated = doc.addPage([612, 792])
  rotated.setRotation(degrees(90))
  rotated.drawText('Hello World', { x: 100, y: 700, size: SIZE, font })
  rotated.drawText('An exam-', { x: 100, y: 600, size: SIZE, font })
  rotated.drawText('ple of a café.', { x: 100, y: 586, size: SIZE, font })

  doc.addPage([612, 792]) // no text at all

  const bytes = await doc.save()
  const task = getDocument({ data: bytes, verbosity: 0 })
  pdf = (await task.promise) as unknown as PDFDocumentProxy
})

afterAll(async () => {
  await pdf?.destroy()
})

describe('extractPageText (real pdf.js)', () => {
  it('normalizes the page text, joining the hyphenated word across lines', async () => {
    const pt = await extractPageText(pdf, 0)
    expect(pt.norm).toBe('hello world an example of a cafe.')
  })

  it('places a match in the rotated display frame', async () => {
    const pt = await extractPageText(pdf, 0)
    const at = pt.norm.indexOf('world')
    const [rect] = textMatchRects(pt, at, at + 5)
    // /Rotate 90: display x follows user y (the 12 pt line at baseline 700), display y follows
    // user x. The per-character split is proportional, so allow a few points along the line.
    expect(rect.x).toBeGreaterThan(700 - 4)
    expect(rect.x + rect.w).toBeLessThan(700 + SIZE + 1)
    expect(rect.w).toBeGreaterThan(SIZE * 0.6)
    expect(Math.abs(rect.y - (100 + helloWidth))).toBeLessThan(5)
    expect(Math.abs(rect.y + rect.h - (100 + helloWorldWidth))).toBeLessThan(2)
  })

  it('gives an empty text for a page without any', async () => {
    const pt = await extractPageText(pdf, 1)
    expect(pt.norm).toBe('')
    expect(pt.items.filter((i) => i.str.trim())).toHaveLength(0)
  })
})
