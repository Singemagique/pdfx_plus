import { memo } from 'react'
import type { PageEntry } from '../types'
import { useEdits } from '../edit/EditProvider'
import { makePageKey } from '../edit/model'
import { fullPageInWindow, pageFrame, windowFractions } from '../page-geometry'
import { PageView } from './PageView'
import { buildPageDragImage } from './page-drag-image'
import { usePageFindStatus } from '../search/FindContext'
import { OcrPageBadge } from './ocr/OcrPageBadge'

interface PageCellProps {
  docId: string
  page: PageEntry
  /** Card-relative position and size of the cell, straight from the layout. */
  x: number
  y: number
  width: number
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
  x,
  y,
  width,
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
  const { rotations, crops } = useEdits()
  const pageKey = makePageKey(page.source.id, page.pageIndex)
  // The cell previews the page as it exports: only its crop window, then its rotation.
  const frame = pageFrame(page, rotations.get(pageKey) ?? 0, crops.get(pageKey))
  const rot = frame.rotation
  const rotated = rot === 90 || rot === 270
  const cellW = width
  const find = usePageFindStatus(page.id)

  let content: React.JSX.Element
  if (rot || frame.cropped) {
    // The rotor is the upright crop window; it clips the full-page frame positioned inside it.
    const winW = rotated ? pageHeight : cellW
    const winH = rotated ? cellW : pageHeight
    const inner = fullPageInWindow(frame, winW, winH)
    content = (
      <div
        className="page-rotor"
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: winW,
          height: winH,
          // `clip` (no scroll container), like `.full-page`: the window can never be scrolled.
          overflow: 'clip',
          transform: `translate(-50%, -50%) rotate(${rot}deg)`
        }}
      >
        <div
          className="page-frame"
          style={{ left: inner.left, top: inner.top, width: inner.width, height: inner.height }}
        >
          <PageView
            pdf={page.source.pdf}
            pageNumber={page.pageIndex + 1}
            naturalWidth={page.width}
            naturalHeight={page.height}
            version={renderVersion}
            rotation={rot}
            clip={windowFractions(frame)}
          />
        </div>
      </div>
    )
  } else {
    content = (
      <PageView
        pdf={page.source.pdf}
        pageNumber={page.pageIndex + 1}
        naturalWidth={page.width}
        naturalHeight={page.height}
        version={renderVersion}
      />
    )
  }

  return (
    <div
      data-page-id={page.id}
      className={
        'page' +
        (selected ? ' selected' : '') +
        (collapsed ? ' collapsing' : '') +
        (find === 'current' ? ' find-current' : find === 'hit' ? ' find-hit' : '')
      }
      style={
        collapsed
          ? {
              position: 'absolute',
              left: x,
              top: y,
              width: 0,
              height: pageHeight,
              opacity: 0,
              pointerEvents: 'none'
            }
          : {
              position: 'absolute',
              left: x,
              top: y,
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
        const img = buildPageDragImage(el, rect, rot)
        e.dataTransfer.setDragImage(img, e.clientX - rect.left, e.clientY - rect.top)
        window.setTimeout(() => img.remove(), 0)
        onPageDragStart(docId, page.id)
      }}
      onDragEnd={onPageDragEnd}
    >
      {content}
      <OcrPageBadge pageKey={pageKey} />
      <span className="page-number">{visibleNumber}</span>
    </div>
  )
}

export const PageCell = memo(PageCellImpl)
