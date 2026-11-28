// Stage 1 triage against the real PDFium WASM (DESIGN.md §3.4.1, §3.4.3), through the raster
// thread's own entry point (RasterEngine.triage): every page class on a fixture built at test time,
// d_eff through rotated, skewed, Form-nested and strip placements, the DPI table, encryption, the
// broken-ToUnicode signal, and the JPX SIZ pre-check refusing without ever decoding the image.

import fontkit from '@pdf-lib/fontkit'
import { PDFDict, PDFDocument, PDFName, degrees } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'

import { loadNodeSynthDeps } from '../../../shared/ocr/test-utils/node-deps'
import type { PageSignals, TriagePage } from '../../../shared/ocr/triage'
import { RasterEngine } from './raster-core'
import { loadTestPdfium, type TestPdfium } from '../test-utils/pdfium-node'
import {
  addText,
  encryptedScan,
  fillPage,
  imageXObject,
  j2k,
  jp2,
  jpxPage,
  paragraphItems,
  placedScan,
  scan,
  stripScan
} from '../test-utils/triage-fixtures'
import { SAMPLE_SENTENCES } from '../../../shared/ocr/test-utils/synth'

let mod: TestPdfium

beforeAll(async () => {
  mod = await loadTestPdfium()
})

interface Triaged {
  pages: TriagePage[]
  signals: Map<number, PageSignals>
}

function triage(bytes: Uint8Array, pages = [0], m: TestPdfium = mod): Triaged {
  const sab = new SharedArrayBuffer(bytes.length)
  const view = new Uint8Array(sab)
  view.set(bytes)
  const engine = new RasterEngine(m)
  engine.attach('s', view)
  const signals = new Map<number, PageSignals>()
  const out = engine.triage('s', pages, (i, s) => signals.set(i, s))
  engine.closeAll()
  if (!Array.isArray(out)) throw new Error(`PDFium could not open the fixture: ${out.pdfiumError}`)
  return { pages: out, signals }
}

const one = (bytes: Uint8Array): TriagePage & { signals: PageSignals } => {
  const t = triage(bytes)
  return { ...t.pages[0], signals: t.signals.get(0)! }
}

const WORDS = SAMPLE_SENTENCES.join(' ').split(' ')

