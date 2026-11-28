// xobject-trim.ts: every XObject nothing paints leaves every /XObject dictionary; everything a
// page, a form, a pattern, a soft mask, a Type3 glyph or an annotation appearance draws stays.
// The redaction-side leak (one dictionary shared by several pages) is in ocr-redaction.node.test.ts.

import { PDFDict, PDFDocument, PDFName, PDFRef, type PDFContext } from 'pdf-lib'
import { describe, expect, it } from 'vitest'

import { trimXObjects } from './xobject-trim'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

/** A 1 × 1 grey image XObject. */
const image = (ctx: PDFContext): PDFRef =>
  ctx.register(ctx.flateStream(Uint8Array.of(128), { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8 })) // prettier-ignore

/** A Form XObject with `content`, and its own resources when `res` is given. */
const form = (ctx: PDFContext, content: string, res?: Record<string, unknown>): PDFRef =>
  ctx.register(ctx.flateStream(enc(content), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], ...(res ? { Resources: ctx.obj(res as never) } : {}) })) // prettier-ignore

/** The names left in page `i`'s /XObject dictionary. */
const names = (doc: PDFDocument, i = 0): string[] =>
  [...(doc.getPage(i).node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.keys() ?? [])]
    .map((k) => k.decodeText())
    .sort()

/** A one-page document whose content is `content` and whose /XObject dictionary is `xobjects`. */
async function onePage(
  build: (ctx: PDFContext) => { content: string; resources: Record<string, unknown> }
): Promise<PDFDocument> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([100, 100])
  const ctx = doc.context
  const { content, resources } = build(ctx)
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(enc(content))))
  page.node.set(PDFName.of('Resources'), ctx.obj(resources as never))
  return PDFDocument.load(await doc.save())
}

describe('trimXObjects', () => {
  it('keeps what paints, through forms, patterns, soft masks, Type3 glyphs and appearances', async () => {
    const doc = await onePage((ctx) => {
      const inForm = image(ctx)
      const viaCaller = image(ctx)
      const inPattern = image(ctx)
      const inMask = image(ctx)
      const inGlyph = image(ctx)
      const pattern = ctx.register(ctx.flateStream(enc('/P0 Do'), { PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 1, 1], XStep: 1, YStep: 1, Resources: { XObject: { P0: inPattern } } })) // prettier-ignore
      const group = form(ctx, '/G0 Do', { XObject: { G0: inMask } })
      const glyph = ctx.register(ctx.flateStream(enc('0 0 d0 /T0 Do')))
      const t3 = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 1, 1], FontMatrix: [1, 0, 0, 1, 0, 0], CharProcs: { a: glyph }, Encoding: { Type: 'Encoding', Differences: [97, 'a'] }, FirstChar: 97, LastChar: 97, Widths: [1], Resources: { XObject: { T0: inGlyph } } })) // prettier-ignore
      return {
        content: 'q /Im Do Q /Fm Do /Bare Do',
        resources: {
          XObject: {
            Im: image(ctx),
            Fm: form(ctx, '/F0 Do', { XObject: { F0: inForm } }),
            // A form without resources resolves its names in its caller's.
            Bare: form(ctx, '/Caller Do'),
            Caller: viaCaller,
            Unused: image(ctx),
            UnusedForm: form(ctx, '/Im Do')
          },
          Pattern: { Pat: pattern },
          ExtGState: { GS: { SMask: { S: 'Luminosity', G: group } } },
          Font: { T3: t3 }
        }
      }
    })
    const before = names(doc)
    const gone = trimXObjects(doc)
    expect(gone).toHaveLength(2)
    expect(names(doc)).toEqual(before.filter((n) => n !== 'Unused' && n !== 'UnusedForm'))
    // The nested dictionaries keep their entries: every /XObject dictionary of the file still
    // lists its one image (the form's, the pattern's, the soft mask's, the Type3 font's).
    let nested = 0
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      const d = obj instanceof PDFDict ? obj : 'dict' in obj ? (obj as { dict: PDFDict }).dict : undefined // prettier-ignore
      const x = d?.lookupMaybe(PDFName.of('Resources'), PDFDict)?.lookupMaybe(PDFName.of('XObject'), PDFDict) // prettier-ignore
      if (x && d !== doc.getPage(0).node) nested += x.keys().length
    }
    expect(nested).toBe(4)
  })

  it('an appearance stream draws through its own resources; one without any keeps its names everywhere', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([100, 100])
    const ctx = doc.context
    const ap = form(ctx, '/A0 Do', { XObject: { A0: image(ctx) } })
    const bare = form(ctx, '/Loose Do')
    const annots = [ap, bare].map((n) => ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [0, 0, 10, 10], AP: { N: n } }))) // prettier-ignore
    page.node.set(PDFName.of('Annots'), ctx.obj(annots))
    page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Loose: image(ctx), Other: image(ctx) } })) // prettier-ignore
    const out = await PDFDocument.load(await doc.save())
    expect(trimXObjects(out)).toHaveLength(1)
    expect(names(out)).toEqual(['Loose'])
    const apDict = out.context.lookup(out.context.lookup(out.getPage(0).node.Annots()!.get(0), PDFDict).lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N'))) // prettier-ignore
    expect(apDict).toBeDefined()
  })

  it('content it cannot read draws everything its resources list', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([100, 100])
    const ctx = doc.context
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(enc('garbage'), { Filter: 'JBIG2Decode' }))) // prettier-ignore
    page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { A: image(ctx), B: image(ctx) } }))
    const out = await PDFDocument.load(await doc.save())
    expect(trimXObjects(out)).toEqual([])
    expect(names(out)).toEqual(['A', 'B'])
  })

  it('a dictionary shared by two pages loses only what neither page draws', async () => {
    const doc = await PDFDocument.create()
    const ctx = doc.context
    const res = ctx.register(ctx.obj({ XObject: { A: image(ctx), B: image(ctx), C: image(ctx) } }))
    for (const name of ['A', 'B']) {
      const p = doc.addPage([100, 100])
      p.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(enc(`/${name} Do`))))
      p.node.set(PDFName.of('Resources'), res)
    }
    const out = await PDFDocument.load(await doc.save())
    expect(trimXObjects(out)).toHaveLength(1)
    expect(names(out, 0)).toEqual(['A', 'B'])
    expect(names(out, 1)).toEqual(['A', 'B'])
  })
})
