import { memo } from 'react'
import type { PageEntry } from '../types'
import { pageCellWidth } from '../canvas/layout'
import { useEdits } from '../edit/EditProvider'
import { makePageKey, type CropBox } from '../edit/model'
import { PageView } from './PageView'
import { buildPageDragImage } from './page-drag-image'

/** Dim the cropped-away area of a thumbnail (crop is in unrotated page points, origin bottom-left;
 *  the box w×h is the unrotated PageView size, so this rotates with the page rotor). */
function CropMask({
  crop,
  page,
  w,
  h
}: {
  crop: CropBox
  page: PageEntry
  w: number
  h: number
}): React.JSX.Element {
  const sx = w / page.width
  const sy = h / page.height
  const left = crop.x * sx
  const top = (page.height - crop.y - crop.h) * sy
  const cw = crop.w * sx
  const ch = crop.h * sy
  return (
    <svg className="cell-crop-mask" width={w} height={h}>
      <path
        d={`M0 0H${w}V${h}H0Z M${left} ${top}H${left + cw}V${top + ch}H${left}Z`}
        fillRule="evenodd"
      />
    </svg>
  )
}

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
  const { rotations, crops } = useEdits()
  const pageKey = makePageKey(page.source.id, page.pageIndex)
  const rot = rotations.get(pageKey) ?? 0
  const rotated = rot === 90 || rot === 270
  const cellW = pageCellWidth(page, rotations)
  const crop = crops.get(pageKey)
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
          {crop && (
            <CropMask
              crop={crop}
              page={page}
              w={rotated ? pageHeight : cellW}
              h={rotated ? cellW : pageHeight}
            />
          )}
        </div>
      ) : (
        <>
          <PageView
            pdf={page.source.pdf}
            pageNumber={page.pageIndex + 1}
            naturalWidth={page.width}
            naturalHeight={page.height}
            version={renderVersion}
          />
          {crop && <CropMask crop={crop} page={page} w={cellW} h={pageHeight} />}
        </>
      )}
      <span className="page-number">{visibleNumber}</span>
    </div>
  )
}

export const PageCell = memo(PageCellImpl)
