import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'

import { withSignatureAppearance, type AppearanceOptions } from './signature-appearance'
import { buildPdf, type EditLayer } from './build'
import type { Overlay, SignaturePlacement } from '../edit/model'
import { pageFonts, stubUnicodeFontFetch } from '../test-utils/fonts'

function baseLayer(): EditLayer {
  return { overlays: new Map(), attachments: new Map(), rotations: new Map(), crops: new Map() }
}

const placement: SignaturePlacement = {
  pageKey: 'doc#0',
  geom: { x: 100, y: 120, w: 200, h: 80, rotation: 0, opacity: 1 },
  label: 'drawn box · page 1'
}

const types = (overlays: Overlay[]): string[] => overlays.map((o) => o.type)

describe('withSignatureAppearance', () => {
  it('adds a border + text appearance (no image) and leaves the base layer untouched', async () => {
    const base = baseLayer()
    const out = await withSignatureAppearance(base, placement, {
      name: 'Ada Lovelace',
      reason: 'Approval',
      date: new Date(2026, 5, 27, 14, 30)
    })
    const added = out.overlays.get('doc#0') ?? []
    // Light background fill (legibility) + border + metadata text.
    expect(types(added)).toEqual(['highlight', 'shape', 'text'])
    // The text carries the signer metadata.
    const text = added.find((o) => o.type === 'text') as Extract<Overlay, { type: 'text' }>
    expect(text.text).toContain('Ada Lovelace')
    expect(text.text).toContain('Digitally signed')
    expect(text.text).toContain('Date: 2026.06.27 14:30')
    expect(text.text).toContain('Reason: Approval')
    // All appearance overlays sit within the placement rect.
    for (const o of added) {
      expect(o.geom.x).toBeGreaterThanOrEqual(placement.geom.x - 0.01)
      expect(o.geom.x + o.geom.w).toBeLessThanOrEqual(placement.geom.x + placement.geom.w + 0.01)
    }
    // Original layer is not mutated.
    expect(base.overlays.size).toBe(0)
    expect(base.attachments.size).toBe(0)
  })

  it('renders the certificate identity (name, DoD ID, issuer, date) when a signer is given', async () => {
    const base = baseLayer()
    const out = await withSignatureAppearance(base, placement, {
      date: new Date(2026, 5, 28, 9, 5, 3),
      signer: {
        subject: 'CN=JARA.ADAM.1290104722, OU=USA, OU=PKI, OU=DoD, O=U.S. Government, C=US',
        issuer: 'CN=DOD ID CA-59, OU=PKI, OU=DoD, O=U.S. Government, C=US'
      }
    })
    const text = (out.overlays.get('doc#0') ?? []).find((o) => o.type === 'text') as Extract<
      Overlay,
      { type: 'text' }
    >
    expect(text.text).toContain('Digitally signed by JARA.ADAM.1290104722')
    expect(text.text).toContain('DoD ID: 1290104722')
    expect(text.text).toContain('Issuer: DOD ID CA-59')
    expect(text.text).toContain('Date: 2026.06.28 09:05:03')
  })

  it('adds an image overlay + attachment when an image is supplied', async () => {
    const base = baseLayer()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]) // not a real PNG; aspect falls back
    const out = await withSignatureAppearance(base, placement, {
      date: new Date(2026, 0, 1),
      image: png
    })
    const added = out.overlays.get('doc#0') ?? []
    expect(types(added)).toEqual(['highlight', 'shape', 'image', 'text'])
    const img = added.find((o) => o.type === 'image') as Extract<Overlay, { type: 'image' }>
    expect(out.attachments.get(img.attachmentId)?.bytes).toBe(png)
    expect(out.attachments.get(img.attachmentId)?.mime).toBe('image/png')
  })

  it('appends to existing overlays on the same page (drawn on top)', async () => {
    const base = baseLayer()
    const existing: Overlay = {
      id: 'x',
      pageKey: 'doc#0',
      z: 0,
      createdAt: 1,
      geom: { x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 },
      type: 'highlight',
      color: { r: 1, g: 1, b: 0 }
    }
    base.overlays.set('doc#0', [existing])
    const out = await withSignatureAppearance(base, placement, { date: new Date(2026, 0, 1) })
    const added = out.overlays.get('doc#0') ?? []
    expect(added[0]).toBe(existing) // existing kept first (lowest)
    expect(added.length).toBe(4) // + bg fill + border + text
    expect(added.slice(1).every((o) => o.z > existing.z)).toBe(true)
  })

  it('budgets wider glyphs for a non-Latin name so the line still fits the box', async () => {
    const textOf = async (name: string): Promise<Extract<Overlay, { type: 'text' }>> => {
      const out = await withSignatureAppearance(baseLayer(), placement, {
        name,
        date: new Date(2026, 0, 1)
      })
      return (out.overlays.get('doc#0') ?? []).find((o) => o.type === 'text') as Extract<
        Overlay,
        { type: 'text' }
      >
    }
    // Same length; the Greek one is drawn with the (wider) DejaVu Sans fallback.
    const latin = await textOf('Eleni Papadopoulou Konstantinou Alexandrou')
    const greek = await textOf('Ελένη Παπαδοπούλου Κωνσταντίνου Αλεξάνδρου')
    expect(greek.fontSize).toBeLessThan(latin.fontSize)
  })

  describe('flattened into a sign-ready PDF', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    async function signReady(name: string, signer?: AppearanceOptions['signer']) {
      const src = await PDFDocument.create()
      src.addPage([400, 400])
      const bytes = await src.save()
      const layer = await withSignatureAppearance(baseLayer(), placement, {
        name,
        reason: 'Согласовано',
        date: new Date(2026, 0, 1),
        signer
      })
      // buildPdf used to throw "WinAnsi cannot encode" here, failing the whole signing flow.
      const out = await buildPdf([{ bytes, sourceKey: 'doc', pageIndex: 0 }], layer, {
        stripSignatureFields: true
      })
      return PDFDocument.load(out)
    }

    it('builds with a non-Latin signer name, drawn with the embedded Unicode font', async () => {
      stubUnicodeFontFetch()
      const doc = await signReady('Ελένη Παπαδοπούλου')
      const fonts = pageFonts(doc, 0)
      expect(fonts.some((f) => f.embeddedTrueType && f.baseFont.includes('DejaVuSans'))).toBe(true)
    })

    it('builds with a non-Latin certificate CN', async () => {
      stubUnicodeFontFetch()
      const doc = await signReady('', {
        subject: 'CN=Иванов Иван Иванович, O=Пример, C=RU',
        issuer: 'CN=Тестовый УЦ, C=RU'
      })
      expect(pageFonts(doc, 0).some((f) => f.embeddedTrueType)).toBe(true)
    })
  })
})
