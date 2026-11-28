// PROTOTYPE (lane speed design, not committed): split one PSM 3 pass into units along
// Tesseract's own layout, so the units can be recognised apart (in parallel) and merged in the
// layout's reading order.

import type { PxBox, RawOcr } from '../../../shared/ocr/engine/types'
import { binarize, histogram, otsu, type Gray } from '../../../shared/ocr/preprocess/image'

export interface LayoutBlock {
  /** Tesseract PolyBlockType. */
  type: number
  box: PxBox
  lines: PxBox[]
}

export interface Unit {
  box: PxBox
  work: number
}

/** PolyBlockTypes whose lines are horizontal text that PSM 6 reads like PSM 3 does. */
const TEXT_TYPES = new Set([0, 1, 2, 3, 8])
/** Image / rule / noise blocks: no text lines, ignored. */
const NON_TEXT = new Set([9, 10, 11, 12, 13, 14])

export const UNIT_TUNING = {
  /** Ink components below which no layout is run at all (every tier-1 page is below it). */
  minInk: 3000,
  /** The smallest unit's work (normalised line length, ~ 1 s of LSTM here per 25k). */
  minUnitWork: 20000,
  maxUnits: 12,
  pad: 16
}

export const lineWork = (l: PxBox): number => ((l.x1 - l.x0) * 36) / Math.max(1, l.y1 - l.y0)

const intersects = (a: PxBox, b: PxBox): boolean =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1

export function planUnits(blocks: LayoutBlock[], img: Gray): Unit[] | null {
  const text = blocks.filter((b) => b.lines.length > 0)
  for (const b of text) if (!TEXT_TYPES.has(b.type)) return null
  for (const b of blocks) if (b.lines.length > 0 && NON_TEXT.has(b.type)) return null
  for (let i = 0; i < text.length; i++)
    for (let j = i + 1; j < text.length; j++) if (intersects(text[i].box, text[j].box)) return null
  const W = text.reduce((s, b) => s + b.lines.reduce((t, l) => t + lineWork(l), 0), 0)
  const q = Math.max(UNIT_TUNING.minUnitWork, W / UNIT_TUNING.maxUnits)
  if (W < 2 * UNIT_TUNING.minUnitWork) return null
  const ink = binarize(img, otsu(histogram(img)))
  const whiteRow = (y: number, x0: number, x1: number): boolean => {
    const o = y * img.width
    for (let x = x0; x < x1; x++) if (ink[o + x]) return false
    return true
  }
  const units: Unit[] = []
  const others = (b: LayoutBlock): PxBox[] => text.filter((o) => o !== b).map((o) => o.box)
  for (const b of text) {
    const bx0 = Math.max(0, b.box.x0)
    const bx1 = Math.min(img.width, b.box.x1)
    // Allowed cuts after line i: a white row between line i and line i+1.
    const cutAfter = (i: number): number | null => {
      const a = b.lines[i]
      const c = b.lines[i + 1]
      const lo = Math.min(a.y1, c.y0)
      const hi = Math.max(a.y1, c.y0)
      const mid = (lo + hi) >> 1
      for (let d = 0; d <= hi - lo; d++)
        for (const y of [mid - d, mid + d])
          if (y >= lo && y <= hi && y > 0 && y < img.height && whiteRow(y, bx0, bx1)) return y
      return null
    }
    const total = b.lines.reduce((t, l) => t + lineWork(l), 0)
    const start = units.length
    let acc = 0
    let done = 0
    let y0 = b.box.y0 - UNIT_TUNING.pad
    for (let i = 0; i < b.lines.length; i++) {
      const w = lineWork(b.lines[i])
      acc += w
      done += w
      const last = i === b.lines.length - 1
      let cut: number | null = null
      if (!last && acc >= q && total - done >= q / 2) cut = cutAfter(i)
      if (last || cut !== null) {
        const y1 = last ? b.box.y1 + UNIT_TUNING.pad : cut!
        units.push({
          box: { x0: bx0 - UNIT_TUNING.pad, y0, x1: bx1 + UNIT_TUNING.pad, y1 },
          work: acc
        })
        y0 = y1
        acc = 0
      }
    }
    // Clip the pads against the image and the other blocks.
    const mine = units.slice(start)
    for (const u of mine) {
      u.box = {
        x0: Math.max(0, u.box.x0),
        y0: Math.max(0, u.box.y0),
        x1: Math.min(img.width, u.box.x1),
        y1: Math.min(img.height, u.box.y1)
      }
      for (const o of others(b)) {
        if (!intersects(u.box, o)) continue
        // Shrink the pad on the side that touches o.
        if (o.x1 <= b.box.x0) u.box.x0 = Math.max(u.box.x0, o.x1)
        else if (o.x0 >= b.box.x1) u.box.x1 = Math.min(u.box.x1, o.x0)
        else if (o.y1 <= b.box.y0) u.box.y0 = Math.max(u.box.y0, o.y1)
        else if (o.y0 >= b.box.y1) u.box.y1 = Math.min(u.box.y1, o.y0)
        if (intersects(u.box, o)) return null
      }
    }
  }
  return units.length >= 2 ? units : null
}

export function cropGray(img: Gray, b: PxBox): Gray {
  const w = b.x1 - b.x0
  const h = b.y1 - b.y0
  const d = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    d.set(img.data.subarray((b.y0 + y) * img.width + b.x0, (b.y0 + y) * img.width + b.x1), y * w)
  return { width: w, height: h, data: d }
}

export function offsetRaw(raw: RawOcr, dx: number, dy: number): RawOcr['lines'] {
  const m = (x: PxBox): PxBox => ({ x0: x.x0 + dx, x1: x.x1 + dx, y0: x.y0 + dy, y1: x.y1 + dy })
  return raw.lines.map((l) => ({
    ...l,
    bbox: m(l.bbox),
    words: l.words.map((w) => ({
      ...w,
      bbox: m(w.bbox),
      ...(w.chars ? { chars: w.chars.map(m) } : {})
    }))
  }))
}
