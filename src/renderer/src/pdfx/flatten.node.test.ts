import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'

import { buildPdf, type EditLayer } from './build'
import { alignedX, type Attachment } from './flatten'
import { makePageKey, newOverlayId, type Geom, type Overlay } from '../edit/model'
import {
  pageContent,
  pageFonts,
  stubUnicodeFontFetch,
  stubUnicodeFontFetchFailure
} from '../test-utils/fonts'

afterEach(() => {
  vi.unstubAllGlobals()
})

// 1x1 transparent PNG.
const PNG_1x1 = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
    'base64'
  )
)

async function makeSourcePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([300, 300])
  return doc.save()
}

const geom = (over: Partial<Geom> = {}): Geom => ({
  x: 20,
  y: 20,
  w: 100,
  h: 40,
  rotation: 0,
  opacity: 1,
  ...over
})

function pageImageXObjectCount(doc: PDFDocument, pageIndex: number): number {
  const resources = doc.getPage(pageIndex).node.Resources()
  const xobj = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict)
  return xobj ? xobj.entries().length : 0
}

describe('pure helpers', () => {
  it('alignedX positions a line by alignment within a box', () => {
    expect(alignedX(100, 200, 50, 'left')).toBe(100)
    expect(alignedX(100, 200, 50, 'center')).toBe(175)
    expect(alignedX(100, 200, 50, 'right')).toBe(250)
  })
})

