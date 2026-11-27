import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'

import {
  charsetCovers,
  embedUnicodeFont,
  encodableText,
  fontCharset,
  normalizeText,
  resolveTextFont
} from './fonts'
import { stubUnicodeFontFetch, stubUnicodeFontFetchFailure } from '../test-utils/fonts'

afterEach(() => {
  vi.unstubAllGlobals()
})

const ascii = new Set([...'abc ?'].map((c) => c.codePointAt(0)!))

describe('pure text helpers', () => {
  it('normalizeText composes to NFC, folds CR/CRLF to LF and tabs to spaces', () => {
    expect(normalizeText('é')).toBe('é')
    expect(normalizeText('a\r\nb\rc\td')).toBe('a\nb\nc d')
  })

  it('charsetCovers ignores newlines and walks code points (not UTF-16 units)', () => {
    expect(charsetCovers(ascii, 'ab\nc')).toBe(true)
    expect(charsetCovers(ascii, 'abd')).toBe(false)
    expect(charsetCovers(new Set([0x1f600]), '\u{1f600}')).toBe(true)
  })

  it('encodableText replaces unsupported characters, drops invisible ones, keeps newlines', () => {
    expect(encodableText('a中\nb', ascii)).toBe('a?\nb')
    // One "?" per emoji code point, not per surrogate half; VS16/ZWJ are dropped, not replaced.
    expect(encodableText('a\u{1f600}️‍b', ascii)).toBe('a?b')
    expect(encodableText('ax', ascii, '*')).toBe('a') // replacement itself unencodable → dropped
  })
})

describe('resolveTextFont', () => {
  it('keeps the Standard-14 font for WinAnsi text and never asks for the fallback', async () => {
    const doc = await PDFDocument.create()
    const helv = await doc.embedFont(StandardFonts.Helvetica)
    const getUnicode = vi.fn(async () => null)
    const r = await resolveTextFont(helv, getUnicode, 'Café — €5\r\n')
    expect(r.font).toBe(helv)
    expect(r.text).toBe('Café — €5\n')
    expect(getUnicode).not.toHaveBeenCalled()
  })

  it('switches to the embedded Unicode font for Greek/Cyrillic/arrows/emoji', async () => {
    stubUnicodeFontFetch()
    const doc = await PDFDocument.create()
    const helv = await doc.embedFont(StandardFonts.Helvetica)
    const unicode = await embedUnicodeFont(doc)
    const text = 'Ελληνικά → Привет ✓ \u{1f600}'
    const r = await resolveTextFont(helv, async () => unicode, text)
    expect(r.font).toBe(unicode)
    expect(r.text).toBe(text) // DejaVu Sans covers all of it
    expect(r.font.widthOfTextAtSize(r.text, 12)).toBeGreaterThan(0)
  })

  it('falls back to replacement characters for glyphs the Unicode font lacks (CJK)', async () => {
    stubUnicodeFontFetch()
    const doc = await PDFDocument.create()
    const helv = await doc.embedFont(StandardFonts.Helvetica)
    const unicode = await embedUnicodeFont(doc)
    const r = await resolveTextFont(helv, async () => unicode, '中文 Ω')
    expect(r.font).toBe(unicode)
    expect(r.text).toBe('?? Ω')
  })

  it('without the fallback, the Standard-14 font is used with text it can encode', async () => {
    const doc = await PDFDocument.create()
    const helv = await doc.embedFont(StandardFonts.Helvetica)
    const r = await resolveTextFont(helv, async () => null, 'Hi Δ → ok')
    expect(r.font).toBe(helv)
    expect(r.text).toBe('Hi ? ? ok')
    // The raw text throws in pdf-lib; the resolved text is guaranteed encodable.
    expect(() => helv.widthOfTextAtSize('Δ', 12)).toThrow()
    expect(() => helv.encodeText(r.text)).not.toThrow()
    expect(charsetCovers(fontCharset(helv), r.text)).toBe(true)
  })

  it('embedUnicodeFont rejects (uncached) when the asset cannot be fetched, then recovers', async () => {
    vi.resetModules() // a fresh module: no font bytes cached by the tests above
    const fresh = await import('./fonts')
    stubUnicodeFontFetchFailure()
    await expect(fresh.embedUnicodeFont(await PDFDocument.create())).rejects.toThrow()
    vi.unstubAllGlobals()
    const fetchFn = stubUnicodeFontFetch()
    await expect(fresh.embedUnicodeFont(await PDFDocument.create())).resolves.toBeTruthy()
    // The bytes are fetched once and shared by every later document.
    await fresh.embedUnicodeFont(await PDFDocument.create())
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
