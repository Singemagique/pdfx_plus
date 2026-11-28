// The PDFx OCR layer a reopened file already carries (DESIGN.md §3.5.2, §3.6.3): what "Show
// recognized text" draws on a page whose words were recognised in an EARLIER session. Its words
// are native pdf.js text by now, inside the layer's `/PDFxOCR … BDC … EMC` marked content
// (pdfx/ocr-layer.ts). Per-word confidence is not saved (D8: provenance only), so these words carry
// none and are never underlined.
//
// Per WORD, not per pdf.js run: pdf.js's text content merges a line's per-word Tj's into one run
// (the layer's stretched spaces make them continuous), and one run drawn in a substitute font and
// stretched across the whole line drifts off the printed words along it — the overlay then ghosts
// the print. So the words are read from the page's operator list instead: a small text-state walk
// (Tm, Td, Tz, Tc, Tw, Tf, the CTM) inside the layer's marked content, a word being the glyphs
// between two whitespace glyphs or text-positioning operators — the layer's one Tj per word, at
// the exact start and advance the export wrote. The cheap text-content read comes first and says
// whether the page has a layer at all (the operator list decodes the page's images too), and its
// runs stand in if the walk finds no word. Type-only pdf.js imports: nothing here loads pdf.js at
// runtime (the operator codes are pinned against pdf.js's OPS in the tests).

import type { PDFDocumentProxy } from 'pdfjs-dist'

/** pdfx/ocr-layer.ts `OCR_MARK` (not imported: that module pulls in pdf-lib). */
export const SAVED_LAYER_TAG = 'PDFxOCR'

/** One word (a run, in the fallback) of the saved layer, in display page coordinates (pt). */
export interface SavedRun {
  t: string
  /** Baseline start. */
  x: number
  y: number
  /** Advance along the baseline. */
  w: number
  /** Em size (the layer's line size). */
  size: number
  /** Baseline rotation, degrees clockwise on screen. */
  deg: number
}

type M6 = readonly number[]

const mul = (m: M6, n: M6): number[] => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5]
]
const apply = (m: M6, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5]
]
const IDENTITY: M6 = [1, 0, 0, 1, 0, 0]

interface RawItem {
  str?: unknown
  transform?: unknown
  width?: unknown
  type?: unknown
  tag?: unknown
}

/**
 * The runs inside `/PDFxOCR` marked content of one page's text content (`items` from
 * `getTextContent({ includeMarkedContent: true })`), mapped through `vt` (the page's scale-1
 * viewport transform). Exported for tests.
 */
export function savedRuns(items: readonly unknown[], vt: M6): SavedRun[] {
  const out: SavedRun[] = []
  // A stack of open marked-content sections: true where one is (or is inside) the layer.
  const stack: boolean[] = []
  const unit = Math.hypot(vt[0], vt[1]) || 1
  for (const raw of items) {
    const it = raw as RawItem
    if (it.type === 'beginMarkedContent' || it.type === 'beginMarkedContentProps') {
      stack.push(stack.at(-1) === true || it.tag === SAVED_LAYER_TAG)
      continue
    }
    if (it.type === 'endMarkedContent') {
      stack.pop()
      continue
    }
    if (stack.at(-1) !== true) continue
    if (typeof it.str !== 'string' || !Array.isArray(it.transform)) continue
    const t = it.str.trim()
    if (!t) continue
    const tr = it.transform as number[]
    if (tr.length !== 6 || !tr.every(Number.isFinite)) continue
    const m = mul(vt, tr)
    const size = Math.hypot(m[2], m[3])
    const w = (typeof it.width === 'number' && Number.isFinite(it.width) ? it.width : 0) * unit
    if (!(size > 0)) continue
    out.push({ t, x: m[4], y: m[5], w, size, deg: (Math.atan2(m[1], m[0]) * 180) / Math.PI })
  }
  return out
}