describe('page classes on built fixtures', () => {
  it('a plain scan is `scanned`; its DPI comes from the image (150 → clamped to 300)', async () => {
    const s = await scan('near-scanned-bates')
    const t = one(await fillPage(s.raster, 150))
    expect(t.pageClass).toBe('scanned')
    expect(t.effectiveDpi).toBeCloseTo(150, 6)
    expect(t.renderDpi).toBe(300)
    expect(t.raster).toEqual({ width: 2550, height: 3300 })
    expect(t.imageOrigin).toBe(false)
    expect(t.bitsPerPixel).toBe(8)
    expect(t.signals.cov).toBeCloseTo(1, 6)
    expect(t.nativeWords).toBeUndefined()
  })

  it('fax-header: ~80 chars of vector header over a 200 DPI fax is `near-scanned` by AREA', async () => {
    const s = await scan('fax-header')
    expect(s.gt.dpi).toBe(200)
    const header =
      'From +1 555 0100 Harbour Office  To +1 555 0199  Page 1/3  2026-11-27 09:14  Received'
    const bytes = await addText(await fillPage(s.raster, 200), [
      { text: header, x: 36, y: 772, size: 8 }
    ])
    const t = one(bytes)
    expect(t.pageClass).toBe('near-scanned')
    // A count-only rule would have called this `mixed`: the header is past 40 visible chars.
    expect(t.signals.visible).toBeGreaterThanOrEqual(40)
    expect(t.signals.textArea).toBeLessThan(0.03)
    expect(t.signals.band).toBeLessThanOrEqual(0.1)
    expect(t.effectiveDpi).toBeCloseTo(200, 6)
    expect(t.bitsPerPixel).toBe(1)
    expect(t.renderDpi).toBe(300)
    // Its visible native words come back in the overlay frame, at the top of the page.
    const words = t.nativeWords!.map((w) => w.t)
    expect(words).toEqual(header.split(/\s+/))
    for (const w of t.nativeWords!) {
      expect(w.y0).toBeGreaterThan(765)
      expect(w.y1).toBeLessThan(792)
      expect(w.x1).toBeGreaterThan(w.x0)
    }
  })

  it('near-scanned-bates: a scan plus a vector Bates number is `near-scanned` by count', async () => {
    const s = await scan('near-scanned-bates')
    const bytes = await addText(await fillPage(s.raster, 150), [
      { text: 'PDFX-000123', x: 500, y: 20, size: 9 }
    ])
    const t = one(bytes)
    expect(t.pageClass).toBe('near-scanned')
    expect(t.signals.visible).toBe(11)
    expect(t.nativeWords).toEqual([expect.objectContaining({ t: 'PDFX-000123' })])
    const w = t.nativeWords![0]
    expect(w.x0).toBeGreaterThan(499)
    expect(w.y0).toBeGreaterThan(17)
    expect(w.y1).toBeLessThan(32)
  })

  it('a full-page background image under real body text is `mixed`, not near-scanned', async () => {
    const s = await scan('near-scanned-bates')
    const bytes = await addText(
      await fillPage(s.raster, 150),
      paragraphItems(WORDS, { x: 72, y: 72, w: 468, h: 648 }, 11)
    )
    const t = one(bytes)
    expect(t.signals.cov).toBeGreaterThan(0.99)
    expect(t.signals.textArea).toBeGreaterThan(0.03)
    expect(t.pageClass).toBe('mixed')
    expect(t.nativeWords).toBeUndefined()
  })

  it('a mixed page: a photo on a third of the page plus paragraphs', async () => {
    const s = await scan('near-scanned-bates')
    const doc = await PDFDocument.create()
    const page = doc.addPage([612, 792])
    const img = imageXObject(doc, s.raster)
    page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Im0: img } }))
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.stream('q 300 0 0 388 72 360 cm /Im0 Do Q'))
    )
    const bytes = await addText(
      await doc.save(),
      paragraphItems(WORDS, { x: 72, y: 72, w: 468, h: 270 }, 10)
    )
    const t = one(bytes)
    expect(t.signals.cov).toBeCloseTo((300 * 388) / (612 * 792), 3)
    expect(t.pageClass).toBe('mixed')
  })

  it('born-digital text is `text`; an empty page is `blank`', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([612, 792])
    doc.addPage([612, 792])
    const base = await doc.save()
    const bytes = await addText(base, paragraphItems(WORDS, { x: 72, y: 72, w: 468, h: 648 }, 11))
    const t = triage(bytes, [0, 1])
    expect(t.pages.map((p) => p.pageClass)).toEqual(['text', 'blank'])
    // No image: the fallback DPI.
    expect(t.pages[0]).toMatchObject({ renderDpi: 300, effectiveDpi: null, bitsPerPixel: null })
  })

  it('ocr-foreign: a scan with an invisible (3 Tr) text layer in another font', async () => {
    const s = await scan('near-scanned-bates')
    const items = s.gt.lines.map((l) => ({
      text: l.text,
      x: s.gt.words[l.words[0]].box.x,
      y: l.baseline * (s.gt.page.height / s.gt.sourcePage.height),
      size: l.size,
      invisible: true,
      font: 'times' as const
    }))
    const t = one(await addText(await fillPage(s.raster, 150), items))
    expect(t.signals.invisible).toBeGreaterThan(200)
    expect(t.signals.visible).toBe(0)
    expect(t.pageClass).toBe('ocr-foreign')
  })

  it('ocr-foreign: Tesseract-style GlyphLessFont text counts as invisible even in mode 0', async () => {
    const s = await scan('near-scanned-bates')
    const bytes = await addText(
      await fillPage(s.raster, 150),
      paragraphItems(WORDS, { x: 72, y: 72, w: 468, h: 648 }, 11),
      { renameFont: 'GlyphLessFont' }
    )
    const t = one(bytes)
    expect(t.signals.visible).toBe(0)
    expect(t.pageClass).toBe('ocr-foreign')
  })

  it('broken-text: a page whose font has an empty ToUnicode (FPDFText_HasUnicodeMapError = 1)', async () => {
    const deps = await loadNodeSynthDeps()
    const doc = await PDFDocument.create()
    doc.registerFontkit(fontkit)
    const font = await doc.embedFont(deps.fontBytes('dejavu-sans'), { subset: true })
    const page = doc.addPage([612, 792])
    for (const it of paragraphItems(WORDS, { x: 72, y: 400, w: 468, h: 300 }, 11))
      page.drawText(it.text, { x: it.x, y: it.y, size: it.size, font })
    await doc.save() // pdf-lib writes the font objects (and its ToUnicode) on save
    const type0 = doc.context.lookup(font.ref, PDFDict)
    const empty =
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Empty def ' +
      '1 begincodespacerange <0000> <FFFF> endcodespacerange endcmap CMapName currentdict /CMap defineresource pop end end'
    type0.set(PDFName.of('ToUnicode'), doc.context.register(doc.context.stream(empty)))
    const t = one(await doc.save())
    expect(t.signals.quality.mapErrors).toBeGreaterThan(0)
    expect(t.signals.quality.mapErrors).toBe(t.signals.visible)
    expect(t.pageClass).toBe('broken-text')
  })
})

