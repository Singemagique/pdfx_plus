// Score one mapped OcrPage against a synth page's ground truth (DESIGN.md §3.9.2) for the tier-1
// gate. Test-only, DOM-free.
//
// - Text: the copy text a perfect engine yields — words joined by one space, lines by "\n" — vs
//   `gt.text`: grapheme CER, WER and bag-of-words error.
// - Boxes: each word's em box (what the text layer and Find highlight cover: baseline −0.2 s ..
//   +0.8 s along the advance, rotated by the line angle; its axis-aligned bounds) vs the GT advance
//   × ascent..descent box in the output frame, IoU > 0.5, greedy one-to-one (box hmean, median IoU).
// - Find recall: a stand-in for the real search engine (search/engine.ts takes OCR supply in PR7a):
//   a folded substring search inside each OCR word, the hit narrowed by the word's char edges.

import { bagOfWordsError, boxScores, cer, findScores, foldForFind, wer, type Box } from './metrics'
import type { SynthGt } from './synth'
import { wordQuad, type OcrLine, type OcrPage, type OcrWord } from '../types'

export interface PageScores {
  cer: number
  wer: number
  bwe: number
  recall: number
  hitOnTarget: number
  hmean: number
  medianIou: number | null
  words: number
  gtWords: number
}

/** The copy text of a page: words by one space, lines by "\n". */
export function copyText(page: OcrPage): string {
  return page.lines.map((l) => l.words.map((w) => w.t).join(' ')).join('\n')
}

function bounds(pts: { x: number; y: number }[]): Box {
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/** The em box of `word` from char edge `a` to edge `b` (whole word by default). */
export function emBox(word: OcrWord, line: OcrLine, a = 0, b?: number): Box {
  const e0 = word.chars ? word.chars[a] : 0
  const e1 = word.chars && b !== undefined ? word.chars[b] : word.w
  const cos = Math.cos(line.angle)
  const sin = Math.sin(line.angle)
  const sub = { x: word.x + e0 * cos, y: word.y + e0 * sin, w: e1 - e0 }
  return bounds(wordQuad(sub, line))
}

/** Folded substring hits inside OCR words, as Find would return them for a single-word query. */
export function searchWords(page: OcrPage): (q: string) => { page: number; box: Box }[] {
  return (query) => {
    const fq = foldForFind(query)
    const hits: { page: number; box: Box }[] = []
    for (const line of page.lines)
      for (const word of line.words) {
        const cps = [...word.t]
        const folded = foldForFind(word.t)
        const sameLength = [...folded].length === cps.length
        for (let at = folded.indexOf(fq); at >= 0; at = folded.indexOf(fq, at + 1)) {
          if (word.chars && sameLength) {
            const a = [...folded.slice(0, at)].length
            const b = a + [...fq].length
            hits.push({ page: 0, box: emBox(word, line, a, b) })
          } else hits.push({ page: 0, box: emBox(word, line) })
        }
      }
    return hits
  }
}

export async function scorePage(page: OcrPage, gt: SynthGt): Promise<PageScores> {
  const hyp = copyText(page)
  const hypBoxes: Box[] = []
  for (const l of page.lines) for (const w of l.words) hypBoxes.push(emBox(w, l))
  const boxes = boxScores(
    gt.words.map((w) => w.box),
    hypBoxes
  )
  const find = await findScores(
    gt.words.map((w) => ({ t: w.t, box: w.box })),
    searchWords(page)
  )
  return {
    cer: cer(gt.text, hyp).rate,
    wer: wer(gt.text, hyp).rate,
    bwe: bagOfWordsError(gt.text, hyp),
    recall: find.recall,
    hitOnTarget: find.hitOnTarget,
    hmean: boxes.hmean,
    medianIou: boxes.medianIou,
    words: hypBoxes.length,
    gtWords: gt.words.length
  }
}
