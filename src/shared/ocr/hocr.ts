// A strict, small parser for the hOCR Tesseract 5 writes (DESIGN.md §3.4.6). worker_threads have no
// DOMParser, and this is not general HTML: the input is machine-written by one renderer
// (TessBaseAPI::GetHOCRText), so the parser accepts exactly that shape and throws `HocrError` on
// anything else — a page that fails here is a `failed` page, never a guess.
//
// Shape (all four line classes are lines in Tesseract 5 hOCR; PR0 saw ocr_line and ocr_textfloat,
// PR5's recordings add ocr_header and ocr_caption):
//   div.ocr_page
//     div.ocr_carea                      (also div.ocr_separator / div.ocr_photo: no text, skipped)
//       p.ocr_par [lang] [dir]
//         span.ocr_line | ocr_header | ocr_caption | ocr_textfloat
//              title: bbox; baseline; x_size; x_descenders; x_ascenders; [textangle]
//           span.ocrx_word   title: bbox; x_wconf
//             span.ocrx_cinfo  title: x_bboxes; x_conf      (with hocr_char_boxes=1)
//               text
//
// Text is the concatenation of a word's text nodes (inside its cinfo spans, or directly in the word
// when char boxes are off), with the five entities Tesseract's HOcrEscape writes plus numeric ones
// decoded. Whitespace between tags is layout, not text. Unknown inline tags inside a word (`<em>`,
// `<strong>` with hocr_font_info) are transparent.

import type { PxBox, RawLine, RawOcr, RawWord } from './engine/types'

export class HocrError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HocrError'
  }
}

export type HocrLineKind = RawLine['kind']
export const HOCR_LINE_CLASSES: readonly HocrLineKind[] = [
  'ocr_line',
  'ocr_header',
  'ocr_caption',
  'ocr_textfloat'
]

export interface HocrChar {
  text: string
  bbox: PxBox
  conf: number | null
}

export interface HocrWord {
  text: string
  bbox: PxBox
  conf: number | null
  /** One per ocrx_cinfo, in order (empty when char boxes are off). */
  chars: HocrChar[]
}

export interface HocrLine {
  kind: HocrLineKind
  bbox: PxBox
  /** `baseline slope intercept` (relative to the line bbox's bottom-left corner). */
  baseline: { slope: number; intercept: number } | null
  xSize: number | null
  xDescenders: number | null
  xAscenders: number | null
  textangle: number | null
  words: HocrWord[]
}

export interface HocrPar {
  bbox: PxBox
  lang: string | null
  dir: 'ltr' | 'rtl' | null
  lines: HocrLine[]
}

export interface HocrArea {
  bbox: PxBox
  pars: HocrPar[]
}

export interface HocrPage {
  bbox: PxBox
  areas: HocrArea[]
  /** Non-text blocks (ocr_separator, ocr_photo, …), counted only. */
  skippedBlocks: number
}

/** Inputs larger than this are refused (a full A4 page at 600 DPI is ~2 MB of hOCR). */
export const MAX_HOCR_LENGTH = 64 * 2 ** 20
const MAX_DEPTH = 16

// ---------------------------------------------------------------------------------------------
// Tokens

interface Tag {
  kind: 'open' | 'close'
  name: string
  attrs: Map<string, string>
  selfClosing: boolean
}

type Token = Tag | { kind: 'text'; text: string }

const NAME_RE = /^[a-z][a-z0-9]*$/
const ATTR_RE = /\s*([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:'([^']*)'|"([^"]*)")/y

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'"
}

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]+|#39);/g, (m, e: string) => {
    if (Object.hasOwn(ENTITIES, e)) return ENTITIES[e]
    if (e.startsWith('#')) {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      if (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff))
        return String.fromCodePoint(cp)
      throw new HocrError('bad character reference')
    }
    throw new HocrError(`unknown entity ${m.slice(0, 12)}`)
  })
}

