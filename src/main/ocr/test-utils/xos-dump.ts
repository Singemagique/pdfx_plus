// Tier 1b (DESIGN.md §3.9.3): the cross-OS output diff. With PDFX_OCR_XOS_DIR set, the tier-1
// suites write what they recognised, one JSON file per case, and the CI `ocr-diff` job compares the
// three OSes' files (scripts/ocr-xos-diff.mjs): any difference in the text, the boxes, the engine's
// own output or the input pixels fails it. A pinned non-relaxed SIMD core and a WASM rasteriser
// have no legitimate source of divergence (R11), so a difference is a bug to root-cause.
//
// Without the variable every call is a no-op. The records hold synthetic test text only (the synth
// corpus), never anything from a user's document, and no timings (those differ run to run).

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { OcrPage } from '../../../shared/ocr/types'

export const XOS_DIR = process.env.PDFX_OCR_XOS_DIR || null

/** One case's output, split by what the diff job reports a difference in. */
export interface XosRecord {
  /** The copy text: words by single spaces, lines by `\n`. */
  text: string
  /**
   * One row per word, reading order: baseline x, y, advance w (overlay frame, pt), the line's size
   * and angle, then the word's cumulative char edges.
   */
  boxes: number[][]
  /** The engine's own output (hOCR), per recognition. */
  engine: string[]
  /** SHA-256 of every input raster's pixels (the PDFium render or the synth raster). */
  inputs: string[]
  /** Everything else that must agree: orientation, skew, DPI, confidences, digests. */
  meta: Record<string, unknown>
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The text and box parts of a record, from a mapped page. */
export function pageParts(page: OcrPage): Pick<XosRecord, 'text' | 'boxes'> & {
  conf: (number | null)[]
} {
  const boxes: number[][] = []
  const conf: (number | null)[] = []
  for (const l of page.lines)
    for (const w of l.words) {
      boxes.push([w.x, w.y, w.w, l.size, l.angle, ...(w.chars ? Array.from(w.chars) : [])])
      conf.push(w.conf)
    }
  return {
    text: page.lines.map((l) => l.words.map((w) => w.t).join(' ')).join('\n'),
    boxes,
    conf
  }
}

/** Write `rec` as `<PDFX_OCR_XOS_DIR>/<suite>/<id>.json` (no-op without the variable). */
export function xosDump(suite: string, id: string, rec: XosRecord): void {
  if (!XOS_DIR) return
  const dir = join(XOS_DIR, suite)
  mkdirSync(dir, { recursive: true })
  const name = id.replace(/[^A-Za-z0-9._-]/g, '_')
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(rec) + '\n')
}
