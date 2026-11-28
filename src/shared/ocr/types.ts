// OCR result data model (DESIGN.md §3.5.1). DOM-free and Electron-free: the same types and helpers
// run in the OCR utility process, its threads, the renderer and plain vitest Node.
//
// Frames. Every coordinate is in the OVERLAY FRAME: the page as the editor shows it before any
// edit rotation (the source page's intrinsic /Rotate applied, origin at the view box's lower-left
// corner, y up, PDF points) — the frame overlays and Find highlights already live in. A word is
// anchored at its BASELINE START (x, y) and runs `w` points along its line's baseline, which is
// rotated `angle` radians counter-clockwise.
//
// Two shapes. `OcrPage` (objects) is a convenient VIEW for one page at a time; `PackedOcrPage`
// (flat typed arrays, ≈ 24 B/word + text) is what the store, the message port and the edit layer
// hold. `pack`/`unpack` convert between them; `ocrLines` walks a packed page without building the
// whole object graph.

/** Triage's page classes (§3.4.1). */
export type PageClass =
  | 'scanned'
  | 'near-scanned'
  | 'ocr-ours'
  | 'ocr-foreign'
  | 'broken-text'
  | 'mixed'
  | 'text'
  | 'blank'
  | 'protected'

/** Outcome of recognising one page (§3.5.1). */
export type OcrStatus =
  | 'ok'
  | 'low-confidence'
  | 'no-text'
  | 'timeout'
  | 'failed'
  | 'too-large'
  | 'skipped-has-text'
  | 'skipped-protected'
  | 'needs-language'

export interface OcrWord {
  /** NFC text. */
  t: string
  /** Baseline start, overlay frame (pt). */
  x: number
  y: number
  /** Advance along the baseline (pt). */
  w: number
  /** Raw engine value (0..100), null if the engine gives none. */
  conf: number | null
  /** Calibrated P(correct) 0..1. */
  confCal: number | null
  /** Cumulative char edges 0..w (from ocrx_cinfo), for exact partial highlights. */
  chars?: Float32Array
}

export interface OcrLine {
  /** Baseline angle, radians counter-clockwise. */
  angle: number
  /** Font size (pt): the em height the text layer and Find items use. */
  size: number
  lang?: string
  /** Reading order, left to right along the baseline. */
  words: OcrWord[]
}

export interface OcrPage {
  v: 1
  engineId: string
  dataHashes: Record<string, string>
  langs: string[]
  pipelineVersion: number
  pageClass: PageClass
  renderDpi: number
  physDpi: number
  orientation: 0 | 90 | 180 | 270
  skewDeg: number
  meanConfCal: number | null
  confSource: 'word' | 'line' | 'none'
  status: OcrStatus
  /** Reading order: a VIEW, materialised from `PackedOcrPage` for one page at a time. */
  lines: OcrLine[]
}

/** What the store, the port and `EditLayer.ocr` hold (§3.3.3). */
export interface PackedOcrPage extends Omit<OcrPage, 'lines'> {
  /** All words, NFC, concatenated. */
  text: string
  /** nWords + 1 offsets into `text` (UTF-16 units). */
  wordOff: Uint32Array
  /** nWords × 5: x, y, w, conf (NaN = null), confCal (NaN = null). */
  wordGeom: Float32Array
  /** nLines + 1 offsets into the words. */
  wordLine: Uint32Array
  /** nLines × 2: angle, size. */
  lineGeom: Float32Array
  /** The small side array of line languages (`null` = none); absent when no line has one. */
  lineLang?: (string | null)[]
  /** Concatenated cumulative char edges of every word that has them. */
  charEdges?: Float32Array
  /** nWords + 1 offsets into `charEdges` (a word without edges has an empty range). */
  charOff?: Uint32Array
}

/** Number of words in a packed page. */
export const wordCount = (p: Pick<PackedOcrPage, 'wordOff'>): number => p.wordOff.length - 1

/** Number of lines in a packed page. */
export const lineCount = (p: Pick<PackedOcrPage, 'wordLine'>): number => p.wordLine.length - 1

const orNaN = (v: number | null): number => (v === null ? NaN : v)
const orNull = (v: number): number | null => (Number.isNaN(v) ? null : v)