function parseTag(src: string, start: number, end: number): Tag {
  let s = src.slice(start + 1, end)
  let kind: Tag['kind'] = 'open'
  if (s.startsWith('/')) {
    kind = 'close'
    s = s.slice(1)
  }
  let selfClosing = false
  if (s.endsWith('/')) {
    selfClosing = true
    s = s.slice(0, -1)
  }
  const m = /^([a-zA-Z][a-zA-Z0-9]*)/.exec(s)
  if (!m) throw new HocrError('malformed tag')
  const name = m[1].toLowerCase()
  if (!NAME_RE.test(name)) throw new HocrError('malformed tag name')
  const attrs = new Map<string, string>()
  let i = m[0].length
  const rest = s.slice(i)
  if (kind === 'close') {
    if (rest.trim() !== '') throw new HocrError('attributes on a closing tag')
    return { kind, name, attrs, selfClosing: false }
  }
  ATTR_RE.lastIndex = i
  for (;;) {
    if (/^\s*$/.test(s.slice(i))) break
    ATTR_RE.lastIndex = i
    const a = ATTR_RE.exec(s)
    if (!a) throw new HocrError('malformed attribute')
    const key = a[1].toLowerCase()
    if (attrs.has(key)) throw new HocrError('duplicate attribute')
    attrs.set(key, decodeEntities(a[2] ?? a[3] ?? ''))
    i = ATTR_RE.lastIndex
  }
  return { kind, name, attrs, selfClosing }
}

function* tokens(src: string): Generator<Token> {
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      yield { kind: 'text', text: src.slice(i) }
      return
    }
    if (lt > i) yield { kind: 'text', text: src.slice(i, lt) }
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4)
      if (e < 0) throw new HocrError('unterminated comment')
      i = e + 3
      continue
    }
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      // A doctype or XML declaration (only in a full document; GetHOCRText emits a fragment).
      const e = src.indexOf('>', lt)
      if (e < 0) throw new HocrError('unterminated declaration')
      i = e + 1
      continue
    }
    const gt = src.indexOf('>', lt)
    if (gt < 0) throw new HocrError('unterminated tag')
    yield parseTag(src, lt, gt)
    i = gt + 1
  }
}

// ---------------------------------------------------------------------------------------------
// title="…" properties

type Props = Map<string, string[]>

function parseTitle(title: string | undefined): Props {
  const props: Props = new Map()
  if (title === undefined) return props
  for (const part of title.split(';')) {
    const p = part.trim()
    if (!p) continue
    // `image "unknown"` quotes a name; everything we read is numeric.
    const sp = p.indexOf(' ')
    const key = sp < 0 ? p : p.slice(0, sp)
    const vals =
      sp < 0
        ? []
        : p
            .slice(sp + 1)
            .trim()
            .split(/\s+/)
    props.set(key, vals)
  }
  return props
}

function num(v: string | undefined, what: string): number {
  if (v === undefined || !/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(v))
    throw new HocrError(`bad number in ${what}`)
  const n = Number(v)
  if (!Number.isFinite(n)) throw new HocrError(`bad number in ${what}`)
  return n
}

function boxOf(props: Props, key: string, what: string): PxBox {
  const v = props.get(key)
  if (!v || v.length !== 4) throw new HocrError(`${what} without ${key}`)
  const [x0, y0, x1, y1] = v.map((s) => num(s, what))
  if (!(x1 >= x0 && y1 >= y0)) throw new HocrError(`inverted ${key} in ${what}`)
  return { x0, y0, x1, y1 }
}

function optNum(props: Props, key: string, what: string): number | null {
  const v = props.get(key)
  if (!v) return null
  if (v.length !== 1) throw new HocrError(`bad ${key} in ${what}`)
  return num(v[0], what)
}

// ---------------------------------------------------------------------------------------------
// Tree walk

const LINE_CLASS_SET = new Set<string>(HOCR_LINE_CLASSES)
/** Containers that carry no text in Tesseract's output. */
const NON_TEXT_BLOCKS = new Set(['ocr_separator', 'ocr_photo', 'ocr_image', 'ocr_float'])

interface Frame {
  name: string
  cls: string
}

