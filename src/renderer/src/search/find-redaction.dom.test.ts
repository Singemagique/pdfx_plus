// Find honours redactions on ordinary (native-text) PDFs (DESIGN.md §3.6.1, a deliberate 1.1.4
// behaviour change): App's own wiring — useEditStore's overlays → useFind → the controller → the
// engine's setRedactions — over a real pdf.js text extraction. A one-word redaction hides that
// word from Find, the rest of the line is still found, and undoing the redaction finds it again.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'

import { useEditStore, type EditStore } from '../edit/EditProvider'
import type { Overlay } from '../edit/model'
import type { DocEntry, PdfSource } from '../types'
import type { FindController } from './find-controller'
import { useFind } from './useFind'

const SIZE = 12
const X = 72
const BASELINE = 700
const LINE = 'alpha bravo charlie delta echo'

let pdf: PDFDocumentProxy
let docs: DocEntry[]
/** The overlay-frame box of "charlie": its advance × the font's ascent..descent. */
let charlie: { x: number; y: number; w: number; h: number }

let store: EditStore
let find: FindController
let container: HTMLDivElement
let root: Root

function Harness({ docs: d }: { docs: DocEntry[] }): ReactNode {
  store = useEditStore()
  find = useFind({
    docs: d,
    overlays: store.overlays,
    getAnchorPageId: () => null,
    onNavigate: () => {}
  })
  return null
}

beforeAll(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([612, 792])
  page.drawText(LINE, { x: X, y: BASELINE, size: SIZE, font })
  page.drawText('foxtrot golf charlie', { x: X, y: BASELINE - 40, size: SIZE, font })
  const ascent = font.heightAtSize(SIZE, { descender: false })
  const descent = font.heightAtSize(SIZE) - ascent
  charlie = {
    x: X + font.widthOfTextAtSize('alpha bravo ', SIZE),
    y: BASELINE - descent,
    w: font.widthOfTextAtSize('charlie', SIZE),
    h: ascent + descent
  }
  pdf = (await getDocument({ data: await doc.save(), verbosity: 0 })
    .promise) as unknown as PDFDocumentProxy
  const source = { id: 'src-1', bytes: new Uint8Array(), pdf } as unknown as PdfSource
  docs = [
    {
      id: 'd1',
      name: 'd1.pdf',
      pages: [{ id: 'p1', source, pageIndex: 0, width: 612, height: 792 }]
    }
  ]
})

afterAll(async () => {
  await pdf?.destroy()
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

/** Wait (in real time) until `cond` holds: pdf.js extraction runs on its own schedule. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return
    await act(() => new Promise<void>((r) => setTimeout(r, 5)))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** Commit `q` and wait until the bar has settled on it; the match count. */
async function count(q: string): Promise<number> {
  act(() => {
    find.setQuery(q)
    find.flush()
  })
  await until(() => !find.getBarState().indexing, 'indexing')
  return find.getBarState().total
}

const redaction = (): Overlay => ({
  id: 'red-1',
  type: 'redaction',
  pageKey: 'src-1#0',
  z: 1,
  createdAt: 1,
  fill: { r: 0, g: 0, b: 0 },
  geom: { ...charlie, rotation: 0, opacity: 1 }
})

describe('Find on a native-text PDF with a one-word redaction', () => {
  it('hides the word, keeps the rest of the line, and finds it again after undo', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root.render(createElement(Harness, { docs })))
    act(() => find.open())
    await until(() => find.getBarState().indexed === 1, 'the page text')

    expect(await count('charlie')).toBe(2)

    act(() => store.addOverlay(redaction()))
    // The boxed word is gone; its other occurrence (line 2) is not.
    expect(await count('charlie')).toBe(1)
    expect(find.getCurrentMatch()).toMatchObject({ pageId: 'p1', kind: 'text' })
    const [hl] = find.getPageHighlights('p1')
    expect(hl.rect.y).toBeGreaterThan(792 - BASELINE + 20) // the line-2 one
    // The rest of the redacted line is still found (its far words; the box's facing characters
    // go with it, see redact-filter.ts), and so is the next line.
    for (const q of ['alpha', 'echo', 'brav', 'elta', 'foxtrot golf'])
      expect(await count(q), q).toBe(1)
    // The words either side never join across the box (a space stands where it was, as in the
    // text an export of the redacted page yields).
    expect(await count('bravelta')).toBe(0)
    expect(await count('brav elta')).toBe(1)

    act(() => store.undo())
    expect(await count('charlie')).toBe(2)
    expect(await count('bravo charlie delta')).toBe(1)
  })
})