/** Pack an `OcrPage` into flat arrays. Geometry is stored as Float32 (≈ 7 significant digits). */
export function pack(page: OcrPage): PackedOcrPage {
  const { lines, ...meta } = page
  let nWords = 0
  let hasChars = false
  let nEdges = 0
  let hasLang = false
  for (const line of lines) {
    nWords += line.words.length
    if (line.lang !== undefined) hasLang = true
    for (const w of line.words)
      if (w.chars) {
        hasChars = true
        nEdges += w.chars.length
      }
  }
  const wordOff = new Uint32Array(nWords + 1)
  const wordGeom = new Float32Array(nWords * 5)
  const wordLine = new Uint32Array(lines.length + 1)
  const lineGeom = new Float32Array(lines.length * 2)
  const charOff = hasChars ? new Uint32Array(nWords + 1) : undefined
  const charEdges = hasChars ? new Float32Array(nEdges) : undefined
  const texts: string[] = []
  let off = 0
  let wi = 0
  let ci = 0
  lines.forEach((line, li) => {
    wordLine[li] = wi
    lineGeom[li * 2] = line.angle
    lineGeom[li * 2 + 1] = line.size
    for (const w of line.words) {
      texts.push(w.t)
      wordOff[wi] = off
      off += w.t.length
      const g = wi * 5
      wordGeom[g] = w.x
      wordGeom[g + 1] = w.y
      wordGeom[g + 2] = w.w
      wordGeom[g + 3] = orNaN(w.conf)
      wordGeom[g + 4] = orNaN(w.confCal)
      if (charOff && charEdges) {
        charOff[wi] = ci
        if (w.chars) {
          charEdges.set(w.chars, ci)
          ci += w.chars.length
        }
      }
      wi++
    }
  })
  wordOff[nWords] = off
  wordLine[lines.length] = nWords
  if (charOff) charOff[nWords] = ci
  const packed: PackedOcrPage = {
    ...meta,
    text: texts.join(''),
    wordOff,
    wordGeom,
    wordLine,
    lineGeom
  }
  if (hasLang) packed.lineLang = lines.map((l) => l.lang ?? null)
  if (charOff && charEdges) {
    packed.charOff = charOff
    packed.charEdges = charEdges
  }
  return packed
}

/** Word `i` of a packed page as an `OcrWord` view (`chars` is a subarray, not a copy). */
export function packedWord(p: PackedOcrPage, i: number): OcrWord {
  const g = i * 5
  const word: OcrWord = {
    t: p.text.slice(p.wordOff[i], p.wordOff[i + 1]),
    x: p.wordGeom[g],
    y: p.wordGeom[g + 1],
    w: p.wordGeom[g + 2],
    conf: orNull(p.wordGeom[g + 3]),
    confCal: orNull(p.wordGeom[g + 4])
  }
  if (p.charOff && p.charEdges && p.charOff[i + 1] > p.charOff[i])
    word.chars = p.charEdges.subarray(p.charOff[i], p.charOff[i + 1])
  return word
}

/** Walk a packed page line by line, materialising one line's words at a time. */
export function* ocrLines(p: PackedOcrPage): Generator<OcrLine> {
  for (let li = 0; li < lineCount(p); li++) {
    const words: OcrWord[] = []
    for (let i = p.wordLine[li]; i < p.wordLine[li + 1]; i++) words.push(packedWord(p, i))
    const line: OcrLine = { angle: p.lineGeom[li * 2], size: p.lineGeom[li * 2 + 1], words }
    const lang = p.lineLang?.[li]
    if (lang !== undefined && lang !== null) line.lang = lang
    yield line
  }
}

/** The whole page as objects. */
export function unpack(p: PackedOcrPage): OcrPage {
  const {
    text: _text,
    wordOff: _wordOff,
    wordGeom: _wordGeom,
    wordLine: _wordLine,
    lineGeom: _lineGeom,
    lineLang: _lineLang,
    charEdges: _charEdges,
    charOff: _charOff,
    ...meta
  } = p
  return { ...meta, lines: [...ocrLines(p)] }
}

// ---------------------------------------------------------------------------------------------
// Word footprint (used for redaction, crop and overlap tests)

/** An axis-aligned rectangle, overlay frame (pt), the same shape as mirror.ts's `Rect`. */
export interface OcrRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface OcrPoint {
  x: number
  y: number
}

/** Ascent and descent of the layer's em box, as fractions of the line size (§3.7.4). */
export const OCR_ASCENT = 0.8
export const OCR_DESCENT = 0.2

/**
 * The word's em box as a quad: corners (0, −0.2s), (w, −0.2s), (w, 0.8s), (0, 0.8s) about the
 * baseline origin (x, y), rotated by the line angle. Lower-left, lower-right, upper-right,
 * upper-left.
 */
export function wordQuad(
  word: Pick<OcrWord, 'x' | 'y' | 'w'>,
  line: Pick<OcrLine, 'angle' | 'size'>
): [OcrPoint, OcrPoint, OcrPoint, OcrPoint] {
  const cos = Math.cos(line.angle)
  const sin = Math.sin(line.angle)
  const lo = -OCR_DESCENT * line.size
  const hi = OCR_ASCENT * line.size
  const at = (u: number, v: number): OcrPoint => ({
    x: word.x + u * cos - v * sin,
    y: word.y + u * sin + v * cos
  })
  return [at(0, lo), at(word.w, lo), at(word.w, hi), at(0, hi)]
}

/** Footprint pad: max(1 pt, 0.15 × size). */
export const footprintPad = (size: number): number => Math.max(1, 0.15 * size)

/**
 * The word footprint (§3.5.1): the axis-aligned bounding box of `wordQuad`, padded on every side
 * by `footprintPad(size)`. Over-covers on purpose: a redaction that touches it drops the word.
 */
export function wordFootprint(
  word: Pick<OcrWord, 'x' | 'y' | 'w'>,
  line: Pick<OcrLine, 'angle' | 'size'>
): OcrRect {
  const q = wordQuad(word, line)
  const pad = footprintPad(line.size)
  const xs = q.map((p) => p.x)
  const ys = q.map((p) => p.y)
  return {
    x0: Math.min(...xs) - pad,
    y0: Math.min(...ys) - pad,
    x1: Math.max(...xs) + pad,
    y1: Math.max(...ys) + pad
  }
}
