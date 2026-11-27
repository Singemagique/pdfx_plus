import { memo } from 'react'
import { DocHeader } from '../DocHeader'
import type { DocPlacement } from '../../canvas/layout'

const HEADER_OFFSET_X = 16
const HEADER_OFFSET_Y = 10

interface HeaderLayerProps {
  items: DocPlacement[]
  /** Per-document vertical drag offset — the same numbers the cards below use (see drag-view). */
  shifts: number[]
  onMove: (docId: string, direction: -1 | 1) => void
  onRemove: (docId: string) => void
  onRename: (docId: string, name: string) => void
}

function HeaderLayerImpl({
  items,
  shifts,
  onMove,
  onRemove,
  onRename
}: HeaderLayerProps): React.JSX.Element {
  return (
    <>
      {items.map((item, index) => {
        const shift = shifts[index] ?? 0
        return (
          <div
            key={item.doc.id}
            className="overlay-header-slot"
            style={{
              left: item.x + HEADER_OFFSET_X,
              top: item.y + HEADER_OFFSET_Y,
              transform: shift ? `translateY(${shift}px)` : undefined
            }}
          >
            <DocHeader
              doc={item.doc}
              index={index}
              total={items.length}
              onMove={onMove}
              onRemove={onRemove}
              onRename={onRename}
            />
          </div>
        )
      })}
    </>
  )
}

export const HeaderLayer = memo(HeaderLayerImpl)
