// Unit tests of the layer writer's operators (§3.7.5) and of the pdf-lib append / drop helpers.
// The extractor- and renderer-level suite is ocr-layer-suite.node.test.ts.

import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFStream,
  StandardFonts
} from 'pdf-lib'
import { describe, expect, it } from 'vitest'

import { pack, type OcrPage } from '../../../shared/ocr/types'
import { OcrFontCache } from './ocr-font'
import {
  appendOcrLayer,
  dropOcrLayers,
  isOcrLayerStream,
  num,
  ocrLayerContent,
  pdfLiteral
} from './ocr-layer'
import { allStreams, decodeStream, flowWords, handPage } from './test-utils/ocr-layer'

async function content(page: OcrPage, opts = {}): Promise<string[]> {
  const doc = await PDFDocument.create()
  const out = ocrLayerContent(pack(page), new OcrFontCache(doc), opts)
  if (!out) throw new Error('no content')
  return new TextDecoder().decode(out.bytes).trim().split('\n')
}

const line = (words: string[], opts: { size?: number; gap?: number; charW?: number } = {}) => ({
  y: 100,
  size: opts.size ?? 10,
  x0: 20,
  words: flowWords(words, opts.charW ?? 5, opts.gap ?? 3)
})

describe('ocrLayerContent', () => {
  it('writes q, the BDC property list, one BT/ET per line and EMC Q', async () => {
    const ops = await content(handPage([line(['Hello', 'world']), line(['Two'])]))
    expect(ops[0]).toBe('q')
    expect(ops[1]).toBe('/PDFxOCR <</Lang (en) /MachineGenerated true /Engine (test/replay)>> BDC')
    expect(ops.filter((o) => o.startsWith('BT'))).toEqual([
      'BT 3 Tr /FOcr 10 Tf',
      'BT 3 Tr /FOcr 10 Tf'
    ])
    expect(ops.filter((o) => o === 'ET')).toHaveLength(2)
    expect(ops.slice(-2)).toEqual(['EMC', 'Q'])
  })

  it('tags /Lang from the page’s first language (und when there is none)', async () => {
    const bdc = async (langs: string[]): Promise<string> =>
      (await content(handPage([line(['a'])], { langs }))).find((o) => o.endsWith(' BDC'))!
    expect(await bdc(['jpn', 'eng'])).toContain('/Lang (ja)')
    expect(await bdc(['deu'])).toContain('/Lang (de)')
    expect(await bdc([])).toContain('/Lang (und)')
  })

  it('emits the view-origin and intrinsic cm pair before the marked content', async () => {
    const ops = await content(handPage([line(['a'])]), {
      space: { view: { x: 10, y: -20.5 }, intrinsic: [0, 1, -1, 0, 612, 0] }
    })
    expect(ops.slice(0, 3)).toEqual(['q', '1 0 0 1 10 -20.5 cm', '0 1 -1 0 612 0 cm'])
    // No-op space: no cm at all.
    const plain = await content(handPage([line(['a'])]), {
      space: { view: { x: 0, y: 0 }, intrinsic: null }
    })
    expect(plain.some((o) => o.endsWith(' cm'))).toBe(false)
  })

  it('places every word with its own Tm, Tz before EVERY Tj, and a stretched space per gap', async () => {
    // "Hello" 25 pt wide (5 chars × 5), gap 3 pt, size 10: natural width 5 × 0.5 em = 25 pt.
    const ops = await content(handPage([line(['Hello', 'world'])]))
    const body = ops.filter((o) => o.endsWith('Tj'))
    expect(body).toEqual([
      '1 0 0 1 20 100 Tm 100 Tz <00020003000400040005> Tj',
      '60 Tz <0001> Tj', // gap 3 pt / (0.5 em × 10) = 60 %
      '1 0 0 1 48 100 Tm 100 Tz <00060005000700040008> Tj',
      '100 Tz <0001> Tj' // trailing space, natural width
    ])
    for (const o of body) expect(o).toMatch(/ Tz <[0-9A-F]+> Tj$/)
  })

  it('stretches words with Tz only, clamped to [1, 1000] and never split', async () => {
    const page = handPage([
      {
        y: 50,
        size: 10,
        words: [
          { t: 'wide', x: 0, w: 40 }, // natural 20 → 200 %
          { t: 'tiny', x: 50, w: 0.01 }, // → clamped to 1 %
          { t: 'huge', x: 60, w: 5000 } // → clamped to 1000 %
        ]
      }
    ])
    const tj = (await content(page)).filter((o) => o.includes(' Tm '))
    expect(tj.map((o) => /Tm (\S+) Tz/.exec(o)![1])).toEqual(['200', '1', '1000'])
    expect(tj.every((o) => (o.match(/Tj/g) ?? []).length === 1)).toBe(true)
  })

  it('keeps the natural space width across a gap wider than 3 em (columns, tables)', async () => {
    const shownFor = async (gap: number): Promise<string[]> =>
      (
        await content(
          handPage([
            {
              y: 50,
              size: 10,
              words: [
                { t: 'left', x: 0, w: 20 },
                { t: 'right', x: 20 + gap, w: 25 }
              ]
            }
          ])
        )
      ).filter((o) => o.endsWith('Tj'))
    // shown: [left, the space after it, right, the trailing space]
    const wide = await shownFor(31) // 3.1 em: natural width, the next Tm does the jump
    expect(wide).toHaveLength(4)
    expect(wide[1]).toBe('100 Tz <0001> Tj')
    expect(wide[2]).toMatch(/^1 0 0 1 51 50 Tm /)
    const below = await shownFor(29) // 2.9 em: still stretched, 29 / (0.5 em × 10) = 580 %
    expect(below[1]).toBe('580 Tz <0001> Tj')
  })

  it('keeps ≥ 0.15 em between touching or overlapping words by narrowing the first', async () => {
    // "one" at 0, 15 pt natural (3 × 0.5 em at size 10); the next word starts at 15 + gap.
    const shownFor = async (gap: number, angle = 0): Promise<string[]> =>
      (
        await content(
          handPage([
            {
              y: 50,
              size: 10,
              angle,
              words: [
                { t: 'one', x: 0, w: 15 },
                { t: 'two', x: 15 + gap, w: 15 }
              ]
            }
          ])
        )
      ).filter((o) => o.endsWith('Tj'))
    // gap 0: "one" ends at 13.5 (90 %), the space spans 1.5 pt (30 %), "two" stays at 15.
    expect(await shownFor(0)).toEqual([
      '1 0 0 1 0 50 Tm 90 Tz <000200030004> Tj',
      '30 Tz <0001> Tj',
      '1 0 0 1 15 50 Tm 100 Tz <000500060002> Tj',
      '100 Tz <0001> Tj'
    ])
    // Overlap by 0.2 em: "one" ends at 11.5, the space is again 1.5 pt.
    const overlap = await shownFor(-2)
    expect(overlap[0]).toMatch(/ 76\.667 Tz /)
    expect(overlap[1]).toBe('30 Tz <0001> Tj')
    expect(overlap[2]).toMatch(/^1 0 0 1 13 50 Tm /)
    // A real gap above the minimum is left exactly as measured.
    expect((await shownFor(2))[1]).toBe('40 Tz <0001> Tj')
    // Quarter-turned lines measure along their baseline the same way.
    expect((await shownFor(0, Math.PI / 2))[1]).toBe('30 Tz <0001> Tj')
  })

  it('writes no trailing space after a hyphen, one after anything else', async () => {
    const ops = await content(handPage([line(['inter-']), line(['national'])]))
    const shown = ops.filter((o) => o.endsWith('Tj') || o === 'ET')
    expect(shown).toEqual([
      expect.stringContaining('Tm'),
      'ET',
      expect.stringContaining('Tm'),
      '100 Tz <0001> Tj',
      'ET'
    ])
  })

  it('CJK: no space between CJK words; Tz stretched to meet the next word when the gap is ≤ 2 em', async () => {
    const page = handPage([
      {
        y: 50,
        size: 10,
        words: [
          { t: '東京', x: 0, w: 20 }, // natural 2 × 1 em = 20 pt
          { t: 'の', x: 22, w: 10 }, // gap 2 pt ≤ 2 em → 東京 stretched to 22 pt: 110 %
          { t: '天気', x: 60, w: 20 }, // gap 28 pt > 2 em → not stretched
          { t: 'ABC', x: 85, w: 15 } // CJK → Latin: a real space
        ]
      }
    ])
    const ops = await content(page)
    const shown = ops.filter((o) => o.endsWith('Tj'))
    expect(shown[0]).toMatch(/^1 0 0 1 0 50 Tm 110 Tz <\S+> Tj$/)
    expect(shown[1]).toMatch(/^1 0 0 1 22 50 Tm 100 Tz <\S+> Tj$/)
    expect(shown[2]).toMatch(/^1 0 0 1 60 50 Tm 100 Tz <\S+> Tj$/)
    expect(shown[3]).toBe('100 Tz <0001> Tj') // gap 5 pt / 5 pt
    expect(shown[4]).toMatch(/Tm 100 Tz <\S+> Tj$/)
    expect(shown[5]).toBe('100 Tz <0001> Tj') // trailing space after Latin
    // A line ending in CJK gets no trailing space (the next line continues the sentence).
    const cjkEnd = await content(handPage([{ y: 9, size: 10, words: [{ t: '終', x: 0, w: 10 }] }]))
    expect(cjkEnd.filter((o) => o.endsWith('Tj'))).toHaveLength(1)
  })

  it('rotates Tm with the line angle and follows the baseline for gaps', async () => {
    const angle = Math.PI / 6
    const page = handPage([{ y: 0, size: 10, angle, words: flowWords(['ab', 'cd'], 5, 5) }])
    const ops = await content(page)
    const tm = ops.filter((o) => o.includes(' Tm '))
    expect(tm[0]).toMatch(/^0\.866025 0\.5 -0\.5 0\.866025 0 0 Tm 100 Tz 0 Tc <\S+> Tj$/)
    expect(ops).toContain('100 Tz 0 Tc <0001> Tj') // gap 5 pt along the rotated baseline
  })

  it('oblique lines share one page Tz and fit each word with Tc (bounded widening)', async () => {
    const angle = 0.035 // 2°
    const page = handPage([
      {
        y: 100,
        size: 10,
        angle,
        words: [
          { t: 'abcd', x: 0, w: 20 }, // needs 100 %
          { t: 'efgh', x: 25, w: 16 }, // needs 80 %: Tc (16 − 20) / 4 = −1
          { t: 'ijkl', x: 46, w: 30 } // needs 150 %: +2.5 per glyph, capped at 0.05 em = 0.5
        ]
      },
      { y: 80, size: 10, words: flowWords(['upright'], 5, 0) }
    ])
    const ops = await content(page)
    const shown = ops.filter((o) => o.endsWith('Tj'))
    expect(shown[0]).toMatch(/ Tm 100 Tz 0 Tc <\S+> Tj$/)
    expect(shown[2]).toMatch(/ Tm 100 Tz -1 Tc <\S+> Tj$/)
    expect(shown[4]).toMatch(/ Tm 100 Tz 0\.5 Tc <\S+> Tj$/)
    for (const o of shown.slice(0, 6)) expect(o).toMatch(/^(.* Tm )?100 Tz -?[\d.]+ Tc <\S+> Tj$/)
    // The upright line after it resets Tc (it survives ET) and goes back to per-word Tz.
    expect(ops).toContain('BT 3 Tr 0 Tc /FOcr 10 Tf')
    expect(shown[6]).toMatch(/ Tm 100 Tz <\S+> Tj$/)
  })

  it('cleans word text first: ligatures expanded, empty words skipped', async () => {
    const doc = await PDFDocument.create()
    const fonts = new OcrFontCache(doc)
    const out = ocrLayerContent(
      pack(handPage([{ y: 0, size: 10, words: flowWords(['ﬁnd', '​', 'x'], 5, 2) }])),
      fonts
    )!
    expect(out.words).toBe(2)
    // f, i, n, d, x (+ space): no CID for U+FB01 or U+200B.
    expect(fonts.encode('ﬁ').cids).toEqual([7]) // a new CID: ﬁ was never encoded before
  })

  it('returns null when nothing is left to write', async () => {
    const doc = await PDFDocument.create()
    const fonts = new OcrFontCache(doc)
    expect(ocrLayerContent(pack(handPage([])), fonts)).toBeNull()
    expect(ocrLayerContent(pack(handPage([{ y: 0, size: 10, words: [] }])), fonts)).toBeNull()
    const blank = handPage([{ y: 0, size: 10, words: [{ t: ' ­', x: 0, w: 5 }] }])
    expect(ocrLayerContent(pack(blank), fonts)).toBeNull()
    const zero = handPage([{ y: 0, size: 0, words: [{ t: 'a', x: 0, w: 5 }] }])
    expect(ocrLayerContent(pack(zero), fonts)).toBeNull()
  })

  it('never shows CID 0', async () => {
    const ops = await content(handPage([line(['a', 'b', 'c'])]))
    for (const o of ops)
      for (const hex of o.matchAll(/<([0-9A-F]+)> Tj/g)) {
        for (let i = 0; i < hex[1].length; i += 4) expect(hex[1].slice(i, i + 4)).not.toBe('0000')
      }
  })
})