/**
 * Parse one GetHOCRText fragment: exactly one ocr_page (an html/body wrapper around it is
 * tolerated, a head with text is not).
 */
export function parseHocr(src: string): HocrPage {
  if (typeof src !== 'string') throw new HocrError('not a string')
  if (src.length > MAX_HOCR_LENGTH) throw new HocrError('hOCR too large')
  const stack: Frame[] = []
  let page: HocrPage | null = null
  let area: HocrArea | null = null
  let par: HocrPar | null = null
  let line: HocrLine | null = null
  let word: HocrWord | null = null
  let char: HocrChar | null = null
  /** Depth (in `stack`) of a skipped non-text block, or -1. */
  let skipping = -1

  for (const tok of tokens(src)) {
    if (tok.kind === 'text') {
      if (skipping >= 0) continue
      if (char) char.text += decodeEntities(tok.text)
      else if (word) {
        // Text directly in a word: only when char boxes are off (or whitespace between cinfo spans).
        const t = decodeEntities(tok.text)
        if (t.trim() !== '') {
          if (word.chars.length > 0) throw new HocrError('text between char boxes')
          word.text += t
        }
      } else if (tok.text.trim() !== '') throw new HocrError('text outside a word')
      continue
    }
    if (tok.kind === 'close') {
      const top = stack.pop()
      if (!top || top.name !== tok.name) throw new HocrError(`unbalanced </${tok.name}>`)
      if (skipping >= 0) {
        if (stack.length === skipping) skipping = -1
        continue
      }
      switch (top.cls) {
        case 'ocrx_cinfo':
          if (char && word) word.chars.push(char)
          char = null
          break
        case 'ocrx_word':
          if (word && line) {
            if (word.chars.length > 0) word.text = word.chars.map((c) => c.text).join('')
            line.words.push(word)
          }
          word = null
          break
        case 'ocr_line':
        case 'ocr_header':
        case 'ocr_caption':
        case 'ocr_textfloat':
          if (line && par) par.lines.push(line)
          line = null
          break
        case 'ocr_par':
          if (par && area) area.pars.push(par)
          par = null
          break
        case 'ocr_carea':
          if (area && page) page.areas.push(area)
          area = null
          break
      }
      continue
    }
    // Opening tag.
    const cls = tok.attrs.get('class') ?? ''
    for (const k of tok.attrs.keys())
      if (!['class', 'id', 'title', 'lang', 'dir'].includes(k))
        throw new HocrError(`unexpected attribute ${k.slice(0, 16)}`)
    if (!tok.selfClosing) {
      stack.push({ name: tok.name, cls })
      if (stack.length > MAX_DEPTH) throw new HocrError('nesting too deep')
    }
    if (skipping >= 0) continue
    const props = parseTitle(tok.attrs.get('title'))
    if (cls === 'ocr_page') {
      if (page || stack.length > 1 + countOuter(stack)) throw new HocrError('misplaced ocr_page')
      page = { bbox: boxOf(props, 'bbox', 'ocr_page'), areas: [], skippedBlocks: 0 }
    } else if (cls === 'ocr_carea') {
      if (!page || area) throw new HocrError('misplaced ocr_carea')
      area = { bbox: boxOf(props, 'bbox', 'ocr_carea'), pars: [] }
    } else if (NON_TEXT_BLOCKS.has(cls)) {
      if (!page || area) throw new HocrError(`misplaced ${cls}`)
      page.skippedBlocks++
      if (!tok.selfClosing) skipping = stack.length - 1
    } else if (cls === 'ocr_par') {
      if (!area || par) throw new HocrError('misplaced ocr_par')
      const lang = tok.attrs.get('lang') ?? null
      if (lang !== null && !/^[a-z]{2,3}(?:_[a-z]{3,4})?$/.test(lang))
        throw new HocrError('bad lang')
      const dir = tok.attrs.get('dir') ?? null
      if (dir !== null && dir !== 'ltr' && dir !== 'rtl') throw new HocrError('bad dir')
      par = { bbox: boxOf(props, 'bbox', 'ocr_par'), lang, dir, lines: [] }
    } else if (LINE_CLASS_SET.has(cls)) {
      if (!par || line) throw new HocrError(`misplaced ${cls}`)
      const bl = props.get('baseline')
      if (bl && bl.length !== 2) throw new HocrError('bad baseline')
      line = {
        kind: cls as HocrLineKind,
        bbox: boxOf(props, 'bbox', cls),
        baseline: bl ? { slope: num(bl[0], 'baseline'), intercept: num(bl[1], 'baseline') } : null,
        xSize: optNum(props, 'x_size', cls),
        xDescenders: optNum(props, 'x_descenders', cls),
        xAscenders: optNum(props, 'x_ascenders', cls),
        textangle: optNum(props, 'textangle', cls),
        words: []
      }
    } else if (cls === 'ocrx_word') {
      if (!line || word) throw new HocrError('misplaced ocrx_word')
      const conf = optNum(props, 'x_wconf', 'ocrx_word')
      word = { text: '', bbox: boxOf(props, 'bbox', 'ocrx_word'), conf, chars: [] }
    } else if (cls === 'ocrx_cinfo') {
      if (!word || char) throw new HocrError('misplaced ocrx_cinfo')
      char = {
        text: '',
        bbox: boxOf(props, 'x_bboxes', 'ocrx_cinfo'),
        conf: optNum(props, 'x_conf', 'ocrx_cinfo')
      }
    } else if (cls === '') {
      // An inline formatting tag (<em>, <strong>) inside a word, or the html/body/head wrapper of
      // a full document: transparent.
      if (!word && page) throw new HocrError(`unexpected <${tok.name}>`)
    } else throw new HocrError(`unknown class ${cls.slice(0, 24)}`)
  }
  if (stack.length > 0) throw new HocrError('unclosed tags')
  if (!page) throw new HocrError('no ocr_page')
  return page
}

