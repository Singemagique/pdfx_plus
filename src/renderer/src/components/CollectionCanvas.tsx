import { useCallback, useMemo } from 'react'
import {
  MIN_DOC_WIDTH,
  BASE_PAGE_HEIGHT,
  betweenSlotY,
  wrapWidthForViewport
} from '../canvas/layout'
import { useImportFocus } from '../canvas/imported-doc'
import { Canvas } from './Canvas'
import { EmptyState } from './EmptyState'
import { AddDocGhost, GhostRow } from './DropGhost'
import { DocLayer } from './collection/DocLayer'
import { HeaderLayer } from './collection/HeaderLayer'
import { deriveDropGhosts } from './collection/ghost-size'
import { computeDragView } from './collection/drag-view'
import type { CanvasHandle } from './Canvas'
import type { CanvasLayout, DropTarget } from '../canvas/layout'
import type { PageRef } from '../app/types'
import type { DocEntry } from '../types'

interface CollectionCanvasProps {
  docs: DocEntry[]
  layout: CanvasLayout
  busy: boolean
  pagesDraggable: boolean
  renderVersion: number
  selected: PageRef | null
  hiddenPageId: string | null
  dragKind: 'internal' | 'external' | null
  draggingPage: PageRef | null
  dropTarget: DropTarget | null
  collapsedId: string | null
  externalCount: number
  canvasRef: React.Ref<CanvasHandle>
  onScaleChange: (scale: number) => void
  onSettle: () => void
  onBackgroundClick: () => void
  /** The world width documents should wrap to, derived from the canvas viewport's width. */
  onWrapWidthChange?: (wrapWidth: number) => void
  onOpen: () => void
  onSelectPage: (docId: string, pageId: string) => void
  onOpenPage: (docId: string, pageId: string) => void
  onPageDragStart: (docId: string, pageId: string) => void
  onPageDragEnd: () => void
  onAddPage: (docId: string) => void
  onMoveDoc: (docId: string, direction: -1 | 1) => void
  onRemoveDoc: (docId: string) => void
  onRenameDoc: (docId: string, name: string) => void
}

export function CollectionCanvas(props: CollectionCanvasProps): React.JSX.Element {
  const { docs, layout, dragKind, draggingPage, dropTarget, externalCount, collapsedId } = props
  const { onWrapWidthChange } = props

  const focus = useImportFocus(docs, layout)

  const { intoDocId, intoIndex, betweenIndex, ghostSize, betweenPages } = deriveDropGhosts(
    layout,
    draggingPage,
    dropTarget,
    dragKind,
    externalCount
  )

  const draggingDocId = draggingPage?.docId ?? null
  const ghostWidth = ghostSize.width
  const dragView = useMemo(
    () =>
      computeDragView(layout, {
        collapsedId,
        draggingDocId,
        intoDocId,
        intoIndex,
        intoGhostWidth: ghostWidth,
        betweenIndex
      }),
    [layout, collapsedId, draggingDocId, intoDocId, intoIndex, ghostWidth, betweenIndex]
  )

  const onViewportWidth = useCallback(
    (width: number) => onWrapWidthChange?.(wrapWidthForViewport(width)),
    [onWrapWidthChange]
  )

  if (docs.length === 0) {
    return (
      <>
        <EmptyState busy={props.busy} dragging={dragKind === 'external'} onOpen={props.onOpen} />
        {dragKind === 'external' && (
          <div className="empty-drop-stage">
            <GhostRow width={MIN_DOC_WIDTH} pageHeight={BASE_PAGE_HEIGHT} pages={betweenPages} />
          </div>
        )}
      </>
    )
  }

  return (
    <Canvas
      ref={props.canvasRef}
      contentWidth={layout.contentWidth}
      contentHeight={layout.contentHeight}
      focus={focus}
      dragging={dragKind !== null}
      onScaleChange={props.onScaleChange}
      onSettle={props.onSettle}
      onBackgroundClick={props.onBackgroundClick}
      onViewportWidth={onViewportWidth}
      overlay={
        <HeaderLayer
          items={layout.items}
          shifts={dragView.shifts}
          onMove={props.onMoveDoc}
          onRemove={props.onRemoveDoc}
          onRename={props.onRenameDoc}
        />
      }
    >
      <DocLayer
        items={layout.items}
        dragView={dragView}
        renderVersion={props.renderVersion}
        selected={props.selected}
        pagesDraggable={props.pagesDraggable}
        collapsedId={collapsedId}
        draggingPage={draggingPage}
        hiddenPageId={props.hiddenPageId}
        intoDocId={intoDocId}
        intoIndex={intoIndex}
        intoGhostWidth={ghostSize.width}
        intoGhostHeight={ghostSize.height}
        onSelectPage={props.onSelectPage}
        onOpenPage={props.onOpenPage}
        onPageDragStart={props.onPageDragStart}
        onPageDragEnd={props.onPageDragEnd}
        onAddPage={props.onAddPage}
      />
      {dropTarget?.kind === 'between' && (
        <div
          className="canvas-doc ghost-doc"
          style={{ left: 0, top: betweenSlotY(layout, dropTarget.docIndex), width: MIN_DOC_WIDTH }}
        >
          <GhostRow width={MIN_DOC_WIDTH} pageHeight={BASE_PAGE_HEIGHT} pages={betweenPages} />
        </div>
      )}
      <div
        className="canvas-doc"
        style={{ left: 0, top: betweenSlotY(layout, layout.items.length), width: MIN_DOC_WIDTH }}
      >
        <AddDocGhost width={MIN_DOC_WIDTH} onClick={props.onOpen} />
      </div>
    </Canvas>
  )
}
