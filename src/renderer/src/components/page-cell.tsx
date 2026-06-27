import { memo } from 'react'
import type { PageEntry } from '../types'
import { pageCellWidth } from '../canvas/layout'
import { useEdits } from '../edit/EditProvider'
import { makePageKey } from '../edit/model'
import { PageView } from './PageView'
import { buildPageDragImage } from './page-drag-image'

interface PageCellProps {
  docId: string
  page: PageEntry
  pageHeight: number
  renderVersion: number
  selected: boolean
  collapsed: boolean
  hidden: boolean
  pagesDraggable: boolean
  visibleNumber: number
  onSelectPage: (docId: string, pageId: string) => void
  onOpenPage: (docId: string, pageId: string) => void
  onPageDragStart: (docId: string, pageId: string) => void
  onPageDragEnd: () => void
}

function PageCellImpl({
  docId,
  page,
  pageHeight,
  renderVersion,
  selected,
  collapsed,
  hidden,
  pagesDraggable,
  visibleNumber,
  onSelectPage,
  onOpenPage,
  onPageDragStart,
  onPageDragEnd
}: PageCellProps): React.JSX.Element {
  const { rotations } = useEdits()
  const rot = rotations.get(makePageKey(page.source.id, page.pageIndex)) ?? 0
  const rotated = rot === 90 || rot === 270
  const cellW = pageCellWidth(page, rotations)
  return (
    <div
      data-page-id={page.id}
      className={'page' + (selected ? ' selected' : '') + (collapsed ? ' collapsing' : '')}
      style={
        collapsed
          ? {
              width: 0,
              height: pageHeight,
              position: 'absolute',
              opacity: 0,
              pointerEvents: 'none'
            }
          : {
              width: cellW,
              height: pageHeight,
              visibility: hidden ? 'hidden' : undefined
            }
      }
      draggable={pagesDraggable}
      onClick={(e) => {
        e.stopPropagation()
        onSelectPage(docId, page.id)
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onOpenPage(docId, page.id)
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-pdfx-page', page.id)
        e.dataTransfer.effectAllowed = 'move'
        const el = e.currentTarget as HTMLElement
        const rect = el.getBoundingClientRect()
        const img = buildPageDragImage(el, rect)
        e.dataTransfer.setDragImage(img, e.clientX - rect.left, e.clientY - rect.top)
        window.setTimeout(() => img.remove(), 0)
        onPageDragStart(docId, page.id)
      }}
      onDragEnd={onPageDragEnd}
    >
      {rot ? (
        <div
          className="page-rotor"
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            width: rotated ? pageHeight : cellW,
            height: rotated ? cellW : pageHeight,
            transform: `translate(-50%, -50%) rotate(${rot}deg)`
          }}
        >
          <PageView
            pdf={page.source.pdf}
            pageNumber={page.pageIndex + 1}
            naturalWidth={page.width}
            naturalHeight={page.height}
            version={renderVersion}
          />
        </div>
      ) : (
        <PageView
          pdf={page.source.pdf}
          pageNumber={page.pageIndex + 1}
          naturalWidth={page.width}
          naturalHeight={page.height}
          version={renderVersion}
        />
      )}
      <span className="page-number">{visibleNumber}</span>
    </div>
  )
}

export const PageCell = memo(PageCellImpl)
