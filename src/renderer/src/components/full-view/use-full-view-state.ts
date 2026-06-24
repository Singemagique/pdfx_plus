import { useRef, useState } from 'react'
import type { DocEntry } from '../../types'
import type { Rect, View, Phase } from './geometry'
import { clamp, fitInto, flipTo } from './geometry'

export function useFullViewState(
  docs: DocEntry[],
  startDocId: string,
  startPageId: string,
  originRect: Rect | null
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
    return flipTo(fitInto(sp.width, sp.height, vp), vp, originRect)
  })

  const di = clamp(current.di, 0, docs.length - 1)
  const doc = docs[di]
  const pi = clamp(current.pi, 0, doc.pages.length - 1)
  const page = doc.pages[pi]

  const vw = viewport.w
  const vh = viewport.h
  const fit = fitInto(page.width, page.height, viewport)
  const zoomed = view.zoom > 1.0001
  const interactive = phase === 'open'

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
