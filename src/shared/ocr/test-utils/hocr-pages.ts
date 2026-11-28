// Pages that make Tesseract emit each hOCR line class (DESIGN.md §3.4.6: ocr_line, ocr_header,
// ocr_caption, ocr_textfloat), recorded once into the replay cache so the hOCR parser is tested on
// REAL engine output (tier 0) without running the engine. Test-only, DOM-free.
//
// Which layout yields which class was found by trial against tesseract.js-core 7.0.0 (PR5):
// - ocr_header: a 16 pt line between two 2-column blocks of 10 pt text (Letter);
// - ocr_caption: an 8 pt line under a grey picture box (Letter);
// - ocr_textfloat: PR0's `twocol10` page (A4, bold 18 pt title, bold 12 pt section headings, two
//   columns of 10 pt text over a seeded vocabulary), ported from spike/ocr/engine/make-pages.mjs.
// Synth presets (one font per page, no bold) produced none of the three.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'

import type { GreyImage } from './degrade'
import type { Rasterizer } from './pdfium-raster'
import { SAMPLE_SENTENCES } from './synth'

export const HOCR_PAGE_IDS = ['hocr-header', 'hocr-caption', 'hocr-textfloat'] as const
export type HocrPageId = (typeof HOCR_PAGE_IDS)[number]

export const HOCR_PAGE_DPI = 300

interface Ctx {
  page: PDFPage
  font: PDFFont
  width: number
}

function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const w of text.split(' ')) {
    const t = cur ? `${cur} ${w}` : w
    if (cur && font.widthOfTextAtSize(t, size) > width) {
      out.push(cur)
      cur = w
    } else cur = t
  }
  if (cur) out.push(cur)
  return out
}

/** Two columns of 10 pt sample text from `top` down to `bottom` (pt, PDF y). */
function columns(c: Ctx, top: number, bottom: number, offset: number): void {
  const margin = 36
  const gutter = 24
  const colW = (c.width - 2 * margin - gutter) / 2
  const text = [...SAMPLE_SENTENCES.slice(offset), ...SAMPLE_SENTENCES.slice(0, offset)].join(' ')
  const lines = wrap(c.font, text, 10, colW)
  const lead = 13
  let k = 0
  for (let col = 0; col < 2; col++)
    for (let y = top - 10; y > bottom && k < lines.length; y -= lead, k++)
      c.page.drawText(lines[k], {
        x: margin + col * (colW + gutter),
        y,
        size: 10,
        font: c.font,
        color: rgb(0, 0, 0)
      })
}

async function headerPage(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const c = { page, font, width: 612 }
  columns(c, 756, 500, 0)
  page.drawText('A quiet printer in the corner', { x: 200, y: 440, size: 16, font })
  columns(c, 400, 36, 9)
  return doc.save()
}

async function captionPage(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const lines = wrap(font, SAMPLE_SENTENCES.join(' '), 10, 540)
  for (let i = 0; i < lines.length && 746 - i * 13 > 470; i++)
    page.drawText(lines[i], { x: 36, y: 746 - i * 13, size: 10, font })
  page.drawRectangle({ x: 156, y: 220, width: 300, height: 200, color: rgb(0.3, 0.3, 0.3) })
  page.drawText('Figure 1: the harbour office at dawn.', { x: 200, y: 200, size: 8, font })
  for (let i = 0; i < 6; i++)
    page.drawText('More body text follows here in plain words for the reader.', {
      x: 36,
      y: 170 - i * 13,
      size: 10,
      font
    })
  return doc.save()
}

// PR0's twocol10 (spike/ocr/engine/make-pages.mjs, seed 2210), unchanged in layout and text.
const VOCAB = (
  'the of and to in is was for that with as on by at from this be are or which an it not have ' +
  'has were but all their more one can been its other also new two first after time years such ' +
  'into most only over many some between used these may would people under state when about ' +
  'well during three world through while system where part number since however later both city ' +
  'public company several each development known government early area national including ' +
  'water report office market account research process service history general order record ' +
  'summary payment invoice contract balance quarter percent annual customer delivery address ' +
  'section table figure value result method analysis sample measure average total period ' +
  'document page printed scanned recognition engine language letter paragraph column heading'
).split(/\s+/)
const CAPS =
  'London Paris Berlin Madrid January March October Monday Smith Johnson Acme Northwind'.split(' ')

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function sentence(r: () => number): string {
  const n = 6 + Math.floor(r() * 10)
  const ws: string[] = []
  for (let i = 0; i < n; i++) {
    const x = r()
    if (x < 0.06) ws.push(CAPS[Math.floor(r() * CAPS.length)])
    else if (x < 0.1) ws.push(String(Math.floor(r() * 9000) + 10))
    else ws.push(VOCAB[Math.floor(r() * VOCAB.length)])
  }
  ws[0] = ws[0][0].toUpperCase() + ws[0].slice(1)
  if (r() < 0.2) ws[Math.floor(n / 2)] += ','
  return ws.join(' ') + '.'
}

async function textfloatPage(): Promise<Uint8Array> {
  const A4: [number, number] = [595.28, 841.89]
  const doc = await PDFDocument.create({ updateMetadata: false })
  const page = doc.addPage(A4)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const r = mulberry32(2210)
  const margin = 56
  const gutter = 24
  const body = 10
  const colW = (A4[0] - 2 * margin - gutter) / 2
  const lead = body * 1.25
  const draw = (text: string, size: number, f: PDFFont, x: number, y: number): void =>
    page.drawText(text, { x, y, size, font: f, color: rgb(0, 0, 0) })
  let y = A4[1] - margin - 18
  draw('Synthetic test page twocol10', 18, bold, margin, y)
  y -= 30
  const top = y
  for (let c = 0; c < 2; c++) {
    y = top
    const x = margin + c * (colW + gutter)
    let para = 0
    while (y > margin + lead) {
      if (para % 3 === 0) {
        if (y < margin + 3 * lead) break
        draw(
          `Section ${c + 1}.${para / 3 + 1} ${VOCAB[Math.floor(r() * VOCAB.length)]}`,
          12,
          bold,
          x,
          y
        )
        y -= 12 * 1.6
      }
      let text = ''
      for (let s = 0; s < 3 + Math.floor(r() * 3); s++) text += (text ? ' ' : '') + sentence(r)
      for (const l of wrap(font, text, body, colW)) {
        if (y < margin) break
        draw(l, body, font, x, y)
        y -= lead
      }
      y -= lead * 0.6
      para++
    }
  }
  return doc.save()
}

const BUILDERS: Record<HocrPageId, () => Promise<Uint8Array>> = {
  'hocr-header': headerPage,
  'hocr-caption': captionPage,
  'hocr-textfloat': textfloatPage
}

/** The page's vector PDF and its grey raster at 300 DPI. */
export async function hocrPage(
  id: HocrPageId,
  rasterize: Rasterizer
): Promise<{ pdf: Uint8Array; raster: GreyImage; dpi: number }> {
  const pdf = await BUILDERS[id]()
  return { pdf, raster: rasterize(pdf, HOCR_PAGE_DPI), dpi: HOCR_PAGE_DPI }
}
