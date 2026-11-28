import { describe, expect, it } from 'vitest'
import { isSignedSource, SIGNED_SOURCE_NOTE } from './signed-source'

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('isSignedSource', () => {
  it('finds a signature dictionary’s /ByteRange', () => {
    expect(
      isSignedSource(bytes('%PDF-1.7\n1 0 obj << /Type /Sig /ByteRange [0 10 20 30] >>'))
    ).toBe(true)
  })
  it('is false for a PDF without one (near misses included)', () => {
    expect(isSignedSource(bytes('%PDF-1.7\n1 0 obj << /Type /Page /Byte /Range >>'))).toBe(false)
    expect(isSignedSource(bytes('/ByteRang'))).toBe(false)
    expect(isSignedSource(new Uint8Array())).toBe(false)
    expect(isSignedSource(undefined)).toBe(false)
  })
  it('finds it at the very end of the bytes', () => {
    expect(isSignedSource(bytes('xx/ByteRange'))).toBe(true)
  })
  it('has the design’s copy', () => {
    expect(SIGNED_SOURCE_NOTE).toBe(
      'Exporting creates a new file; the source’s digital signature won’t be valid in it. You can sign the new copy with Sign.'
    )
  })
})