/** The pdf.js 5.7 operator codes the walk reads (`OPS`; pinned against pdf.js in the tests). */
export const WALK_OPS = {
  setGState: 9,
  save: 10,
  restore: 11,
  transform: 12,
  beginText: 31,
  endText: 32,
  setCharSpacing: 33,
  setWordSpacing: 34,
  setHScale: 35,
  setLeading: 36,
  setFont: 37,
  setTextRise: 39,
  moveText: 40,
  setLeadingMoveText: 41,
  setTextMatrix: 42,
  nextLine: 43,
  showText: 44,
  beginMarkedContent: 69,
  beginMarkedContentProps: 70,
  endMarkedContent: 71,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75
} as const

/** A TJ adjustment wider than this (em) ends a word, as a space would. */
const TJ_BREAK_EM = 0.25

interface WalkState {
  ctm: M6
  tm: M6
  x: number
  y: number
  lineX: number
  lineY: number
  /** Tz / 100. */
  th: number
  tc: number
  tw: number
  size: number
  dir: 1 | -1
  rise: number
  /** As pdf.js's canvas keeps it: −TL. */
  leading: number
  /** The font matrix's x scale (glyph widths are in font units; 0.001 for all but Type 3). */
  fm: number
}

interface RawGlyph {
  unicode?: unknown
  width?: unknown
  isSpace?: unknown
}

const finite = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const matrixOf = (v: unknown): M6 | null => {
  if (!v || typeof (v as ArrayLike<number>).length !== 'number') return null
  const m = Array.from(v as ArrayLike<number>)
  return m.length === 6 && m.every(Number.isFinite) ? m : null
}

/**
 * The words inside `/PDFxOCR` marked content of a page's operator list (`fnArray` / `argsArray`
 * of `page.getOperatorList()`), mapped through `vt`. `fontMatrixOf` gives a loaded font's matrix x
 * scale (absent: 0.001). Exported for tests.
 */