describe('effective density through placements (PR0 composition rule)', () => {
  it('rotated-placement: an image on a 90° matrix; PDFium’s own dpi fields are wrong there', async () => {
    const s = await scan('rotated-placement')
    const { width: pw, height: ph } = s.raster // 1650 × 1275 (landscape) at 150 DPI
    // Placed sideways at 360 DPI on a portrait page: x-edge (0, H) carries the 1650 px.
    const W = (ph * 72) / 360 // 255 pt
    const H = (pw * 72) / 360 // 330 pt
    const bytes = await placedScan(s.raster, { width: W, height: H }, [0, H, -W, 0, W, 0])
    const t = one(bytes)
    expect(t.pageClass).toBe('scanned')
    expect(t.effectiveDpi).toBeCloseTo(360, 4)
    expect(t.renderDpi).toBe(360)
    expect(Math.abs(t.raster!.width - Math.round((W * 360) / 72))).toBeLessThanOrEqual(1)
    expect(Math.abs(t.raster!.width - ph)).toBeLessThanOrEqual(1)

    // PDFium's horizontal/vertical dpi (from the axis-aligned rect) disagree with each other.
    const rt = mod.pdfium
    const p = rt.wasmExports.malloc(bytes.length)
    rt.HEAPU8.set(bytes, p)
    const doc = mod.FPDF_LoadMemDocument(p, bytes.length, '')
    const page = mod.FPDF_LoadPage(doc, 0)
    const obj = mod.FPDFPage_GetObject(page, 0)
    const meta = rt.wasmExports.malloc(28)
    mod.FPDFImageObj_GetImageMetadata(obj, page, meta)
    const dv = new DataView(rt.HEAPU8.buffer)
    const hdpi = dv.getFloat32(meta + 8, true)
    const vdpi = dv.getFloat32(meta + 12, true)
    rt.wasmExports.free(meta)
    mod.FPDF_ClosePage(page)
    mod.FPDF_CloseDocument(doc)
    rt.wasmExports.free(p)
    expect(Math.abs(hdpi - vdpi)).toBeGreaterThan(50)
  })

  it('formxobject-scan: two nested Forms (/Matrix 0.5 then ×2) and a Form under a page cm', async () => {
    const s = await scan('formxobject-scan')
    const W = 612
    const H = 792
    const nested = one(
      await placedScan(
        s.raster,
        { width: W, height: H },
        [W, 0, 0, H, 0, 0],
        [{ matrix: [0.5, 0, 0, 0.5, 0, 0] }, { matrix: [2, 0, 0, 2, 0, 0] }]
      )
    )
    expect(nested.pageClass).toBe('scanned')
    expect(nested.effectiveDpi).toBeCloseTo(150, 4)
    expect(nested.signals.cov).toBeCloseTo(1, 4)
    // The image drawn at half size inside a Form placed under `2 0 0 2 cm`: still 150.
    const underCm = one(
      await placedScan(
        s.raster,
        { width: W, height: H },
        [W / 2, 0, 0, H / 2, 0, 0],
        [{ matrix: [1, 0, 0, 1, 0, 0], ctm: [2, 0, 0, 2, 0, 0] }]
      )
    )
    expect(underCm.effectiveDpi).toBeCloseTo(150, 4)
    // A Form with a 90° /Matrix around a sideways image, two levels deep.
    const r = await scan('rotated-placement')
    const turned = one(
      await placedScan(
        r.raster,
        { width: 612, height: 792 },
        [792, 0, 0, 612, 0, 0],
        [{ matrix: [1, 0, 0, 1, 0, 0] }, { matrix: [0, 1, -1, 0, 612, 0] }]
      )
    )
    expect(turned.effectiveDpi).toBeCloseTo(150, 4)
    expect(turned.signals.cov).toBeCloseTo(1, 4)
  })

  it('skew and a non-90° rotation keep d_eff at the image’s own density', async () => {
    const s = await scan('formxobject-scan') // 1275 × 1650 at 150 DPI
    const W = 612
    const H = 792
    // Shear: the y-edge is longer than H, the x-edge is exactly W → max() = 150.
    const skew = one(
      await placedScan(s.raster, { width: W + 0.3 * H, height: H }, [W, 0, 0.3 * H, H, 0, 0])
    )
    expect(skew.effectiveDpi).toBeCloseTo(150, 4)
    const a = (30 * Math.PI) / 180
    const c = Math.cos(a)
    const sn = Math.sin(a)
    const rot = one(
      await placedScan(s.raster, { width: 1400, height: 1400 }, [
        W * c,
        W * sn,
        -H * sn,
        H * c,
        500,
        50
      ])
    )
    expect(rot.effectiveDpi).toBeCloseTo(150, 3)
    expect(rot.pageClass).toBe('scanned')
  })

  it('strip-scan: four strips cover the page; the dominant strip gives the density', async () => {
    const s = await scan('strip-scan')
    const t = one(await stripScan(s.raster, 150, 4))
    expect(t.pageClass).toBe('scanned')
    expect(t.signals.cov).toBeCloseTo(1, 4)
    expect(t.effectiveDpi).toBeCloseTo(150, 4)
  })
})

