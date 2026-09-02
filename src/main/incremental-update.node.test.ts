import { describe, expect, it } from 'vitest'

import {
  appendIncrementalUpdate,
  latin1,
  lastStartxref,
  maxDeclaredSize
} from './incremental-update'

// A minimal one-object PDF with a classic xref table, enough to append onto.
const BASE = latin1(
  '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n' +
    'xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \n' +
    'trailer\n<<\n/Size 2\n/Root 1 0 R\n>>\nstartxref\n52\n%%EOF\n'
)

describe('lastStartxref', () => {
  it('reads the offset after the final startxref', () => {
    expect(lastStartxref(BASE)).toBe(52)
  })

  it('ignores a startxref that appears AFTER the last %%EOF', () => {
    const tampered = Buffer.concat([BASE, latin1('startxref\n999999\n')])
    expect(lastStartxref(tampered)).toBe(52)
  })

  it('distinguishes a missing startxref from a malformed one, and labels the caller', () => {
    expect(() => lastStartxref(latin1('%PDF-1.7\n%%EOF\n'), 'DSS')).toThrow(
      /DSS: no startxref \(not an incrementally-updatable PDF\)/
    )
    expect(() => lastStartxref(latin1('%PDF-1.7\nstartxref\nxyz\n%%EOF\n'), 'DSS')).toThrow(
      /DSS: malformed startxref/
    )
  })
})

describe('maxDeclaredSize', () => {
  it('reads the /Size next to a trailer keyword', () => {
    expect(maxDeclaredSize(BASE)).toBe(2)
  })

  it('reads the /Size of an xref-stream dict', () => {
    expect(maxDeclaredSize(latin1('5 0 obj\n<< /Type /XRef /Size 42 >>\nstream\n'))).toBe(42)
  })

  it('ignores a stray "/Size N" that no trailer or /Type /XRef anchors', () => {
    // Otherwise a "/Size 4000" inside a content stream or string would inflate the object numbers
    // we allocate for the appended section.
    expect(maxDeclaredSize(latin1('BT (/Size 4000) Tj ET\n'))).toBe(0)
  })
})

describe('appendIncrementalUpdate', () => {
  const objects = [
    { num: 1, buf: latin1('1 0 obj\n<< /Type /Catalog /DSS 7 0 R >>\nendobj\n') },
    { num: 7, buf: latin1('7 0 obj\n<< >>\nendobj\n') },
    { num: 8, buf: latin1('8 0 obj\n<< >>\nendobj\n') }
  ]

  it('preserves every original byte and separates the prior %%EOF with a newline', () => {
    const out = appendIncrementalUpdate(BASE, objects, { rootNum: 1 })
    expect(out.subarray(0, BASE.length).equals(BASE)).toBe(true)
    expect(out[BASE.length]).toBe(0x0a)
    expect(out.toString('latin1')).not.toMatch(/%%EOF\d/)
  })

  it('writes each object offset, groups consecutive numbers into subsections, and chains /Prev', () => {
    const out = appendIncrementalUpdate(BASE, objects, { rootNum: 1, infoNum: 4 })
    const text = out.toString('latin1')

    // Object 1 stands alone; 7 and 8 are consecutive, so they share one subsection.
    expect(text).toMatch(/xref\n1 1\n\d{10} 00000 n \n7 2\n\d{10} 00000 n \n\d{10} 00000 n \n/)
    // /Size is the highest appended object number + 1, and /Prev points at the previous section.
    expect(text).toContain('/Size 9\n')
    expect(text).toContain('/Root 1 0 R\n')
    expect(text).toContain('/Info 4 0 R\n')
    expect(text).toContain('/Prev 52\n')

    // The recorded offset for object 1 actually lands on "1 0 obj".
    const offset = parseInt(/xref\n1 1\n(\d{10})/.exec(text)![1], 10)
    expect(text.slice(offset, offset + 7)).toBe('1 0 obj')
    // The NEW startxref (the last one) points at the appended "xref" keyword itself.
    const sections = [...text.matchAll(/startxref\n(\d+)\n%%EOF/g)]
    const startxref = parseInt(sections[sections.length - 1][1], 10)
    expect(text.slice(startxref, startxref + 4)).toBe('xref')
  })

  it('omits /Info when the source file has none', () => {
    const out = appendIncrementalUpdate(BASE, objects, { rootNum: 1 })
    expect(out.toString('latin1')).not.toContain('/Info')
  })
})
