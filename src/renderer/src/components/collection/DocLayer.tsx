import { memo } from 'react'
import { DocumentRow } from '../DocumentRow'
import type { DocPlacement } from '../../canvas/layout'
import type { PageRef } from '../../app/types'
import type { DragView } from './drag-view'

interface DocLayerProps {
  items: DocPlacement[]
  dragView: DragView
  renderVersion: number
  selected: PageRef | null
  pagesDraggable: boolean
  collapsedId: string | null
  draggingPage: PageRef | null
  hiddenPageId: string | null
  intoDocId: string | null
  intoIndex: number
  intoGhostWidth: number
  intoGhostHeight: number
  onSelectPage: (docId: string, pageId: string) => void
  onOpenPage: (docId: string, pageId: string) => void
  onPageDragStart: (docId: string, pageId: string) => void
  onPageDragEnd: () => void
  onAddPage: (docId: string) => void
}

function DocLayerImpl(props: DocLayerProps): React.JSX.Element {
  const { items, dragView, intoDocId, intoIndex, intoGhostWidth, intoGhostHeight } = props
  return (
    <>
      {items.map((item, index) => {
        const doc = item.doc
        const shift = dragView.shifts[index] ?? 0
        return (
          <div
            key={doc.id}
            className="canvas-doc"
            style={{
              left: item.x,
              top: item.y,
              width: item.width,
              transform: shift ? `translateY(${shift}px)` : undefined
            }}
          >
            <DocumentRow
              item={item}
              reflow={dragView.reflows.get(doc.id) ?? null}
              renderVersion={props.renderVersion}
              selectedPageId={props.selected?.docId === doc.id ? props.selected.pageId : null}
              pagesDraggable={props.pagesDraggable}
              collapseId={
                props.collapsedId && props.draggingPage?.docId === doc.id ? props.collapsedId : null
              }
              hiddenPageId={
                props.hiddenPageId && doc.pages.some((p) => p.id === props.hiddenPageId)
                  ? props.hiddenPageId
                  : null
              }
              intoGhost={
                intoDocId === doc.id
                  ? { index: intoIndex, width: intoGhostWidth, height: intoGhostHeight }
                  : null
              }
              onSelectPage={props.onSelectPage}
              onOpenPage={props.onOpenPage}
              onPageDragStart={props.onPageDragStart}
              onPageDragEnd={props.onPageDragEnd}
              onAddPage={props.onAddPage}
            />
          </div>
        )
      })}
    </>
  )
}

export const DocLayer = memo(DocLayerImpl)
