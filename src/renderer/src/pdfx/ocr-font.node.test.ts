import fontkit from '@pdf-lib/fontkit'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'

import { pack, type OcrPage } from '../../../shared/ocr/types'
import {
  GLYPHLESS_TTF_FONTBBOX,
  GLYPHLESS_TTF_NO_CONTOUR,
  GLYPHLESS_TTF_ZERO_AREA
} from './ocr-glyphless-ttf'
import {
  BFCHAR_BLOCK,
  glyphlessTtf,
  OCR_FONT_NAME,
  OcrFontCache,
  toUnicodeCMap,
  widthsArray
} from './ocr-font'
import { appendOcrLayer, dropOcrLayers } from './ocr-layer'
import { decodeStream } from './test-utils/ocr-layer'

const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

interface PathCommand {
  command: string
  args: number[]
}
/** fontkit's Path type omits `commands`; it is there at runtime. */
const commands = (g: { path: unknown }): PathCommand[] =>
  (g.path as { commands: PathCommand[] }).commands

const onePage = (words: string[]): OcrPage => ({
  v: 1,
  engineId: 'test',
  dataHashes: {},
  langs: ['eng'],
  pipelineVersion: 1,
  pageClass: 'scanned',
  renderDpi: 300,
  physDpi: 300,
  orientation: 0,
  skewDeg: 0,
  meanConfCal: null,
  confSource: 'none',
  status: 'ok',
  lines: [
    {
      angle: 0,
      size: 12,
      words: words.map((t, i) => ({ t, x: 10 + 60 * i, y: 100, w: 50, conf: null, confCal: null }))
    }
  ]
})

/** The finalized font's pieces, resolved. */
function fontParts(doc: PDFDocument, ref: PDFRef) {
  const ctx = doc.context
  const type0 = ctx.lookup(ref, PDFDict)
  const cidFont = ctx.lookup(type0.lookup(PDFName.of('DescendantFonts'), PDFArray).get(0), PDFDict)
  const desc = cidFont.lookup(PDFName.of('FontDescriptor'), PDFDict)
  const text = (s: PDFStream): string => new TextDecoder().decode(decodeStream(s))
  return {
    type0,
    cidFont,
    desc,
    toUnicode: text(type0.lookup(PDFName.of('ToUnicode'), PDFStream)),
    gidMap: decodeStream(cidFont.lookup(PDFName.of('CIDToGIDMap'), PDFStream)),
    w: cidFont.lookup(PDFName.of('W'), PDFArray),
    ttf: decodeStream(desc.lookup(PDFName.of('FontFile2'), PDFStream))
  }
}

/** bfchar entries of a ToUnicode CMap: [cid, utf16 hex] and the size of every block. */
function parseCMap(cmap: string): { entries: [number, string][]; blocks: number[] } {
  const blocks: number[] = []
  const entries: [number, string][] = []
  const re = /(\d+) beginbfchar\n([\s\S]*?)endbfchar/g
  for (let m = re.exec(cmap); m; m = re.exec(cmap)) {
    const rows = m[2].trim().split('\n')
    expect(rows.length).toBe(Number(m[1]))
    blocks.push(rows.length)
    for (const row of rows) {
      const [, cid, dst] = /^<([0-9A-F]{4})> <([0-9A-F]+)>$/.exec(row)!
      entries.push([parseInt(cid, 16), dst])
    }
  }
  return { entries, blocks }
}

