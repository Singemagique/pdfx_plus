import {
  ADD_PAGE_WIDTH,
  BASE_PAGE_HEIGHT,
  GHOST_ROW_HEIGHT,
  SINGLE_ROW_DOC_HEIGHT
} from '../canvas/layout'
import { DashedBorder } from './dashed-border'
import { PlusIcon } from './icons'

export interface GhostSize {
  width: number
  height: number
}

/** Card-relative position; omitted for a ghost that sits in a flex row (the between-docs ghost). */
interface CellPosition {
  x?: number
  y?: number
}

const positioned = ({ x, y }: CellPosition): React.CSSProperties =>
  x === undefined || y === undefined ? {} : { position: 'absolute', left: x, top: y }

interface GhostPageProps extends GhostSize, CellPosition {
  grow?: boolean
}

export function GhostPage({ x, y, width, height, grow }: GhostPageProps): React.JSX.Element {
  return (
    <div
      className={'page ghost' + (grow ? ' grow' : '')}
      style={{ ...positioned({ x, y }), width, height }}
      aria-hidden="true"
    />
  )
}

/** Below this width the add-page cell (narrowed to fit a nearly full last row) shows only its +. */
const ADD_LABEL_MIN_WIDTH = 96

interface AddPageGhostProps extends GhostSize, CellPosition {
  /** The round button on the card's right edge, for a last row with no room for a cell. */
  edge?: boolean
  onClick: () => void
}

export function AddPageGhost({
  x,
  y,
  width,
  height,
  edge,
  onClick
}: AddPageGhostProps): React.JSX.Element {
  const shape = edge ? ' edge' : width < ADD_LABEL_MIN_WIDTH ? ' narrow' : ''
  return (
    <button
      type="button"
      className={'page add-ghost add-page' + shape}
      style={{ ...positioned({ x, y }), width, height }}
      title="Add page"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      <DashedBorder
        width={width}
        height={height}
        radius={edge ? Math.min(width, height) / 2 : 9}
        dash={edge ? '4 4' : '5 7'}
      />
      <PlusIcon size={edge ? 16 : 24} />
      <span className="add-label">Add page</span>
    </button>
  )
}

interface AddDocGhostProps {
  width: number
  onClick: () => void
}

export function AddDocGhost({ width, onClick }: AddDocGhostProps): React.JSX.Element {
  const height = SINGLE_ROW_DOC_HEIGHT
  return (
    <button
      type="button"
      className="add-doc-row"
      style={{ width, height }}
      title="Add document"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      <DashedBorder width={width} height={height} radius={23} />
      <span
        className="add-ghost add-doc-page"
        style={{ width: ADD_PAGE_WIDTH, height: BASE_PAGE_HEIGHT }}
      >
        <DashedBorder width={ADD_PAGE_WIDTH} height={BASE_PAGE_HEIGHT} radius={9} dash="5 7" />
        <PlusIcon size={24} />
        <span className="add-label">Add document</span>
      </span>
    </button>
  )
}

interface GhostRowProps {
  width: number
  pageHeight: number
  pages: GhostSize[]
}

export function GhostRow({ width, pageHeight, pages }: GhostRowProps): React.JSX.Element {
  return (
    <div className="doc-row ghost" style={{ width, height: GHOST_ROW_HEIGHT }} aria-hidden="true">
      <div className="ghost-strip" style={{ height: pageHeight, alignItems: 'center' }}>
        {pages.map((p, i) => (
          // A page whose cell is shorter than the row (a very wide crop) keeps its own height.
          <GhostPage key={i} width={p.width} height={Math.min(pageHeight, p.height)} />
        ))}
      </div>
    </div>
  )
}