describe('the DPI table on scans (§3.4.3)', () => {
  it('clamps scans to 300–400 and leaves an in-range density alone', async () => {
    const s = await scan('rotated-placement') // 1650 × 1275 px
    for (const [dpi, want] of [
      [600, 400],
      [350, 350],
      [100, 300]
    ] as const) {
      const W = (s.raster.width * 72) / dpi
      const H = (s.raster.height * 72) / dpi
      const t = one(await placedScan(s.raster, { width: W, height: H }, [W, 0, 0, H, 0, 0]))
      expect(t.effectiveDpi).toBeCloseTo(dpi, 3)
      expect(t.renderDpi, `${dpi}`).toBe(want)
      expect(Math.abs(t.raster!.width - Math.round((W * want) / 72))).toBeLessThanOrEqual(1)
    }
  })
})

describe('encryption → protected (§3.0 #17)', () => {
  it('RC4-128 (R3) and AES-256 (R6) owner-password scans are `protected` on every page', async () => {
    const s = await scan('encrypted-owner')
    for (const R of [3, 6] as const) {
      const t = triage(encryptedScan(s.raster, 100, R))
      expect(t.pages).toEqual([
        {
          index: 0,
          pageClass: 'protected',
          renderDpi: null,
          raster: null,
          effectiveDpi: null,
          bitsPerPixel: null,
          imageOrigin: false
        }
      ])
    }
    // The unencrypted control: the same writer without a handler is a scan.
    const plain = one(await fillPage(s.raster, 100))
    expect(plain.pageClass).toBe('scanned')
  })

  it('a user-password file does not open (PDFium error 4)', async () => {
    const s = await scan('encrypted-owner')
    const bytes = encryptedScan(s.raster, 100, 6, { user: 'u' })
    const sab = new SharedArrayBuffer(bytes.length)
    new Uint8Array(sab).set(bytes)
    const engine = new RasterEngine(mod)
    engine.attach('s', new Uint8Array(sab))
    expect(engine.triage('s', [0])).toEqual({ pdfiumError: 4 })
    engine.closeAll()
  })

  it('a page past the end is `page-missing`', async () => {
    const s = await scan('near-scanned-bates')
    expect(triage(await fillPage(s.raster, 150), [3]).pages[0]).toMatchObject({
      index: 3,
      pageClass: null,
      failure: 'page-missing'
    })
  })
})

