// Text that flatten-on-export paints with pdf-lib. The Standard-14 fonts (Helvetica/Times/Courier)
// only speak WinAnsi, and pdf-lib's StandardFontEmbedder THROWS on any other character (Greek,
// Cyrillic, CJK, emoji, even "→"), which used to fail export and signing outright. Two layers:
//
//  1. Unicode fallback — when the chosen Standard-14 font can't encode the text, embed a subset of
//     the bundled DejaVu Sans (Latin/Greek/Cyrillic/arrows/symbols/basic emoticons) and draw with
//     it. One embed per output document (the caller caches it).
//  2. Safety net — whatever font is finally used, characters it still cannot encode (CJK has no
//     glyphs in DejaVu Sans, and the fallback can fail to load) are replaced, never thrown on.
//
// The font is loaded the same way as the PDFium WASM (./pdfium.ts): Vite emits the TTF as an asset
// and we fetch it, so it costs nothing until a document actually needs it.
import type { PDFDocument, PDFFont } from 'pdf-lib'
import unicodeFontUrl from 'dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url'

/** Drawn in place of a character no available font can encode. */
export const REPLACEMENT_CHAR = '?'

/** Invisible format characters (variation selectors, ZWJ, BOM…) — dropped rather than replaced. */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u
const NEWLINE = 0x0a

/**
 * Canonicalize text before measuring/encoding: NFC (so e + U+0301 becomes the single "é" WinAnsi
 * has), CR/CRLF → LF (a stray "\r" from pasted Windows text is not encodable), and tabs → a space.
 */
export function normalizeText(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, ' ')
}

/** True when every code point of `text` (newlines aside) is in `charset`. */
export function charsetCovers(charset: ReadonlySet<number>, text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp !== NEWLINE && !charset.has(cp)) return false
  }
  return true
}

/**
 * `text` with every character outside `charset` removed (invisible format characters) or replaced
 * by `replacement` (everything else). Newlines are kept. Pure; never throws.
 */
export function encodableText(
  text: string,
  charset: ReadonlySet<number>,
  replacement: string = REPLACEMENT_CHAR
): string {
  const sub = charsetCovers(charset, replacement) ? replacement : ''
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp === NEWLINE || charset.has(cp)) out += ch
    else if (!IGNORABLE.test(ch)) out += sub
  }
  return out
}

const charsets = new WeakMap<PDFFont, ReadonlySet<number>>()
/** The code points `font` can encode (WinAnsi for a Standard-14 font), memoized per font. */
export function fontCharset(font: PDFFont): ReadonlySet<number> {
  let set = charsets.get(font)
  if (!set) {
    set = new Set(font.getCharacterSet())
    charsets.set(font, set)
  }
  return set
}

let unicodeFontBytes: Promise<ArrayBuffer> | null = null
function loadUnicodeFontBytes(): Promise<ArrayBuffer> {
  if (!unicodeFontBytes) {
    unicodeFontBytes = fetch(unicodeFontUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`Unicode font fetch failed: ${r.status}`)
        return r.arrayBuffer()
      })
      .catch((e) => {
        // Don't cache a failure: the next export retries instead of being stuck on the safety net.
        unicodeFontBytes = null
        throw e
      })
  }
  return unicodeFontBytes
}

/**
 * Embed the bundled Unicode font (subset to the glyphs actually drawn) into `doc`. fontkit (~700 kB
 * minified) is imported lazily so it lands in its own chunk, off the renderer's startup path.
 */
export async function embedUnicodeFont(doc: PDFDocument): Promise<PDFFont> {
  const [{ default: fontkit }, bytes] = await Promise.all([
    import('@pdf-lib/fontkit'),
    loadUnicodeFontBytes()
  ])
  doc.registerFontkit(fontkit)
  return doc.embedFont(bytes, { subset: true })
}

/**
 * Pick the font to draw `text` with and return text it is guaranteed to encode. Uses `standard`
 * when it covers the text (so plain Latin text never embeds anything), else the Unicode fallback
 * from `getUnicode` (null when unavailable); any character still uncovered is replaced.
 */
export async function resolveTextFont(
  standard: PDFFont,
  getUnicode: () => Promise<PDFFont | null>,
  rawText: string
): Promise<{ font: PDFFont; text: string }> {
  const text = normalizeText(rawText)
  if (charsetCovers(fontCharset(standard), text)) return { font: standard, text }
  const unicode = await getUnicode()
  const font = unicode ?? standard
  return { font, text: encodableText(text, fontCharset(font)) }
}
