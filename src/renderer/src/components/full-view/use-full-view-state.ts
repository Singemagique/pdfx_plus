import { useRef, useState } from 'react'
import type { DocEntry, PageEntry } from '../../types'
import type { PageFrame } from '../../page-geometry'
import type { Rect, Size, View, Phase } from './geometry'
import { clamp, flipTo } from './geometry'
import { fullViewBox } from './page-display'

/**
 * @param currentFrameOf How the CURRENT page is displayed (its crop window and rotation — or the
 *   whole page while the crop tool edits it). Only ever called for the current page.
 */
export function useFullViewState(
  docs: DocEntry[],
  startDocId: string,
  startPageId: string,
  originRect: Rect | null,
  currentFrameOf: (page: PageEntry) => PageFrame
) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const draggedRef = useRef(false)
  const scrollRaf = useRef<number | null>(null)
  const closingRef = useRef(false)

  const startDi = Math.max(
    0,
    docs.findIndex((d) => d.id === startDocId)
  )
  const startPi = Math.max(
    0,
    (docs[startDi] ?? docs[0])?.pages.findIndex((p) => p.id === startPageId) ?? 0
  )

  const [current, setCurrent] = useState({ di: startDi, pi: startPi })
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight })
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 })
  const [renderVersion, setRenderVersion] = useState(0)
  const [phase, setPhase] = useState<Phase>(originRect ? 'opening' : 'open')
  const [revealed, setRevealed] = useState(!originRect)
  const [flipTransition, setFlipTransition] = useState(false)
  const [flip, setFlip] = useState<string | null>(() => {
    if (!originRect) return null
    const sp = (docs[startDi] ?? docs[0]).pages[startPi]
    const vp = { w: window.innerWidth, h: window.innerHeight }
    return flipTo(fullViewBox(currentFrameOf(sp), vp).box, vp, originRect)
  })

  const di = clamp(current.di, 0, docs.length - 1)
  const doc = docs[di]
  const pi = clamp(current.pi, 0, doc.pages.length - 1)
  const page = doc.pages[pi]

  const vw = viewport.w
  const vh = viewport.h
  // The displayed (cropped + rotated) page fitted to the viewport, and the upright box it is drawn in.
  const { dfit: fit, box } = fullViewBox(currentFrameOf(page), viewport)
  const zoomed = view.zoom > 1.0001
  const interactive = phase === 'open'

  const fitRef = useRef<Size>(fit)
  fitRef.current = fit
  const boxRef = useRef<Size>(box)
  boxRef.current = box

  const docsRef = useRef(docs)
  docsRef.current = docs
  const vpRef = useRef(viewport)
  vpRef.current = viewport
  const curRef = useRef({ di, pi })
  curRef.current = { di, pi }
  const zoomedRef = useRef(zoomed)
  zoomedRef.current = zoomed
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  return {
    scrollRef,
    drag,
    draggedRef,
    scrollRaf,
    closingRef,
    docsRef,
    vpRef,
    curRef,
    zoomedRef,
    phaseRef,
    fitRef,
    boxRef,
    current,
    setCurrent,
    viewport,
    setViewport,
    view,
    setView,
    renderVersion,
    setRenderVersion,
    phase,
    setPhase,
    revealed,
    setRevealed,
    flipTransition,
    setFlipTransition,
    flip,
    setFlip,
    di,
    doc,
    pi,
    page,
    vw,
    vh,
    fit,
    zoomed,
    interactive
  }
}
