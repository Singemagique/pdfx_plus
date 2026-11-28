// font-trim.ts units: the content lexer, the ToUnicode round trip and zeroGlyphs' guards. The
// end-to-end cases (a pdf-lib DejaVu subset, a CIDToGIDMap stream, pixels unchanged) are in the
// leak suite, ocr-redaction.node.test.ts.

import { describe, expect, it } from 'vitest'

import { contentOps, parseToUnicode, writeToUnicode, zeroGlyphs } from './font-trim'

const bytes = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0))
const text = (b: Uint8Array): string => String.fromCharCode(...b)

describe('contentOps', () => {
  it('reads operators with their operands, strings as raw bytes', () => {
    const ops = contentOps(bytes('BT /F1 12 Tf (a\\(b\\)c\\101\\n) Tj [<00410042> -120 (x)] TJ ET'))
    expect(ops.map((o) => o.op)).toEqual(['BT', 'Tf', 'Tj', 'TJ', 'ET'])
    expect(ops[1].operands).toEqual([
      { k: 'name', v: 'F1' },
      { k: 'num', v: 12 }
    ])
    const tj = ops[2].operands[0]
    expect(tj.k === 'str' && text(tj.v)).toBe('a(b)cA\n')
    const arr = ops[3].operands[0]
    expect(arr.k).toBe('arr')
    if (arr.k === 'arr') {
      expect(arr.v.map((o) => o.k)).toEqual(['str', 'num', 'str'])
      expect(arr.v[0].k === 'str' && [...arr.v[0].v]).toEqual([0, 0x41, 0, 0x42])
    }
  })

  it('nested literal parentheses, an odd hex string, comments and a property list', () => {
    const ops = contentOps(bytes('% (not) Tj\n/P <</MCID 3 /Q (x) >> BDC (a(b)c) Tj <414> Tj EMC'))
    expect(ops.map((o) => o.op)).toEqual(['BDC', 'Tj', 'Tj', 'EMC'])
    const [nested, odd] = [ops[1].operands[0], ops[2].operands[0]]
    expect(nested.k === 'str' && text(nested.v)).toBe('a(b)c')
    expect(odd.k === 'str' && [...odd.v]).toEqual([0x41, 0x40])
  })

  it('skips inline image data, even bytes that look like operators', () => {
    const ops = contentOps(bytes('q BI /W 2 /H 1 /BPC 8 /CS /G ID (Q) Tj \xff EI Q (k) Tj'))
    expect(ops.map((o) => o.op)).toEqual(['q', 'BI', 'ID', 'EI', 'Q', 'Tj'])
    const k = ops[5].operands[0]
    expect(k.k === 'str' && text(k.v)).toBe('k')
  })
})

describe('ToUnicode', () => {
  it('writeToUnicode → parseToUnicode round-trips exactly the given codes', () => {
    const map = new Map([
      [3, 'p'],
      [0x41, 'ﬁ'],
      [0x1234, '😀']
    ])
    expect(parseToUnicode(writeToUnicode(map, 2))).toEqual(map)
    expect(parseToUnicode(writeToUnicode(new Map([[0x20, ' ']]), 1))).toEqual(new Map([[0x20, ' ']])) // prettier-ignore
  })

  it('parses both bfrange forms', () => {
    const cmap =
      '2 beginbfrange\n<0001> <0003> <0061>\n<0010> <0011> [<0041> <00420043>]\nendbfrange'
    expect([...parseToUnicode(cmap)]).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
      [0x10, 'A'],
      [0x11, 'BC']
    ])
  })
})

describe('zeroGlyphs', () => {
  it('declines what is not a TrueType program with glyf and loca', () => {
    expect(zeroGlyphs(new Uint8Array(4), new Set())).toBeNull()
    expect(zeroGlyphs(bytes('OTTO' + '\0'.repeat(40)), new Set())).toBeNull()
  })
})
