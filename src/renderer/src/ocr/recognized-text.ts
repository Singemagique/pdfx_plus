// "Show recognized text" (DESIGN.md §3.6.3, PR10): the session toggle, the hook-up to the OCR Find
// supply, and the read-only view model the full-view overlay draws (RecognizedTextLayer.tsx).
//
// The toggle is session state outside React (the find-controller pattern), so the Document menu's
// "Show Recognized Text" checkbox (PR8) binds to it without touching the overlay:
//   App's onMenu switch:   else if (action === 'show-recognized-text') toggleRecognizedText()
//   the checkbox state:    isRecognizedTextShown() + subscribeRecognizedTextShown(listener)
//   React:                 useRecognizedTextShown()
//
// The words are EXACTLY the ones Find and Copy Page Text use (ocr-find-supply.ts `filteredPage`):
// the page's selected result (its Replace / Remove choice, else its auto result), minus every word
// under a redaction or over an object the export's redaction pass will remove, and nothing at all
// while that pass's report is pending (the fail-safe). A page with no recognised text this session
// shows the PDFx OCR layer its file already carries (a reopened export, saved-layer.ts), as Find
// sees it: only while the page has no redaction and no Replace / Remove choice, since either drops
// that layer from the export (and from Find). Those words carry no confidence: it is session-only.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { bcp47FromTesseract } from '../../../shared/ocr/lang'
import { CAL_THRESHOLDS } from '../../../shared/ocr/calibration'
import { ocrLines, type PackedOcrPage } from '../../../shared/ocr/types'
import { useEdits } from '../edit/EditProvider'
import { makePageKey } from '../edit/model'
import type { PageWindow } from '../page-geometry'
import type { PageEntry } from '../types'
import type { OcrFindSupply } from './ocr-find-supply'
import { readSavedLayer, type SavedRun } from './saved-layer'

// ---------------------------------------------------------------------------------------------
// The toggle (session-only; off at launch).

let shown = false
const shownListeners = new Set<() => void>()

export function isRecognizedTextShown(): boolean {
  return shown
}

export function setRecognizedTextShown(on: boolean): void {
  if (shown === on) return
  shown = on
  for (const l of [...shownListeners]) l()
}

/** Flip the toggle; returns the new state. */
export function toggleRecognizedText(): boolean {
  setRecognizedTextShown(!shown)
  return shown
}

export function subscribeRecognizedTextShown(listener: () => void): () => void {
  shownListeners.add(listener)
  return () => void shownListeners.delete(listener)
}

export function useRecognizedTextShown(): boolean {
  return useSyncExternalStore(subscribeRecognizedTextShown, isRecognizedTextShown)
}

// ---------------------------------------------------------------------------------------------
// The supply (App connects its OCR Find supply once).

type Supply = Pick<OcrFindSupply, 'filteredPage' | 'onChange'>

let supply: Supply | null = null
let version = 0
const supplyListeners = new Set<() => void>()

function bump(): void {
  version++
  for (const l of [...supplyListeners]) l()
}

/** Hook the overlay up to the app's OCR Find supply; returns the disconnect. */
export function connectRecognizedText(s: Supply): () => void {
  supply = s
  const off = s.onChange(bump)
  bump()
  return () => {
    off()
    if (supply === s) {
      supply = null
      bump()
    }
  }
}

const subscribeSupply = (l: () => void): (() => void) => {
  supplyListeners.add(l)
  return () => void supplyListeners.delete(l)
}
const supplyVersion = (): number => version

// ---------------------------------------------------------------------------------------------
// The view model.

/** One word as drawn: display page coordinates (top-left origin, y down, pt). */
export interface ShownWord {
  t: string
  /** Baseline start. */
  x: number
  y: number
  /** Advance along the baseline. */
  w: number
  /** Em size: the box runs 0.8 size above the baseline and 0.2 size below. */
  size: number
  /** Baseline rotation, degrees clockwise on screen. */
  deg: number
  /** Calibrated P(correct), or null when unknown (no confidence, or a saved layer). */
  confCal: number | null
  /** Under the calibrated underline threshold: dotted underline, stepped through by ] / [. */
  low: boolean
}

export interface RecognizedTextView {
  /** 'session': recognised while the file is open; 'saved': the file's own PDFx OCR layer. */
  source: 'session' | 'saved' | 'none'
  words: readonly ShownWord[]
  /** Indices into `words` of the low-confidence ones, in reading order. */
  low: readonly number[]
  engineId: string | null
  langs: readonly string[]
  /** Per-word confidence is known for this text. */
  confidence: boolean
}

/** The calibrated threshold under which a word is underlined (calibration.ts). */
export const UNDERLINE_THRESHOLD = CAL_THRESHOLDS.underline