export function savedWordsFromOps(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown>,
  vt: M6,
  fontMatrixOf: (loadedName: string) => number | undefined = () => undefined
): SavedRun[] {
  const out: SavedRun[] = []
  let s: WalkState = {
    ctm: IDENTITY,
    tm: IDENTITY,
    x: 0,
    y: 0,
    lineX: 0,
    lineY: 0,
    th: 1,
    tc: 0,
    tw: 0,
    size: 0,
    dir: 1,
    rise: 0,
    leading: 0,
    fm: 0.001
  }
  const saved: WalkState[] = []
  const marks: boolean[] = []
  let word: { t: string; m: number[]; x0: number; x1: number; y: number; size: number } | null =
    null
  /**
   * The last word written, the whitespace advance (display pt) shown since it ended, and whether
   * that whitespace was stretched with Tc (the layer's space across the engine's gap on a tilted
   * line; a column jump keeps the space's natural width, Tc 0).
   */
  let prev: { run: SavedRun; ux: number; uy: number; space: number; stretched: boolean } | null =
    null

  const flush = (): void => {
    const w = word
    word = null
    if (!w) return
    const t = w.t.trim()
    if (!t) return
    const [x, y] = apply(w.m, w.x0, w.y)
    const [ex, ey] = apply(w.m, w.x1, w.y)
    const along = Math.hypot(w.m[0], w.m[1])
    const size = Math.hypot(w.m[2], w.m[3]) * w.size
    if (!(along > 0) || !(size > 0)) return
    const ux = w.m[0] / along
    const uy = w.m[1] / along
    const width = Math.max(0, (ex - x) * ux + (ey - y) * uy)
    const run = { t, x, y, w: width, size, deg: (Math.atan2(uy, ux) * 180) / Math.PI }
    if (![run.x, run.y, run.w, run.size, run.deg].every(Number.isFinite)) return
    out.push(run)
    prev = { run, ux, uy, space: 0, stretched: false }
  }

  /**
   * A word starts at display point (x, y): if it continues the previous word's baseline across a
   * space the layer stretched with Tc, that word ends where this one starts less that space. The
   * layer stretches it across the engine's own gap, so this recovers the recognised width of a
   * word the layer had to write shorter (a tilted line's words widen only so far: ocr-layer.ts
   * `show`). Upright lines fit words and spaces with Tz, exactly, and need none of this. Only ever
   * widens, and never past the next word.
   */
  const stitch = (x: number, y: number): void => {
    const p = prev
    prev = null
    if (!p?.stretched) return
    const dx = x - p.run.x
    const dy = y - p.run.y
    const along = dx * p.ux + dy * p.uy
    const across = Math.abs(dy * p.ux - dx * p.uy)
    if (!(along > p.run.w) || across > 0.25 * p.run.size) return
    const w = along - p.space
    if (w > p.run.w) p.run.w = Math.min(w, along)
  }

  const setFont = (name: unknown, size: unknown): void => {
    flush()
    const sz = finite(size, 0)
    s = { ...s, size: Math.abs(sz), dir: sz < 0 ? -1 : 1 }
    const fm = typeof name === 'string' ? fontMatrixOf(name) : undefined
    s.fm = typeof fm === 'number' && Number.isFinite(fm) && fm !== 0 ? fm : 0.001
  }

  const moveTo = (tx: number, ty: number): void => {
    flush()
    s = { ...s, lineX: s.lineX + tx, lineY: s.lineY + ty }
    s.x = s.lineX
    s.y = s.lineY
  }

  const show = (glyphs: unknown): void => {
    if (!Array.isArray(glyphs)) return
    const inLayer = marks.at(-1) === true
    for (const g of glyphs) {
      if (typeof g === 'number') {
        if (!Number.isFinite(g)) continue
        if (-g / 1000 > TJ_BREAK_EM) flush()
        s.x += ((-g * s.size) / 1000) * s.th * s.dir
        continue
      }
      if (!g || typeof g !== 'object') continue
      const glyph = g as RawGlyph
      const unicode = typeof glyph.unicode === 'string' ? glyph.unicode : ''
      const space = glyph.isSpace === true || !/\S/.test(unicode)
      const spacing = (glyph.isSpace === true ? s.tw : 0) + s.tc
      const advance = (finite(glyph.width, 0) * s.size * s.fm + spacing * s.dir) * s.th * s.dir
      if (!inLayer) {
        flush()
        prev = null
      } else if (space) {
        flush()
        if (prev) {
          const m = mul(vt, mul(s.ctm, s.tm))
          prev.space += Math.abs(advance) * Math.hypot(m[0], m[1])
          if (s.tc !== 0) prev.stretched = true
        }
      } else {
        if (!word) {
          // Text space → display: the text matrix, then the CTM, then the viewport.
          const m = mul(vt, mul(s.ctm, s.tm))
          word = { t: '', m, x0: s.x, x1: s.x, y: s.y + s.rise, size: s.size }
          stitch(...apply(m, s.x, s.y + s.rise))
        }
        word.t += unicode
        word.x1 = s.x + advance
      }
      s.x += advance
    }
  }

  const n = Math.min(fnArray.length, argsArray.length)
  for (let i = 0; i < n; i++) {
    const fn = fnArray[i]
    const args = (argsArray[i] ?? []) as unknown[]
    switch (fn) {
      case WALK_OPS.save:
        flush()
        saved.push(s)
        s = { ...s }
        break
      case WALK_OPS.restore:
        flush()
        s = saved.pop() ?? s
        break
      case WALK_OPS.transform: {
        flush()
        const m = matrixOf(args)
        if (m) s = { ...s, ctm: mul(s.ctm, m) }
        break
      }
      case WALK_OPS.paintFormXObjectBegin: {
        flush()
        saved.push(s)
        const m = matrixOf(args[0])
        s = m ? { ...s, ctm: mul(s.ctm, m) } : { ...s }
        break
      }
      case WALK_OPS.paintFormXObjectEnd:
        flush()
        s = saved.pop() ?? s
        break
      case WALK_OPS.beginText:
        flush()
        s = { ...s, tm: IDENTITY, x: 0, y: 0, lineX: 0, lineY: 0 }
        break
      case WALK_OPS.endText:
        flush()
        break
      case WALK_OPS.setTextMatrix: {
        flush()
        const m = matrixOf(args[0]) ?? matrixOf(args)
        if (m) s = { ...s, tm: m, x: 0, y: 0, lineX: 0, lineY: 0 }
        break
      }
      case WALK_OPS.moveText:
        moveTo(finite(args[0], 0), finite(args[1], 0))
        break
      case WALK_OPS.setLeadingMoveText:
        s = { ...s, leading: finite(args[1], 0) }
        moveTo(finite(args[0], 0), finite(args[1], 0))
        break
      case WALK_OPS.nextLine:
        moveTo(0, s.leading)
        break
      case WALK_OPS.setLeading:
        s = { ...s, leading: -finite(args[0], 0) }
        break
      case WALK_OPS.setCharSpacing:
        s = { ...s, tc: finite(args[0], 0) }
        break
      case WALK_OPS.setWordSpacing:
        s = { ...s, tw: finite(args[0], 0) }
        break
      case WALK_OPS.setHScale:
        flush()
        s = { ...s, th: finite(args[0], 100) / 100 }
        break
      case WALK_OPS.setTextRise:
        flush()
        s = { ...s, rise: finite(args[0], 0) }
        break
      case WALK_OPS.setFont:
        setFont(args[0], args[1])
        break
      case WALK_OPS.setGState:
        for (const pair of Array.isArray(args[0]) ? args[0] : []) {
          if (Array.isArray(pair) && pair[0] === 'Font' && Array.isArray(pair[1]))
            setFont(pair[1][0], pair[1][1])
        }
        break
      case WALK_OPS.showText:
        show(args[0])
        break
      case WALK_OPS.beginMarkedContent:
      case WALK_OPS.beginMarkedContentProps: {
        flush()
        const tag = args[0] as unknown
        const name = typeof tag === 'string' ? tag : (tag as { name?: unknown } | null)?.name
        marks.push(marks.at(-1) === true || name === SAVED_LAYER_TAG)
        break
      }
      case WALK_OPS.endMarkedContent:
        flush()
        marks.pop()
        break
    }
  }
  flush()
  return out
}

