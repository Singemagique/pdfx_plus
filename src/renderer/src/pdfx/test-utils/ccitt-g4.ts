// A small CCITT Group 4 (ITU-T T.6) encoder for test fixtures. Test-only: no npm-registry encoder
// exists (DESIGN.md §3.4.2 fixtures), and the pixel-redaction tests need real fax-coded scans to
// measure how a 1-bit Flate re-encode compares with the CCITT stream it replaces. The decode
// round trip (PDFium FPDFImageObj_GetBitmap, pixel-redact.node.test.ts) checks the tables.
//
// Output: /K -1, no byte alignment, /BlackIs1 false (the PDF default), EOFB at the end. The input
// is `ink[y * w + x]`, true (or 1) = black.

/** Terminating codes (run 0–63), white then black, as bit strings. */
const WHITE_TERM = [
  '00110101', '000111', '0111', '1000', '1011', '1100', '1110', '1111', '10011', '10100', '00111',
  '01000', '001000', '000011', '110100', '110101', '101010', '101011', '0100111', '0001100',
  '0001000', '0010111', '0000011', '0000100', '0101000', '0101011', '0010011', '0100100',
  '0011000', '00000010', '00000011', '00011010', '00011011', '00010010', '00010011', '00010100',
  '00010101', '00010110', '00010111', '00101000', '00101001', '00101010', '00101011', '00101100',
  '00101101', '00000100', '00000101', '00001010', '00001011', '01010010', '01010011', '01010100',
  '01010101', '00100100', '00100101', '01011000', '01011001', '01011010', '01011011', '01001010',
  '01001011', '00110010', '00110011', '00110100'
] // prettier-ignore
const BLACK_TERM = [
  '0000110111', '010', '11', '10', '011', '0011', '0010', '00011', '000101', '000100', '0000100',
  '0000101', '0000111', '00000100', '00000111', '000011000', '0000010111', '0000011000',
  '0000001000', '00001100111', '00001101000', '00001101100', '00000110111', '00000101000',
  '00000010111', '00000011000', '000011001010', '000011001011', '000011001100', '000011001101',
  '000001101000', '000001101001', '000001101010', '000001101011', '000011010010', '000011010011',
  '000011010100', '000011010101', '000011010110', '000011010111', '000001101100', '000001101101',
  '000011011010', '000011011011', '000001010100', '000001010101', '000001010110', '000001010111',
  '000001100100', '000001100101', '000001010010', '000001010011', '000000100100', '000000110111',
  '000000111000', '000000100111', '000000101000', '000001011000', '000001011001', '000000101011',
  '000000101100', '000001011010', '000001100110', '000001100111'
] // prettier-ignore
/** Make-up codes for 64·(i + 1), i = 0…26 (64–1728). */
const WHITE_MAKEUP = [
  '11011', '10010', '010111', '0110111', '00110110', '00110111', '01100100', '01100101',
  '01101000', '01100111', '011001100', '011001101', '011010010', '011010011', '011010100',
  '011010101', '011010110', '011010111', '011011000', '011011001', '011011010', '011011011',
  '010011000', '010011001', '010011010', '011000', '010011011'
] // prettier-ignore
const BLACK_MAKEUP = [
  '0000001111', '000011001000', '000011001001', '000001011011', '000000110011', '000000110100',
  '000000110101', '0000001101100', '0000001101101', '0000001001010', '0000001001011',
  '0000001001100', '0000001001101', '0000001110010', '0000001110011', '0000001110100',
  '0000001110101', '0000001110110', '0000001110111', '0000001010010', '0000001010011',
  '0000001010100', '0000001010101', '0000001011010', '0000001011011', '0000001100100',
  '0000001100101'
] // prettier-ignore
/** Extended make-up codes (both colours) for 1792 + 64·i, i = 0…12 (1792–2560). */
const EXT_MAKEUP = [
  '00000001000', '00000001100', '00000001101', '000000010010', '000000010011', '000000010100',
  '000000010101', '000000010110', '000000010111', '000000011100', '000000011101', '000000011110',
  '000000011111'
] // prettier-ignore
/** Vertical mode codes for a1 − b1 = −3 … 3. */
const VERTICAL: Record<number, string> = {
  [-3]: '0000010',
  [-2]: '000010',
  [-1]: '010',
  0: '1',
  1: '011',
  2: '000011',
  3: '0000011'
}
const PASS = '0001'
const HORIZONTAL = '001'
const EOL = '000000000001'

