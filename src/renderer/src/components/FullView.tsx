import { useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import type { DocEntry, PageEntry } from '../types'
import { useEdits } from '../edit/EditProvider'
import { frameOf } from '../page-geometry'
import type { Rect } from './full-view/geometry'
import { useFullViewState } from './full-view/use-full-view-state'
import { useFullViewControls, type FullViewNav } from './full-view/use-full-view-controls'
import { useFullViewLayout } from './full-view/use-full-view-layout'
import { useFullViewEffects } from './full-view/use-full-view-effects'
import { useFullViewInput } from './full-view/use-full-view-input'
import { FullViewChrome } from './full-view/FullViewChrome'
import { FullViewPages } from './full-view/FullViewPages'

interface FullViewProps {
  docs: DocEntry[]
  startDocId: string
  startPageId: string
  originRect: Rect | null
  onActivePageChange: (pageId: string) => void
  onClose: () => void
  /** Imperative navigation for Find (scroll to the page holding a match). */
  navRef?: React.Ref<FullViewNav>
}

export function FullView({
  docs,
  startDocId,
  startPageId,
  originRect,
  onActivePageChange,
  onClose,
  navRef
}: FullViewProps): React.JSX.Element {
  // The current page shows at its exported geometry (crop window, then rotation) — except while the
  // crop tool is on and the view is open, when it shows whole so the crop can be redrawn wider
  // (FullViewPage agrees). The open/close FLIP always uses the exported geometry: the collection
  // cell it animates from/to has the cropped aspect, and a whole-page box scaled to the cell's width
  // would balloon past it.
  const { rotations, crops, tool } = useEdits()
  const currentFrameOf = useCallback(
    (page: PageEntry, animating: boolean) =>
      frameOf(page, { rotations, crops }, { ignoreCrop: tool === 'crop' && !animating }),
    [rotations, crops, tool]
  )
  const s = useFullViewState(docs, startDocId, startPageId, originRect, currentFrameOf)

  // Entering/leaving crop editing, or undoing/redoing a crop, changes the displayed frame: a zoom
  // and pan computed for the old one would be meaningless, so start the new one fitted.
  const animating = s.phase !== 'open'
  const editingCrop = tool === 'crop' && !animating
  const win = currentFrameOf(s.page, animating).window
  const frameKey = `${editingCrop}|${win.x}|${win.y}|${win.w}|${win.h}`
  const lastFrameKey = useRef(frameKey)
  const { setView } = s
  useEffect(() => {
    if (lastFrameKey.current === frameKey) return
    lastFrameKey.current = frameKey
    setView((v) => (v.zoom === 1 && v.x === 0 && v.y === 0 ? v : { zoom: 1, x: 0, y: 0 }))
  }, [frameKey, setView])

  const controls = useFullViewControls({
    scrollRef: s.scrollRef,
    closingRef: s.closingRef,
    docsRef: s.docsRef,
    vpRef: s.vpRef,
    curRef: s.curRef,
    fitRef: s.fitRef,
    boxRef: s.boxRef,
    phaseRef: s.phaseRef,
    dragRef: s.drag,
    zoomedRef: s.zoomedRef,
    setView: s.setView,
    setPhase: s.setPhase,
    setFlip: s.setFlip,
    setFlipTransition: s.setFlipTransition,
    setRevealed: s.setRevealed,
    onClose
  })

  const { goTo, runPendingGoTo } = controls
  useImperativeHandle(navRef, () => ({ goTo }), [goTo])
  // A Find navigation that arrived during the open animation runs once the page has landed.
  useEffect(() => {
    if (s.phase === 'open') runPendingGoTo()
  }, [s.phase, runPendingGoTo])

  useFullViewLayout({
    scrollRef: s.scrollRef,
    curRef: s.curRef,
    originRect,
    vw: s.vw,
    vh: s.vh,
    setPhase: s.setPhase,
    setFlip: s.setFlip,
    setFlipTransition: s.setFlipTransition,
    setRevealed: s.setRevealed
  })
  useFullViewEffects({
    scrollRef: s.scrollRef,
    scrollRaf: s.scrollRaf,
    docsRef: s.docsRef,
    vpRef: s.vpRef,
    pageId: s.page.id,
    onActivePageChange,
    vw: s.vw,
    vh: s.vh,
    fit: s.fit,
    view: s.view,
    curDi: s.current.di,
    curPi: s.current.pi,
    setViewport: s.setViewport,
    setView: s.setView,
    setCurrent: s.setCurrent,
    setRenderVersion: s.setRenderVersion
  })
  useFullViewInput({
    scrollRef: s.scrollRef,
    zoomedRef: s.zoomedRef,
    phaseRef: s.phaseRef,
    ...controls
  })

  const chromeOpacity = s.revealed ? 1 : 0

  return (
    <div className="full-view">
      <div className="full-backdrop" style={{ opacity: chromeOpacity }} />
      <FullViewPages
        scrollRef={s.scrollRef}
        drag={s.drag}
        draggedRef={s.draggedRef}
        docs={docs}
        viewport={s.viewport}
        di={s.di}
        pi={s.pi}
        view={s.view}
        fit={s.fit}
        vw={s.vw}
        vh={s.vh}
        zoomed={s.zoomed}
        interactive={s.interactive}
        animating={animating}
        flip={s.flip}
        flipTransition={s.flipTransition}
        renderVersion={s.renderVersion}
        setView={s.setView}
        resetView={controls.resetView}
        applyZoom={controls.applyZoom}
        runClose={controls.runClose}
      />
      <FullViewChrome
        chromeOpacity={chromeOpacity}
        docName={s.doc.name}
        pi={s.pi}
        pageCount={s.doc.pages.length}
        runClose={controls.runClose}
        navByKey={controls.navByKey}
      />
    </div>
  )
}