describe('flatten on export', () => {
  const base = (over: Partial<Overlay> & Pick<Overlay, 'type'>): Overlay =>
    ({
      id: newOverlayId(),
      pageKey: makePageKey('a', 0),
      z: 0,
      createdAt: 0,
      geom: geom(),
      ...over
    }) as Overlay

  function editLayer(): EditLayer {
    const overlays = new Map<string, Overlay[]>()
    overlays.set(makePageKey('a', 0), [
      base({ type: 'highlight', color: { r: 1, g: 0.9, b: 0.2 }, z: 0 }),
      base({ type: 'image', attachmentId: 'png1', mime: 'image/png', z: 1 }),
      base({
        type: 'ink',
        paths: [[10, 10, 50, 50, 80, 20]],
        strokeWidth: 2,
        color: { r: 0, g: 0, b: 0 },
        z: 2
      }),
      base({
        type: 'text',
        text: 'Approved\nA. Jara',
        fontSize: 12,
        color: { r: 0.1, g: 0.1, b: 0.1 },
        font: 'Helvetica',
        align: 'center',
        z: 3
      }),
      // Redaction: the source content under it is removed by the external pre-pass; the draw pass
      // paints the box. Kept clear of the other overlays' box on purpose — anything a redaction
      // covers is dropped before flatten (build.ts), and this fixture is about baking every type.
      base({ type: 'redaction', fill: { r: 0, g: 0, b: 0 }, geom: geom({ x: 200, y: 200 }), z: 4 })
    ])
    const attachments = new Map<string, Attachment>([
      ['png1', { bytes: PNG_1x1, mime: 'image/png' }]
    ])
    return { overlays, attachments }
  }

  it('bakes overlays onto the targeted page only, and stays a valid multi-page PDF', async () => {
    const src = await makeSourcePdf(2)
    const pages = [
      { bytes: src, sourceKey: 'a', pageIndex: 0 },
      { bytes: src, sourceKey: 'a', pageIndex: 1 }
    ]
    const out = await buildPdf(pages, editLayer())
    const reloaded = await PDFDocument.load(out)

    expect(reloaded.getPageCount()).toBe(2)
    // The image overlay was on page 0 only.
    expect(pageImageXObjectCount(reloaded, 0)).toBeGreaterThan(0)
    expect(pageImageXObjectCount(reloaded, 1)).toBe(0)
  })

  it('produces a larger file with overlays than without (content was actually baked)', async () => {
    const src = await makeSourcePdf(2)
    const pages = [
      { bytes: src, sourceKey: 'a', pageIndex: 0 },
      { bytes: src, sourceKey: 'a', pageIndex: 1 }
    ]
    const plain = await buildPdf(pages)
    const withEdits = await buildPdf(pages, editLayer())
    expect(withEdits.length).toBeGreaterThan(plain.length)
  })

  it('applies per-page rotation from the edit layer on export', async () => {
    const src = await makeSourcePdf(2)
    const pages = [
      { bytes: src, sourceKey: 'a', pageIndex: 0 },
      { bytes: src, sourceKey: 'a', pageIndex: 1 }
    ]
    const rotations = new Map([[makePageKey('a', 0), 90]])
    const out = await buildPdf(pages, { overlays: new Map(), attachments: new Map(), rotations })
    const reloaded = await PDFDocument.load(out)
    expect(reloaded.getPage(0).getRotation().angle).toBe(90)
    expect(reloaded.getPage(1).getRotation().angle).toBe(0)
  })

  it('export without an edit layer is unchanged (no overlays, no throw)', async () => {
    const src = await makeSourcePdf(1)
    const out = await buildPdf([{ bytes: src, sourceKey: 'a', pageIndex: 0 }])
    const reloaded = await PDFDocument.load(out)
    expect(reloaded.getPageCount()).toBe(1)
    expect(pageImageXObjectCount(reloaded, 0)).toBe(0)
  })

  it('flattens every form-value kind (checkbox, radio dot, choice/text) into a valid PDF', async () => {
    const src = await makeSourcePdf(1)
    const pages = [{ bytes: src, sourceKey: 'a', pageIndex: 0 }]
    const overlays = new Map<string, Overlay[]>()
    overlays.set(makePageKey('a', 0), [
      base({ type: 'formValue', field: 'agree', value: true, z: 0 }), // checkbox → X
      base({ type: 'formValue', field: 'plan', value: '1', control: 'radio', z: 1 }), // radio → dot
      base({ type: 'formValue', field: 'country', value: 'Canada', z: 2 }) // dropdown/text → text
    ])
    const out = await buildPdf(pages, { overlays, attachments: new Map() })
    const plain = await buildPdf(pages)
    expect(out.length).toBeGreaterThan(plain.length) // content was actually baked
    await expect(PDFDocument.load(out)).resolves.toBeTruthy()
  })

  // A one-page export of `overlays`, reloaded for inspection.
  async function exportPage(overlays: Overlay[]): Promise<PDFDocument> {
    const src = await makeSourcePdf(1)
    const map = new Map([[makePageKey('a', 0), overlays]])
    const out = await buildPdf([{ bytes: src, sourceKey: 'a', pageIndex: 0 }], {
      overlays: map,
      attachments: new Map()
    })
    return PDFDocument.load(out)
  }

  const textOverlay = (
    text: string,
    font: 'Helvetica' | 'Times' | 'Courier' = 'Helvetica'
  ): Overlay =>
    base({
      type: 'text',
      text,
      fontSize: 12,
      color: { r: 0, g: 0, b: 0 },
      font,
      align: 'left',
      geom: geom({ w: 260, h: 60 })
    })

  const NON_LATIN = 'Ελληνικά → Привет ✓'

  it('exports non-WinAnsi text overlays with the embedded Unicode fallback font', async () => {
    stubUnicodeFontFetch()
    const doc = await exportPage([textOverlay(`${NON_LATIN}\n\u{1f600} 中`)])
    const fonts = pageFonts(doc, 0)
    const fallback = fonts.filter((f) => f.embeddedTrueType)
    expect(fallback.length).toBeGreaterThan(0)
    expect(new Set(fallback.map((f) => f.ref)).size).toBe(1) // one embedded font program
    expect(fallback[0].subtype).toBe('/Type0')
    expect(fallback[0].baseFont).toContain('DejaVuSans')
    // Both lines are drawn with the fallback font (2-byte glyph ids, not WinAnsi codes).
    const content = pageContent(doc, 0)
    const selected = [...content.matchAll(/\/(\S+) 12 Tf/g)].map((m) => m[1])
    expect(selected.length).toBe(2)
    for (const key of selected) expect(fallback.map((f) => f.key)).toContain(key)
    expect(content).toMatch(/<(?:[0-9A-F]{4}){19}> Tj/) // line 1: 19 glyphs, one per code point
    // No Standard-14 font was needed for this overlay.
    expect(fonts.some((f) => f.subtype === '/Type1')).toBe(false)
  })

  it('keeps pure-ASCII text on the Standard-14 font and embeds no fallback', async () => {
    const fetchFn = stubUnicodeFontFetch()
    const doc = await exportPage([textOverlay('Approved: A. Jara', 'Times')])
    const fonts = pageFonts(doc, 0)
    expect(fonts.map((f) => [f.subtype, f.baseFont])).toEqual([['/Type1', '/Times-Roman']])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('paints non-WinAnsi form values with the fallback font', async () => {
    stubUnicodeFontFetch()
    const doc = await exportPage([base({ type: 'formValue', field: 'name', value: 'Мария' })])
    expect(pageFonts(doc, 0).some((f) => f.embeddedTrueType)).toBe(true)
  })

  it('embeds the fallback once per output document, shared by every overlay that needs it', async () => {
    stubUnicodeFontFetch()
    const src = await makeSourcePdf(2)
    const overlays = new Map([
      [makePageKey('a', 0), [textOverlay(NON_LATIN)]],
      [makePageKey('a', 1), [textOverlay('Ω → Σ')]]
    ])
    const out = await buildPdf(
      [
        { bytes: src, sourceKey: 'a', pageIndex: 0 },
        { bytes: src, sourceKey: 'a', pageIndex: 1 }
      ],
      { overlays, attachments: new Map() }
    )
    const doc = await PDFDocument.load(out)
    const type0 = doc.context
      .enumerateIndirectObjects()
      .filter(
        ([, o]) => o instanceof PDFDict && o.get(PDFName.of('Subtype')) === PDFName.of('Type0')
      )
    expect(type0.length).toBe(1)
  })

  it('still exports (with replacement characters) when the fallback font cannot load', async () => {
    vi.resetModules() // fresh ./fonts: no font bytes cached by the tests above
    const fresh = await import('./build')
    stubUnicodeFontFetchFailure()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const src = await makeSourcePdf(1)
    const overlays = new Map([[makePageKey('a', 0), [textOverlay(NON_LATIN)]]])
    const out = await fresh.buildPdf([{ bytes: src, sourceKey: 'a', pageIndex: 0 }], {
      overlays,
      attachments: new Map()
    })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    const doc = await PDFDocument.load(out)
    expect(pageFonts(doc, 0).map((f) => f.baseFont)).toEqual(['/Helvetica'])
    expect(pageContent(doc, 0)).toContain('<3F3F3F3F3F3F3F3F203F203F3F3F3F3F3F203F> Tj')
  })

  it('draws each ink stroke as ONE round-capped, round-joined path stroked once', async () => {
    const doc = await exportPage([
      base({
        type: 'ink',
        paths: [[10, 10, 50, 50, 80, 20, 120, 60]],
        strokeWidth: 3,
        color: { r: 0, g: 0, b: 1 },
        geom: geom({ opacity: 0.5 })
      })
    ])
    const ops = pageContent(doc, 0)
      .split('\n')
      .map((l) => l.trim())
    const count = (re: RegExp): number => ops.filter((l) => re.test(l)).length
    expect(count(/^1 J$/)).toBe(1) // round cap
    expect(count(/^1 j$/)).toBe(1) // round join
    expect(count(/ m$/)).toBe(1) // one subpath…
    expect(count(/ l$/)).toBe(3) // …through all four points
    expect(count(/^S$/)).toBe(1) // stroked once: no overlapping translucent segments
    expect(count(/ gs$/)).toBe(1) // opacity applied once
    expect(ops).toContain('10 10 m')
    expect(ops).toContain('120 60 l')
  })

  it('emits an opaque ink stroke without an opacity graphics state', async () => {
    const doc = await exportPage([
      base({
        type: 'ink',
        paths: [
          [10, 10, 50, 50],
          [0, 0]
        ], // a single-point stroke draws nothing
        strokeWidth: 2,
        color: { r: 0, g: 0, b: 0 }
      })
    ])
    const ops = pageContent(doc, 0)
      .split('\n')
      .map((l) => l.trim())
    expect(ops.filter((l) => l === 'S').length).toBe(1)
    expect(ops.some((l) => / gs$/.test(l))).toBe(false)
  })
})