describe('glyphless TTF', () => {
  const variants = {
    'zero-area': b64(GLYPHLESS_TTF_ZERO_AREA),
    none: b64(GLYPHLESS_TTF_NO_CONTOUR),
    fontbbox: b64(GLYPHLESS_TTF_FONTBBOX)
  }

  it.each(Object.entries(variants))('%s: em metrics per §3.7.4', (_name, bytes) => {
    const f = fontkit.create(bytes)
    expect(f.unitsPerEm).toBe(1000)
    expect(f.numGlyphs).toBe(3) // .notdef, g1 (narrow), g2 (wide)
    expect(f.ascent).toBe(800)
    expect(f.descent).toBe(-200)
    const os2 = (f as unknown as { 'OS/2': Record<string, number> })['OS/2']
    expect([os2.typoAscender, os2.typoDescender, os2.winAscent, os2.winDescent]).toEqual([
      800, -200, 800, 200
    ])
    expect(f.getGlyph(0).advanceWidth).toBe(500)
    expect(f.getGlyph(1).advanceWidth).toBe(500)
    expect(f.getGlyph(2).advanceWidth).toBe(1000)
    expect(commands(f.getGlyph(0))).toEqual([]) // .notdef has no contour
  })

  it('zero-area: g1 / g2 are one two-point contour spanning their em box, filling nothing', () => {
    const f = fontkit.create(variants['zero-area'])
    for (const [gid, w] of [
      [1, 500],
      [2, 1000]
    ]) {
      const g = f.getGlyph(gid)
      expect(commands(g).map((c) => c.command)).toEqual(['moveTo', 'lineTo', 'closePath'])
      expect(
        commands(g)
          .slice(0, 2)
          .map((c) => c.args)
      ).toEqual([
        [0, -200],
        [w, 800]
      ])
      expect([g.bbox.minX, g.bbox.minY, g.bbox.maxX, g.bbox.maxY]).toEqual([0, -200, w, 800])
    }
    expect([f.bbox.minX, f.bbox.minY, f.bbox.maxX, f.bbox.maxY]).toEqual([0, -200, 1000, 800])
  })

  it('none and fontbbox: no contours; only fontbbox keeps the em box in head', () => {
    for (const [name, bytes] of [
      ['none', variants.none],
      ['fontbbox', variants.fontbbox]
    ] as const) {
      const f = fontkit.create(bytes)
      expect(commands(f.getGlyph(1)), name).toEqual([])
      expect(commands(f.getGlyph(2)), name).toEqual([])
      const head = [f.bbox.minX, f.bbox.minY, f.bbox.maxX, f.bbox.maxY]
      expect(head, name).toEqual(name === 'none' ? [0, 0, 0, 0] : [0, -200, 1000, 800])
    }
  })

  it('the default program is the zero-area variant and stays small', () => {
    expect(glyphlessTtf()).toEqual(variants['zero-area'])
    expect(glyphlessTtf().length).toBeLessThan(1024)
  })
})

describe('toUnicodeCMap / widthsArray', () => {
  it('writes bfchar blocks of at most 100 entries and surrogate pairs above the BMP', () => {
    const entries = Array.from({ length: 250 }, (_, i) => [i + 1, 0x4e00 + i] as const)
    const cmap = toUnicodeCMap([...entries, [251, 0x1d400]])
    const parsed = parseCMap(cmap)
    expect(parsed.blocks).toEqual([100, 100, 51])
    expect(parsed.entries[0]).toEqual([1, '4E00'])
    expect(parsed.entries[250]).toEqual([251, 'D835DC00'])
    expect(cmap).toContain('<0000> <FFFF>')
  })

  it('groups consecutive wide CIDs into runs and leaves narrow ones to /DW', () => {
    const wide = new Set([2, 3, 4, 7])
    expect(widthsArray([1, 2, 3, 4, 5, 7, 9], (c) => wide.has(c))).toEqual([
      2,
      [1000, 1000, 1000],
      7,
      [1000]
    ])
    expect(widthsArray([1, 5], () => false)).toEqual([])
  })
})