describe('the JPX SIZ pre-check (§3.4.1), without ever decoding the image', () => {
  /** PDFium with a tripwire on the one call that would decode a JPX image. */
  function noJpxDecode(): { m: TestPdfium; decodes: () => number } {
    let decodes = 0
    const m = {
      ...mod,
      FPDFImageObj_GetImageMetadata: (obj: number, page: number, meta: number) => {
        if (page) decodes++
        return mod.FPDFImageObj_GetImageMetadata(obj, page, meta)
      },
      FPDFImageObj_GetBitmap: () => {
        throw new Error('decoded')
      },
      FPDF_RenderPageBitmap: () => {
        throw new Error('rendered')
      }
    } as unknown as TestPdfium
    return { m, decodes: () => decodes }
  }

  const run = (bytes: Uint8Array): TriagePage => {
    const { m, decodes } = noJpxDecode()
    const t = triage(bytes, [0], m).pages[0]
    expect(decodes()).toBe(0)
    return t
  }

  it('refuses every subsampled codestream (100% detection)', async () => {
    const variants: Array<Array<[number, number]>> = [
      [
        [1, 1],
        [2, 2],
        [2, 2]
      ], // 4:2:0
      [
        [1, 1],
        [2, 1],
        [2, 1]
      ], // 4:2:2
      [
        [1, 1],
        [1, 2],
        [1, 1]
      ], // vertical only
      [[2, 2]] // a subsampled single component
    ]
    for (const sub of variants) {
      const cs = sub.length === 3 ? 'DeviceRGB' : 'DeviceGray'
      const data = j2k({ width: 64, height: 64, components: sub.length, sub })
      const t = run(await jpxPage(data, { width: 64, height: 64, colorSpace: cs }))
      expect(t.refused, JSON.stringify(sub)).toBe('jpx-subsampled')
      // The class and DPI are still reported: only the render is refused.
      expect(t.pageClass).toBe('scanned')
      expect(t.effectiveDpi).toBeCloseTo((64 * 72) / 612, 2)
    }
  })

  it('refuses a component count that does not match the colour space', async () => {
    const data = j2k({ width: 64, height: 64, components: 3 })
    expect(
      run(await jpxPage(data, { width: 64, height: 64, colorSpace: 'DeviceGray' })).refused
    ).toBe('jpx-components')
    const grey = j2k({ width: 64, height: 64, components: 1 })
    expect(run(await jpxPage(grey, { width: 64, height: 64, colorSpace: 'icc3' })).refused).toBe(
      'jpx-components'
    )
    // JP2 colr says sRGB, codestream has 1 component, no PDF colour space.
    const wrapped = jp2(grey, { width: 64, height: 64, components: 1, enumcs: 16 })
    expect(run(await jpxPage(wrapped, { width: 64, height: 64, colorSpace: null })).refused).toBe(
      'jpx-components'
    )
  })

  it('accepts full-size grey and RGB, from the PDF colour space or the JP2 header', async () => {
    const grey = j2k({ width: 64, height: 64, components: 1 })
    const rgbData = j2k({ width: 64, height: 64, components: 3 })
    const cases: Array<[Uint8Array, string | 'icc3' | null, number]> = [
      [grey, 'DeviceGray', 8],
      [rgbData, 'DeviceRGB', 24],
      [rgbData, 'icc3', 24],
      [jp2(grey, { width: 64, height: 64, components: 1, enumcs: 17 }), null, 8],
      [jp2(rgbData, { width: 64, height: 64, components: 3, enumcs: 16 }), null, 24]
    ]
    for (const [data, cs, bpp] of cases) {
      const t = run(await jpxPage(data, { width: 64, height: 64, colorSpace: cs }))
      expect(t.refused, String(cs)).toBeUndefined()
      // From the SIZ (bits × components): never from PDFium's metadata, which would decode.
      expect(t.bitsPerPixel).toBe(bpp)
    }
  })

  it('refuses a raw codestream with no colour space anywhere', async () => {
    const grey = j2k({ width: 64, height: 64, components: 1 })
    expect(run(await jpxPage(grey, { width: 64, height: 64, colorSpace: null })).refused).toBe(
      'jpx-no-colour-space'
    )
  })

  it('the raster thread refuses to RENDER such a page too (render-time guard, no decode)', async () => {
    const data = j2k({
      width: 64,
      height: 64,
      components: 3,
      sub: [
        [1, 1],
        [2, 2],
        [2, 2]
      ]
    })
    const bytes = await jpxPage(data, { width: 64, height: 64, colorSpace: 'DeviceRGB' })
    const { m, decodes } = noJpxDecode()
    const sab = new SharedArrayBuffer(bytes.length)
    new Uint8Array(sab).set(bytes)
    const engine = new RasterEngine(m)
    engine.attach('s', new Uint8Array(sab))
    expect(
      engine.render({
        src: 's',
        index: 0,
        dpi: 72,
        userUnit: 1,
        frame: { width: 612, height: 792 }
      })
    ).toEqual({ kind: 'failed', status: 'failed', reason: 'image-format' })
    expect(decodes()).toBe(0)
    engine.closeAll()
  })
  it('checks every JPX image on the page, not only the dominant one', async () => {
    const good = j2k({ width: 64, height: 64, components: 1 })
    const bad = j2k({ width: 8, height: 8, components: 1, sub: [[2, 2]] })
    const t = run(
      await jpxPage(good, { width: 64, height: 64, colorSpace: 'DeviceGray', decoy: bad })
    )
    expect(t.refused).toBe('jpx-subsampled')
  })
})