describe('num / pdfLiteral', () => {
  it('formats PDF numbers compactly', () => {
    expect(num(1)).toBe('1')
    expect(num(1.23456)).toBe('1.235')
    expect(num(-0.0001)).toBe('0')
    expect(num(0.5, 6)).toBe('0.5')
    expect(() => num(NaN)).toThrow()
  })

  it('escapes literal strings', () => {
    expect(pdfLiteral('a(b)\\c')).toBe('(a\\(b\\)\\\\c)')
    expect(pdfLiteral('é\n')).toBe('(\\351\\012)')
  })
})

describe('appendOcrLayer / dropOcrLayers', () => {
  async function scanPage(): Promise<PDFDocument> {
    const doc = await PDFDocument.create()
    const page = doc.addPage([200, 100])
    const font = await doc.embedFont(StandardFonts.Helvetica)
    page.drawText('native', { x: 10, y: 10, size: 10, font })
    return doc
  }
  const ocr = pack(handPage([line(['Hello'])]))

  it('prepends a tagged stream at /Contents index 0 and binds /FOcr', async () => {
    const doc = await scanPage()
    const page = doc.getPage(0)
    const fonts = new OcrFontCache(doc)
    const ref = appendOcrLayer(page, ocr, fonts)!
    const contents = page.node.Contents() as PDFArray
    expect(contents.get(0)).toBe(ref)
    expect(contents.size()).toBeGreaterThan(1)
    const stream = doc.context.lookup(ref, PDFStream)
    expect(stream.dict.get(PDFName.of('PDFxOCRLayer'))).toBe(PDFBool.True)
    expect(isOcrLayerStream(stream)).toBe(true)
    const fontsDict = page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict)
    expect(fontsDict.get(PDFName.of('FOcr'))).toBe(fonts.ref())
    expect(new TextDecoder().decode(decodeStream(stream))).toMatch(/^q\n/)
  })

  it('picks a free resource name when /FOcr is taken by another font', async () => {
    const doc = await scanPage()
    const page = doc.getPage(0)
    page.node.normalize()
    const other = doc.context.register(doc.context.obj({ Type: 'Font' }))
    page.node.setFontDictionary(PDFName.of('FOcr'), other)
    const fonts = new OcrFontCache(doc)
    const ref = appendOcrLayer(page, ocr, fonts)!
    const text = new TextDecoder().decode(decodeStream(doc.context.lookup(ref, PDFStream)))
    expect(text).toContain('/FOcr1 10 Tf')
    const fontsDict = page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict)
    expect(fontsDict.get(PDFName.of('FOcr'))).toBe(other)
    expect(fontsDict.get(PDFName.of('FOcr1'))).toBe(fonts.ref())
  })

  it('creates /Contents on a page that has none, and skips an empty page', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([100, 100])
    page.node.delete(PDFName.of('Contents'))
    const fonts = new OcrFontCache(doc)
    expect(appendOcrLayer(page, pack(handPage([])), fonts)).toBeNull()
    const ref = appendOcrLayer(page, ocr, fonts)
    expect((page.node.Contents() as PDFArray).asArray()).toEqual([ref])
  })

  it('drops only the tagged streams, leaves the rest byte-exact and unbinds the OCR font', async () => {
    // A reopened PDFx output (what Replace / Remove see): bake, finalize, save, load again.
    const src = await scanPage()
    const fonts = new OcrFontCache(src)
    appendOcrLayer(src.getPage(0), ocr, fonts)
    fonts.finalize(src)
    const doc = await PDFDocument.load(await src.save())
    const page = doc.getPage(0)
    const all = (page.node.Contents() as PDFArray).asArray() as PDFRef[]
    const original = all.filter((r) => !isOcrLayerStream(doc.context.lookup(r)))
    expect(original.length).toBe(all.length - 1)
    const before = original.map((r) => decodeStream(doc.context.lookup(r, PDFStream)))
    expect(dropOcrLayers(page)).toBe(1)
    const after = (page.node.Contents() as PDFArray).asArray()
    // Exactly the original streams, byte-exact, and nothing added (no q … Q wrapper).
    expect(after).toEqual(original)
    expect(after.map((r) => decodeStream(doc.context.lookup(r as PDFRef, PDFStream)))).toEqual(
      before
    )
    const fontsDict = page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict)
    expect(fontsDict.get(PDFName.of('FOcr'))).toBeUndefined()
    expect(fontsDict.keys().length).toBe(1) // Helvetica stays
    expect(dropOcrLayers(page)).toBe(0)
  })

  it('drops a layer that is the page’s only /Contents stream', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([100, 100])
    const ref = doc.context.register(doc.context.flateStream('q Q', { PDFxOCRLayer: true }))
    page.node.set(PDFName.of('Contents'), ref)
    expect(dropOcrLayers(page)).toBe(1)
    expect((page.node.Contents() as PDFArray).size()).toBe(0)
    expect(doc.context.lookup(ref)).toBeUndefined()
  })

  /** Everything a raw-bytes reader finds in `bytes`: inflated streams, as latin1 text. */
  async function rawStreams(bytes: Uint8Array): Promise<string[]> {
    return (await allStreams(bytes)).map((s) => new TextDecoder('latin1').decode(s.data))
  }

  /** Bake "Secret Name" onto the scan page, finalize, save: a PDFx output as Replace reopens it. */
  async function bakedSecret(): Promise<{ bytes: Uint8Array; hex: string[] }> {
    const src = await scanPage()
    const fonts = new OcrFontCache(src)
    const ref = appendOcrLayer(src.getPage(0), pack(handPage([line(['Secret', 'Name'])])), fonts)!
    fonts.finalize(src)
    const text = new TextDecoder().decode(decodeStream(src.context.lookup(ref, PDFStream)))
    const hex = [...text.matchAll(/<([0-9A-F]{8,})> Tj/g)].map((m) => m[1])
    return { bytes: await src.save({ useObjectStreams: false }), hex }
  }

  it('Remove: no byte of the old layer or of its font survives the save (raw-bytes oracle)', async () => {
    const { bytes, hex } = await bakedSecret()
    expect(hex).toHaveLength(2) // "Secret", "Name"
    const raw = await rawStreams(bytes)
    expect(raw.some((s) => s.includes('/PDFxOCR <<'))).toBe(true)
    expect(raw.some((s) => s.includes('beginbfchar'))).toBe(true)
    // Reopen (directly, and through copyPages as build.ts does), drop, save.
    for (const copy of [false, true]) {
      let doc = await PDFDocument.load(bytes)
      if (copy) {
        const out = await PDFDocument.create()
        const [p] = await out.copyPages(doc, [0])
        out.addPage(p)
        doc = out
      }
      expect(dropOcrLayers(doc.getPage(0))).toBe(1)
      const saved = await doc.save({ useObjectStreams: false })
      const streams = await rawStreams(saved)
      for (const s of streams) {
        expect(s).not.toContain('PDFxOCR')
        expect(s).not.toContain('beginbfchar')
        for (const h of hex) expect(s).not.toContain(h)
      }
      const text = new TextDecoder('latin1').decode(saved)
      expect(text).not.toContain('PDFxOCR-GlyphLess')
      expect(text).not.toContain('PDFxOCRLayer')
      // The page's own content is still there.
      expect(streams.some((s) => s.includes('Tj') && s.includes('BT'))).toBe(true)
    }
  })

  it('Replace round trips do not pile up objects or /Contents entries', async () => {
    let bytes = (await bakedSecret()).bytes
    const counts: number[] = []
    const lengths: number[] = []
    for (let round = 0; round < 3; round++) {
      const doc = await PDFDocument.load(bytes)
      const page = doc.getPage(0)
      expect(dropOcrLayers(page)).toBe(1)
      const fonts = new OcrFontCache(doc)
      appendOcrLayer(page, pack(handPage([line(['Secret', 'Name'])])), fonts)
      fonts.finalize(doc)
      bytes = await doc.save({ useObjectStreams: false })
      const saved = await PDFDocument.load(bytes)
      counts.push(saved.context.enumerateIndirectObjects().length)
      lengths.push((saved.getPage(0).node.Contents() as PDFArray).size())
    }
    expect(new Set(counts).size).toBe(1)
    expect(lengths).toEqual([2, 2, 2]) // [layer, the page's own stream]
  })

  it('a dropped layer in the SAME document is deleted too (append, drop, finalize)', async () => {
    const doc = await scanPage()
    const fonts = new OcrFontCache(doc)
    const ref = appendOcrLayer(doc.getPage(0), ocr, fonts)!
    expect(dropOcrLayers(doc.getPage(0))).toBe(1)
    fonts.finalize(doc)
    expect(doc.context.lookup(ref)).toBeUndefined()
    const streams = await rawStreams(await doc.save({ useObjectStreams: false }))
    for (const s of streams) expect(s).not.toContain('PDFxOCR')
  })

  it('Remove on one page leaves a font shared with another page’s layer bound and written', async () => {
    // Two pages with ONE indirect /Resources (and Font dict), each with its own layer, saved and
    // reopened: Remove on page 1 only.
    const src = await PDFDocument.create()
    src.addPage([200, 100])
    src.addPage([200, 100])
    const ctx = src.context
    const sharedFont = ctx.register(ctx.obj({}))
    const sharedRes = ctx.register(ctx.obj({ Font: sharedFont }))
    for (const p of src.getPages()) p.node.set(PDFName.of('Resources'), sharedRes)
    const fonts = new OcrFontCache(src)
    for (const p of src.getPages()) appendOcrLayer(p, ocr, fonts)
    // Re-share the (now page-own) Font dicts, as a third-party tool that dedupes would.
    const fontDict = src.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict)
    ctx.assign(sharedFont, fontDict)
    for (const p of src.getPages()) p.node.set(PDFName.of('Resources'), sharedRes)
    fonts.finalize(src)
    const doc = await PDFDocument.load(await src.save({ useObjectStreams: false }))
    const [p1, p2] = doc.getPages()
    const ocrFont = (p: typeof p1) =>
      p.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).get(PDFName.of('FOcr'))
    const bound = ocrFont(p2)
    expect(bound).toBeInstanceOf(PDFRef)
    expect(ocrFont(p1)).toBe(bound)
    expect(dropOcrLayers(p1)).toBe(1)
    expect(ocrFont(p1)).toBeUndefined()
    expect(ocrFont(p2)).toBe(bound) // the shared dict was not mutated
    expect(doc.context.lookup(bound as PDFRef, PDFDict)).toBeDefined() // nor the font deleted
    const saved = await doc.save({ useObjectStreams: false })
    expect(new TextDecoder('latin1').decode(saved)).toContain('PDFxOCR-GlyphLess')
    const reread = await PDFDocument.load(saved)
    expect(ocrFont(reread.getPage(1))).toBeInstanceOf(PDFRef)
  })
})