describe('OcrFontCache', () => {
  it('allocates one CID per code point from 1, with 500/1000 advances', async () => {
    const doc = await PDFDocument.create()
    const fonts = new OcrFontCache(doc)
    const a = fonts.encode('Aé字𝐀A')
    expect(a.cids).toEqual([1, 2, 3, 4, 1])
    expect(a.hex).toBe('00010002000300040001')
    expect(a.units).toBe(500 + 500 + 1000 + 500 + 500)
    expect(fonts.encode('字').cids).toEqual([3])
    expect(() => fonts.encode('a\u0000')).toThrow(/cannot be mapped/)
    expect(() => fonts.encode('﻿')).toThrow(/cannot be mapped/)
  })

  it('writes the Type0 / CIDFontType2 / descriptor structure of §3.7.4', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([300, 200])
    const fonts = new OcrFontCache(doc)
    appendOcrLayer(page, pack(onePage(['Hi', '字字'])), fonts)
    fonts.finalize(doc)
    const f = fontParts(doc, fonts.ref())
    const name = (d: PDFDict, k: string): string | undefined =>
      d.lookupMaybe(PDFName.of(k), PDFName)?.decodeText()
    expect(name(f.type0, 'Subtype')).toBe('Type0')
    expect(name(f.type0, 'BaseFont')).toBe(OCR_FONT_NAME)
    expect(name(f.type0, 'Encoding')).toBe('Identity-H')
    expect(name(f.cidFont, 'Subtype')).toBe('CIDFontType2')
    expect(f.cidFont.lookup(PDFName.of('DW'), PDFNumber).asNumber()).toBe(500)
    const info = f.cidFont.lookup(PDFName.of('CIDSystemInfo'), PDFDict)
    expect(String(info.get(PDFName.of('Registry')))).toBe('(Adobe)')
    expect(String(info.get(PDFName.of('Ordering')))).toBe('(Identity)')
    expect(String(info.get(PDFName.of('Supplement')))).toBe('0')
    expect(f.desc.lookup(PDFName.of('Flags'), PDFNumber).asNumber()).toBe(4)
    expect(String(f.desc.get(PDFName.of('FontBBox')))).toBe('[ 0 -200 500 800 ]')
    expect(String(f.desc.get(PDFName.of('Ascent')))).toBe('800')
    expect(String(f.desc.get(PDFName.of('Descent')))).toBe('-200')
    expect(String(f.desc.get(PDFName.of('CapHeight')))).toBe('700')
    expect(f.desc.get(PDFName.of('CIDSet'))).toBeUndefined()
    expect(f.ttf).toEqual(glyphlessTtf())
    // CIDs: ' ' = 1, H = 2, i = 3, 字 = 4. Only 字 is wide.
    expect(String(f.w)).toBe('[ 4 [ 1000 ] ]')
    // CIDToGIDMap: 2·(maxCID + 1) bytes; narrow CIDs → GID 1, the wide 字 → GID 2, CID 0 → GID 0.
    expect([...f.gidMap]).toEqual([0, 0, 0, 1, 0, 1, 0, 1, 0, 2])
    const { entries, blocks } = parseCMap(f.toUnicode)
    expect(entries).toEqual([
      [1, '0020'],
      [2, '0048'],
      [3, '0069'],
      [4, '5B57']
    ])
    expect(blocks.every((b) => b <= BFCHAR_BLOCK)).toBe(true)
  })

  it('the tesseract FontBBox variant changes only the descriptor', async () => {
    const doc = await PDFDocument.create()
    const fonts = new OcrFontCache(doc, { bbox: 'tesseract' })
    appendOcrLayer(doc.addPage([300, 200]), pack(onePage(['x'])), fonts)
    fonts.finalize(doc)
    const { desc } = fontParts(doc, fonts.ref())
    expect(desc.lookup(PDFName.of('Flags'), PDFNumber).asNumber()).toBe(5)
    expect(String(desc.get(PDFName.of('FontBBox')))).toBe('[ 0 0 500 1000 ]')
  })

  it('builds every table ONLY from the layer streams still on the pages (redaction rule 5)', async () => {
    const doc = await PDFDocument.create()
    const keep = doc.addPage([300, 200])
    const drop = doc.addPage([300, 200])
    const removed = doc.addPage([300, 200])
    const fonts = new OcrFontCache(doc)
    appendOcrLayer(keep, pack(onePage(['public'])), fonts)
    // A page whose layer is dropped again (Replace/Remove) and a page removed from the output:
    // the characters only they used (张 三 / Ω) must not reach any font table.
    appendOcrLayer(drop, pack(onePage(['张三'])), fonts)
    appendOcrLayer(removed, pack(onePage(['Ω'])), fonts)
    expect(dropOcrLayers(drop)).toBe(1)
    doc.removePage(2)
    fonts.finalize(doc)
    const f = fontParts(doc, fonts.ref())
    const cps = parseCMap(f.toUnicode).entries.map(([, d]) => String.fromCodePoint(parseInt(d, 16)))
    expect(cps.sort().join('')).toBe(' bcilpu')
    expect(String(f.w)).toBe('[ ]') // 张 and 三 were the only wide characters
    // Unused CIDs (including the dropped 张 三 Ω) map to GID 0; no used CID is 0.
    const used = parseCMap(f.toUnicode).entries.map(([c]) => c)
    expect(used).not.toContain(0)
    for (let cid = 0; cid < f.gidMap.length / 2; cid++)
      expect(f.gidMap[2 * cid + 1], `cid ${cid}`).toBe(used.includes(cid) ? 1 : 0)
  })

  it('is single-use: finalize once, on its own document, and no encoding afterwards', async () => {
    const doc = await PDFDocument.create()
    const other = await PDFDocument.create()
    const fonts = new OcrFontCache(doc)
    expect(() => fonts.finalize(other)).toThrow(/another document/)
    fonts.finalize(doc)
    expect(() => fonts.finalize(doc)).toThrow(/twice/)
    expect(() => fonts.encode('a')).toThrow(/after finalize/)
  })

  it('writes nothing when no layer ever asked for the font', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([100, 100])
    const before = doc.context.enumerateIndirectObjects().length
    new OcrFontCache(doc).finalize(doc)
    expect(doc.context.enumerateIndirectObjects().length).toBe(before)
  })
})