describe('/Rotate and the band', () => {
  it('measures the band as the page is shown: a header along the shown top of a /Rotate 90 page', async () => {
    const s = await scan('fax-header')
    const doc = await PDFDocument.load(await fillPage(s.raster, 200))
    doc.getPage(0).setRotation(degrees(90))
    // /Rotate 90 turns user-space x = 0 into the shown top edge, so a line the viewer shows
    // horizontally along the top runs up the user-space left edge.
    const header = 'Received 2026-11-27 09:14 From +1 555 0100 Page 1/3 Harbour Office'
    const bytes = await addText(await doc.save(), [
      { text: header, x: 14, y: 40, size: 8, rotate: 90 }
    ])
    const t = one(bytes)
    expect(t.signals.visible).toBeGreaterThanOrEqual(40)
    expect(t.signals.band).toBeLessThan(0.03)
    expect(t.pageClass).toBe('near-scanned')
    // The render frame is the rotated one: 792 × 612 pt at 300 DPI.
    expect(t.raster).toEqual({ width: 3300, height: 2550 })
    // Native words in the overlay frame: along the shown top, left to right.
    const w = t.nativeWords!
    expect(w.map((x) => x.t)).toEqual(header.split(' '))
    for (const x of w) expect(x.y0).toBeGreaterThan(590)
    for (let i = 1; i < w.length; i++) expect(w[i].x0).toBeGreaterThan(w[i - 1].x0)
  })
})