class Bits {
  private bytes: number[] = []
  private cur = 0
  private n = 0
  push(code: string): void {
    for (const c of code) {
      this.cur = (this.cur << 1) | (c === '1' ? 1 : 0)
      if (++this.n === 8) {
        this.bytes.push(this.cur)
        this.cur = 0
        this.n = 0
      }
    }
  }
  done(): Uint8Array {
    if (this.n) this.bytes.push(this.cur << (8 - this.n))
    return Uint8Array.from(this.bytes)
  }
}

function runCode(bits: Bits, run: number, black: boolean): void {
  while (run >= 2560 + 64) {
    bits.push(EXT_MAKEUP[12])
    run -= 2560
  }
  if (run >= 1792) {
    const i = Math.floor((run - 1792) / 64)
    bits.push(EXT_MAKEUP[i])
    run -= 1792 + 64 * i
  } else if (run >= 64) {
    const i = Math.floor(run / 64) - 1
    bits.push((black ? BLACK_MAKEUP : WHITE_MAKEUP)[i])
    run -= 64 * (i + 1)
  }
  bits.push((black ? BLACK_TERM : WHITE_TERM)[run])
}

/** CCITT G4 data (K -1, /Columns w, /Rows h) of a w × h bi-level image; `ink` true = black. */
export function encodeG4(ink: ArrayLike<boolean | number>, w: number, h: number): Uint8Array {
  const bits = new Bits()
  let ref = new Uint8Array(w) // the imaginary all-white line above the first
  const line = new Uint8Array(w)
  /** Colour at x (x < 0 is white, the imaginary pixel before the line). */
  const at = (l: Uint8Array, x: number): number => (x < 0 || x >= w ? 0 : l[x])
  /** The first changing element of `l` after `a0` whose colour is `c` (w when there is none). */
  const nextOf = (l: Uint8Array, a0: number, c: number): number => {
    for (let x = Math.max(0, a0 + 1); x < w; x++) if (l[x] === c && at(l, x - 1) !== c) return x
    return w
  }
  /** The first pixel of `l` after `a0` whose colour differs from `c` (w when there is none). */
  const nextDiff = (l: Uint8Array, a0: number, c: number): number => {
    for (let x = Math.max(0, a0 + 1); x < w; x++) if (l[x] !== c) return x
    return w
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) line[x] = ink[y * w + x] ? 1 : 0
    let a0 = -1
    let color = 0
    while (a0 < w) {
      // After a pass a0 sits on a pixel of `color`; a1 is the next one of the other colour.
      const a1 = nextDiff(line, a0, color)
      const b1 = nextOf(ref, a0, 1 - color)
      const b2 = b1 < w ? nextOf(ref, b1, color) : w
      if (b2 < a1) {
        bits.push(PASS)
        a0 = b2
      } else if (Math.abs(a1 - b1) <= 3) {
        bits.push(VERTICAL[a1 - b1])
        a0 = a1
        color = 1 - color
      } else {
        const a2 = a1 < w ? nextDiff(line, a1, 1 - color) : w
        bits.push(HORIZONTAL)
        runCode(bits, a1 - Math.max(0, a0), color === 1)
        runCode(bits, a2 - a1, color === 0)
        a0 = a2
      }
    }
    ref = line.slice()
  }
  bits.push(EOL)
  bits.push(EOL)
  return bits.done()
}