/** A loaded font's matrix x scale, when pdf.js already has it (never throws). */
function fontScale(page: { commonObjs?: unknown }, name: string): number | undefined {
  try {
    const objs = page.commonObjs as
      | { has(id: string): boolean; get(id: string): unknown }
      | undefined
    if (!objs?.has(name)) return undefined
    const m = (objs.get(name) as { fontMatrix?: ArrayLike<number> } | null)?.fontMatrix
    return m ? m[0] : undefined
  } catch {
    return undefined
  }
}

/** pdf.js `AnnotationMode.DISABLE`: the walk needs the page content only. */
const ANNOTATIONS_DISABLED = 0

const cache = new WeakMap<object, Map<number, Promise<SavedRun[]>>>()

/**
 * The saved PDFx OCR layer of page `pageIndex`, one entry per word (empty when the page has none,
 * or its text cannot be read). Cached per document proxy and page: a source is immutable.
 */
export function readSavedLayer(pdf: PDFDocumentProxy, pageIndex: number): Promise<SavedRun[]> {
  let pages = cache.get(pdf)
  if (!pages) cache.set(pdf, (pages = new Map()))
  let p = pages.get(pageIndex)
  if (!p) {
    p = (async () => {
      try {
        const page = await pdf.getPage(pageIndex + 1)
        const vt = page.getViewport({ scale: 1 }).transform
        const content = await page.getTextContent({ includeMarkedContent: true })
        const runs = savedRuns(content.items, vt)
        if (!runs.length) return []
        try {
          const ops = await page.getOperatorList({ annotationMode: ANNOTATIONS_DISABLED })
          const words = savedWordsFromOps(ops.fnArray, ops.argsArray, vt, (name) =>
            fontScale(page, name)
          )
          if (words.length) return words
        } catch {
          // The runs, then: drawn whole, but at the layer's place.
        }
        return runs
      } catch {
        return []
      }
    })()
    pages.set(pageIndex, p)
  }
  return p
}
