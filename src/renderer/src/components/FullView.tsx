import type { DocEntry } from '../types'
import type { Rect } from './full-view/geometry'
import { useFullViewState } from './full-view/use-full-view-state'
import { useFullViewControls } from './full-view/use-full-view-controls'
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
}

export function FullView({
  docs,
  startDocId,
  startPageId,
  originRect,
  onActivePageChange,
  onClose
}: FullViewProps): React.JSX.Element {
  const s = useFullViewState(docs, startDocId, startPageId, originRect)

  const controls = useFullViewControls({
    scrollRef: s.scrollRef,
    closingRef: s.closingRef,
    docsRef: s.docsRef,
    vpRef: s.vpRef,
    curRef: s.curRef,
    phaseRef: s.phaseRef,
    setView: s.setView,
    setPhase: s.setPhase,
    setFlip: s.setFlip,
    setFlipTransition: s.setFlipTransition,
    setRevealed: s.setRevealed,
    onClose
  })

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

  const animating = s.phase !== 'open'
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
