import { useCallback, useRef } from 'react'
import type { DocEntry } from '../../types'
import type { View } from './geometry'
import { clamp, fitInto, flipTo, MAX_ZOOM, MIN_ZOOM, TRANSITION_MS } from './geometry'

interface ControlsOptions {
  scrollRef: React.RefObject<HTMLDivElement | null>
  closingRef: React.MutableRefObject<boolean>
  docsRef: React.MutableRefObject<DocEntry[]>
  vpRef: React.MutableRefObject<{ w: number; h: number }>
  curRef: React.MutableRefObject<{ di: number; pi: number }>
  phaseRef: React.MutableRefObject<'opening' | 'open' | 'closing'>
  /** The in-progress pan of a zoomed page, if any. */
  dragRef?: React.MutableRefObject<unknown>
  zoomedRef?: React.MutableRefObject<boolean>
  setView: React.Dispatch<React.SetStateAction<View>>
  setPhase: (phase: 'opening' | 'open' | 'closing') => void
  setFlip: (flip: string | null) => void
  setFlipTransition: (on: boolean) => void
  setRevealed: (on: boolean) => void
  onClose: () => void
}

export interface FullViewControls {
  resetView: () => void
  applyZoom: (nextZoom: (z: number) => number, focal?: { x: number; y: number }) => void
  panBy: (dx: number, dy: number) => void
  navByKey: (axis: 'x' | 'y', dir: 1 | -1) => void
  runClose: () => void
}

export interface FullViewNav {
  /** Scroll to a page (Find's next/prev); deferred until the open animation has finished. */
  goTo: (docId: string, pageId: string) => void
}

export function useFullViewControls(
  opts: ControlsOptions
): FullViewControls & FullViewNav & { runPendingGoTo: () => void } {
  const { scrollRef, closingRef, docsRef, vpRef, curRef, phaseRef, dragRef, zoomedRef } = opts
  const { setView, setPhase, setFlip, setFlipTransition, setRevealed, onClose } = opts

  const resetView = useCallback(() => setView({ zoom: 1, x: 0, y: 0 }), [])

  const applyZoom = useCallback(
    (nextZoom: (z: number) => number, focal?: { x: number; y: number }) => {
      setView((v) => {
        const nz = clamp(nextZoom(v.zoom), MIN_ZOOM, MAX_ZOOM)
        if (nz === v.zoom) return v
        const vp = vpRef.current
        const { di: cdi, pi: cpi } = curRef.current
        const p = docsRef.current[cdi].pages[cpi]
        const b = fitInto(p.width, p.height, vp)
        const r = nz / v.zoom
        const cx = focal ? focal.x : vp.w / 2
        const cy = focal ? focal.y : vp.h / 2
        const dx = cx - vp.w / 2
        const dy = cy - vp.h / 2
        const maxX = Math.max(0, (b.w * nz - vp.w) / 2)
        const maxY = Math.max(0, (b.h * nz - vp.h) / 2)
        return {
          zoom: nz,
          x: clamp(dx * (1 - r) + r * v.x, -maxX, maxX),
          y: clamp(dy * (1 - r) + r * v.y, -maxY, maxY)
        }
      })
    },
    []
  )

  const panBy = useCallback((dx: number, dy: number) => {
    const vp = vpRef.current
    const { di: cdi, pi: cpi } = curRef.current
    const p = docsRef.current[cdi].pages[cpi]
    const b = fitInto(p.width, p.height, vp)
    setView((v) => {
      const maxX = Math.max(0, (b.w * v.zoom - vp.w) / 2)
      const maxY = Math.max(0, (b.h * v.zoom - vp.h) / 2)
      return { ...v, x: clamp(v.x + dx, -maxX, maxX), y: clamp(v.y + dy, -maxY, maxY) }
    })
  }, [])

  const navByKey = useCallback((axis: 'x' | 'y', dir: 1 | -1) => {
    const sc = scrollRef.current
    if (!sc) return
    const { di: cdi, pi: cpi } = curRef.current
    if (axis === 'x') {
      const docEl = sc.children[cdi] as HTMLElement | undefined
      if (!docEl) return
      const target = clamp(cpi + dir, 0, docsRef.current[cdi].pages.length - 1)
      const slide = docEl.children[target] as HTMLElement | undefined
      if (slide) docEl.scrollTo({ left: slide.offsetLeft, behavior: 'smooth' })
    } else {
      const target = clamp(cdi + dir, 0, docsRef.current.length - 1)
      const docEl = sc.children[target] as HTMLElement | undefined
      if (docEl) sc.scrollTo({ top: docEl.offsetTop, behavior: 'smooth' })
    }
  }, [])

  const runClose = useCallback(() => {
    if (closingRef.current || phaseRef.current !== 'open') return
    closingRef.current = true
    const { di: cdi, pi: cpi } = curRef.current
    const p = docsRef.current[cdi].pages[cpi]
    const el = document.querySelector(`[data-page-id="${CSS.escape(p.id)}"]`)
    const r = el?.getBoundingClientRect()
    if (!r || r.width === 0) {
      onClose()
      return
    }
    const vp = vpRef.current
    const target = flipTo(fitInto(p.width, p.height, vp), vp, r)
    setView({ zoom: 1, x: 0, y: 0 })
    setPhase('closing')
    setFlip(null)
    setFlipTransition(false)
    requestAnimationFrame(() => {
      setFlip(target)
      setFlipTransition(true)
      setRevealed(false)
    })
    window.setTimeout(onClose, TRANSITION_MS + 20)
  }, [onClose])

  const pendingGoTo = useRef<{ docId: string; pageId: string } | null>(null)

  const goTo = useCallback((docId: string, pageId: string) => {
    const di = docsRef.current.findIndex((d) => d.id === docId)
    const pi = di >= 0 ? docsRef.current[di].pages.findIndex((p) => p.id === pageId) : -1
    if (pi < 0) return
    if (phaseRef.current !== 'open') {
      if (phaseRef.current === 'opening') pendingGoTo.current = { docId, pageId }
      return
    }
    pendingGoTo.current = null
    const cur = curRef.current
    if (cur.di === di && cur.pi === pi) return
    // Mid-pan of a zoomed page: leave the user where they are.
    if (dragRef?.current) return
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const behavior: ScrollBehavior = reduced ? 'auto' : 'smooth'
    const scroll = (): void => {
      const sc = scrollRef.current
      const docEl = sc?.children[di] as HTMLElement | undefined
      const slide = docEl?.children[pi] as HTMLElement | undefined
      if (!sc || !docEl || !slide) return
      docEl.scrollTo?.({ left: slide.offsetLeft, behavior })
      sc.scrollTo?.({ top: docEl.offsetTop, behavior })
    }
    if (zoomedRef?.current) {
      // The scrollers are locked while zoomed: reset first, scroll once they are free again.
      resetView()
      requestAnimationFrame(scroll)
    } else scroll()
  }, [])

  const runPendingGoTo = useCallback(() => {
    const p = pendingGoTo.current
    if (p) goTo(p.docId, p.pageId)
  }, [goTo])

  return { resetView, applyZoom, panBy, navByKey, runClose, goTo, runPendingGoTo }
}
