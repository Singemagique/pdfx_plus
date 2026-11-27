// Shared fixtures for the Unicode-text export tests (fonts / flatten / signature-appearance). Test-only:
// it lives inside src/renderer/src so tsconfig.web.json type-checks it, and is excluded from
// coverage.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream
} from 'pdf-lib'

const FONT_PATH = fileURLToPath(
  new URL('../../../../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf', import.meta.url)
)

/**
 * In node, the Vite `?url` import resolves to a root-relative path (/node_modules/…/DejaVuSans.ttf)
 * that `fetch` can't load. Stub `fetch` to serve the TTF from node_modules for that URL, the way
 * the packaged renderer fetches the emitted asset. Undo with vi.unstubAllGlobals().
 */
export function stubUnicodeFontFetch(): ReturnType<typeof vi.fn> {
  const fetchFn = vi.fn(async (url: string | URL) => {
    if (!String(url).endsWith('DejaVuSans.ttf')) return new Response(null, { status: 404 })
    return new Response(new Uint8Array(readFileSync(FONT_PATH)))
  })
  vi.stubGlobal('fetch', fetchFn)
  return fetchFn
}

/** Make the Unicode font unavailable (a failed asset fetch). Undo with vi.unstubAllGlobals(). */
export function stubUnicodeFontFetchFailure(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
  )
}

/** The page's decoded content stream(s), concatenated in paint order. */
export function pageContent(doc: PDFDocument, pageIndex: number): string {
  const node = doc.getPage(pageIndex).node
  const contents = node.Contents()
  const streams: PDFStream[] =
    contents instanceof PDFArray
      ? contents.asArray().map((r) => doc.context.lookup(r, PDFStream))
      : contents
        ? [contents]
        : []
  return streams
    .map((s) =>
      Buffer.from(
        s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents()
      ).toString('latin1')
    )
    .join('\n')
}

export interface PageFont {
  /** The resource name content streams select it by (Tf operand). pdf-lib adds a fresh key per
   *  drawText call, so one embedded font can appear under several keys — compare `ref`. */
  key: string
  /** The font dictionary's indirect reference, e.g. "12 0 R". */
  ref: string
  subtype: string
  baseFont: string
  /** True for a Type0 font whose descendant carries an embedded TrueType program (FontFile2). */
  embeddedTrueType: boolean
}

/** The fonts in the page's /Resources /Font dictionary. */
export function pageFonts(doc: PDFDocument, pageIndex: number): PageFont[] {
  const fontDict = doc.getPage(pageIndex).node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict)
  if (!fontDict) return []
  return fontDict.entries().map(([name, ref]) => {
    const font = doc.context.lookup(ref as PDFRef, PDFDict)
    const subtype = font.get(PDFName.of('Subtype'))?.toString() ?? ''
    let embeddedTrueType = false
    const descendants = font.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)
    if (descendants) {
      const cid = descendants.lookup(0, PDFDict)
      const descriptor = cid.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict)
      embeddedTrueType = !!descriptor?.get(PDFName.of('FontFile2'))
    }
    return {
      key: name.decodeText(),
      ref: ref.toString(),
      subtype,
      baseFont: font.get(PDFName.of('BaseFont'))?.toString() ?? '',
      embeddedTrueType
    }
  })
}