/** The display-frame bounds of a word's em box (for the crop-window test). */
function wordBounds(w: Pick<ShownWord, 'x' | 'y' | 'w' | 'size' | 'deg'>): PageWindow {
  const r = (w.deg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  // Along the baseline (u) and "up" from it (v: screen y decreases going up an upright line).
  const pts = [
    [0, 0.2],
    [w.w, 0.2],
    [w.w, -0.8],
    [0, -0.8]
  ].map(([u, v]) => {
    const vv = v * w.size
    return [w.x + u * cos - vv * sin, w.y + u * sin + vv * cos]
  })
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

const intersects = (r: PageWindow, w: PageWindow): boolean =>
  r.x < w.x + w.w && r.x + r.w > w.x && r.y < w.y + w.h && r.y + r.h > w.y

/** The words of a recognised page (overlay frame, y up) in display coordinates. */
export function sessionWords(
  page: PackedOcrPage,
  pageHeight: number,
  threshold = UNDERLINE_THRESHOLD
): ShownWord[] {
  const out: ShownWord[] = []
  for (const line of ocrLines(page)) {
    for (const w of line.words) {
      if (!w.t) continue
      out.push({
        t: w.t,
        x: w.x,
        y: pageHeight - w.y,
        w: w.w,
        size: line.size,
        deg: (-line.angle * 180) / Math.PI,
        confCal: w.confCal,
        low: w.confCal !== null && w.confCal < threshold
      })
    }
  }
  return out
}

/** The saved layer's runs as words: no confidence, so never underlined. */
export const savedWords = (runs: readonly SavedRun[]): ShownWord[] =>
  runs.map((r) => ({ ...r, confCal: null, low: false }))

/** Words outside the crop window are not drawn (they are clipped) nor stepped to. */
export function inWindow(words: readonly ShownWord[], shownWindow?: PageWindow): ShownWord[] {
  if (!shownWindow) return [...words]
  return words.filter((w) => intersects(wordBounds(w), shownWindow))
}

export function buildView(
  source: RecognizedTextView['source'],
  words: readonly ShownWord[],
  meta?: { engineId: string; langs: readonly string[]; confidence: boolean }
): RecognizedTextView {
  const low: number[] = []
  words.forEach((w, i) => {
    if (w.low) low.push(i)
  })
  return {
    source,
    words,
    low,
    engineId: meta?.engineId ?? null,
    langs: meta?.langs ?? [],
    confidence: meta?.confidence ?? false
  }
}

// ---------------------------------------------------------------------------------------------
// Header copy.

/** "Built-in engine" for the engine PDFx ships (tess-…); another engine is named as such. */
export function engineLabel(engineId: string | null): string {
  if (!engineId) return 'Built-in engine'
  return engineId.startsWith('tess-') ? 'Built-in engine' : 'Another engine'
}

let displayNames: Intl.DisplayNames | null | undefined
/** "English, German" for ['eng', 'deu'] (the Tesseract code when no name is known). */
export function languageNames(langs: readonly string[]): string {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(['en'], { type: 'language' })
    } catch {
      displayNames = null
    }
  }
  return langs
    .map((code) => {
      const tag = bcp47FromTesseract(code)
      if (tag === 'und' || !displayNames) return code
      try {
        return displayNames.of(tag) ?? code
      } catch {
        return code
      }
    })
    .join(', ')
}

const plural = (n: number, one: string, many: string): string =>
  n === 0 ? `no ${many}` : `${n} ${n === 1 ? one : many}`

/** The header line: "Built-in engine · English, German · 3 low-confidence words". */
export function headerText(view: RecognizedTextView): string {
  if (view.source === 'none') return 'No recognized text on this page'
  if (view.source === 'saved') return 'Recognized text saved in this file · confidence not kept'
  const parts = [engineLabel(view.engineId)]
  if (view.langs.length) parts.push(languageNames(view.langs))
  parts.push(
    view.confidence
      ? plural(view.low.length, 'low-confidence word', 'low-confidence words')
      : 'confidence not available'
  )
  return parts.join(' · ')
}

/** The stated limit (§3.5.2, D8). */
export const SESSION_NOTE =
  'Word confidence is kept only while the file is open: after reopening, words show without underlines.'

// ---------------------------------------------------------------------------------------------
// The hook.

/**
 * What the overlay draws for `page` (null while `enabled` is false): its recognised words as Find
 * sees them, restricted to the crop window shown.
 */
export function useRecognizedText(
  page: PageEntry,
  shownWindow: PageWindow | undefined,
  enabled: boolean
): RecognizedTextView | null {
  const key = makePageKey(page.source.id, page.pageIndex)
  const v = useSyncExternalStore(subscribeSupply, supplyVersion)
  const { editLayer, ocrSelect } = useEdits()
  const session = useMemo(
    () => (enabled ? (supply?.filteredPage(key) ?? null) : null),
    // `v` changes whenever the supply's answer may.
    [enabled, key, v]
  )
  // The file's own layer counts only as Find counts it: no redaction, no Replace / Remove choice.
  const redacted = !!editLayer.overlays.get(key)?.some((o) => o.type === 'redaction')
  const savedAllowed = enabled && !session && !redacted && !ocrSelect.has(key)
  const [saved, setSaved] = useState<{ pdf: unknown; index: number; runs: SavedRun[] } | null>(null)
  const { pdf } = page.source
  const index = page.pageIndex
  useEffect(() => {
    if (!savedAllowed) return
    let live = true
    void readSavedLayer(pdf, index).then((runs) => {
      if (live) setSaved({ pdf, index, runs })
    })
    return () => {
      live = false
    }
  }, [savedAllowed, pdf, index])
  const win = shownWindow
  const wx = win?.x
  const wy = win?.y
  const ww = win?.w
  const wh = win?.h
  return useMemo(() => {
    if (!enabled) return null
    const crop = wx === undefined ? undefined : { x: wx, y: wy!, w: ww!, h: wh! }
    if (session) {
      return buildView('session', inWindow(sessionWords(session, page.height), crop), {
        engineId: session.engineId,
        langs: session.langs,
        confidence: session.confSource !== 'none'
      })
    }
    if (savedAllowed && saved && saved.pdf === pdf && saved.index === index && saved.runs.length)
      return buildView('saved', inWindow(savedWords(saved.runs), crop))
    return buildView('none', [])
  }, [enabled, session, savedAllowed, saved, pdf, index, page.height, wx, wy, ww, wh])
}