/** Wrapper elements (html, body) outside the page in a full document. */
function countOuter(stack: Frame[]): number {
  let n = 0
  for (const f of stack) if (f.cls === '' && (f.name === 'html' || f.name === 'body')) n++
  return n
}

// ---------------------------------------------------------------------------------------------
// hOCR → RawOcr (image px; §3.2.7)

/** x-height in px: x_size − x_ascenders − x_descenders (PR0 confirmed the semantics). */
export function lineXHeight(l: HocrLine): number {
  if (l.xSize === null) return 0
  const xh = l.xSize - (l.xAscenders ?? 0) - (l.xDescenders ?? 0)
  return xh > 0 ? xh : 0
}

/** Flatten a parsed page into the engine-neutral RawOcr, reading order preserved. */
export function hocrToRaw(page: HocrPage): RawOcr {
  const lines: RawLine[] = []
  let confSum = 0
  let confN = 0
  for (const area of page.areas)
    for (const par of area.pars)
      for (const l of par.lines) {
        const words: RawWord[] = l.words.map((w) => {
          if (w.conf !== null) {
            confSum += w.conf
            confN++
          }
          const rw: RawWord = { text: w.text, bbox: w.bbox, conf: w.conf }
          // Char boxes only when each symbol is one code point, so `chars[i]` is code point i.
          if (w.chars.length > 0 && w.chars.every((c) => [...c.text].length === 1))
            rw.chars = w.chars.map((c) => c.bbox)
          return rw
        })
        const raw: RawLine = {
          kind: l.kind,
          bbox: l.bbox,
          baseline: l.baseline,
          xHeight: lineXHeight(l),
          size: l.xSize ?? 0,
          words
        }
        if (l.textangle !== null) raw.angle = l.textangle
        if (l.xDescenders !== null) raw.descenders = l.xDescenders
        if (par.lang !== null) raw.lang = par.lang
        lines.push(raw)
      }
  return {
    lines,
    meanConf: confN > 0 ? confSum / confN : null,
    confSource: confN > 0 ? 'word' : 'none'
  }
}
