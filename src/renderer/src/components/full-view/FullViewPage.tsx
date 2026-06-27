import type { PageEntry } from '../../types'
import { PageView } from '../PageView'
import { OverlayLayer } from '../edit/OverlayLayer'
import { useEdits } from '../../edit/EditProvider'
import { makePageKey } from '../../edit/model'
import type { View } from './geometry'
import { DOUBLE_CLICK_ZOOM, fitInto, TRANSITION_MS } from './geometry'

interface FullViewPageProps {
  page: PageEntry
  viewport: { w: number; h: number }
  isCurrent: boolean
  view: View
  zoomed: boolean
  interactive: boolean
  animating: boolean
  flip: string | null
  flipTransition: boolean
  renderVersion: number
  resetView: () => void
  applyZoom: (nextZoom: (z: number) => number, focal?: { x: number; y: number }) => void
}

export function FullViewPage(props: FullViewPageProps): React.JSX.Element {
  const { page: p, viewport, isCurrent, view, zoomed, interactive, animating } = props
  const { flip, flipTransition, renderVersion, resetView, applyZoom } = props
  const { rotations } = useEdits()

  const rot = rotations.get(makePageKey(p.source.id, p.pageIndex)) ?? 0
  const rotated = rot === 90 || rot === 270
  // Box holds the upright canvas; CSS-rotating it yields the displayed (rotated) page that
  // fits the viewport. The box's aspect therefore matches the upright page.
  const dfit = fitInto(rotated ? p.height : p.width, rotated ? p.width : p.height, viewport)
  const box = rotated ? { w: dfit.h, h: dfit.w } : { w: dfit.w, h: dfit.h }
  const rotateT = rot ? ` rotate(${rot}deg)` : ''

  let style: React.CSSProperties = { width: box.w, height: box.h }
  if (isCurrent && animating) {
    style = {
      ...style,
      transform: flip ?? 'none',
      transformOrigin: 'top left',
      transition: flipTransition
        ? `transform ${TRANSITION_MS - 20}ms cubic-bezier(0.2, 0, 0, 1)`
        : 'none',
      willChange: 'transform'
    }
  } else if (isCurrent && zoomed) {
    style = {
      ...style,
      transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})${rotateT}`,
      transformOrigin: 'center center',
      willChange: 'transform'
    }
  } else if (rotateT) {
    style = { ...style, transform: rotateT.trim(), transformOrigin: 'center center' }
  }
  return (
    <div className="full-slide">
      <div
        className="full-page"
        style={style}
        onDoubleClick={
          isCurrent && interactive
            ? (e) =>
                zoomed
                  ? resetView()
                  : applyZoom(() => DOUBLE_CLICK_ZOOM, { x: e.clientX, y: e.clientY })
            : undefined
        }
      >
        <PageView
          pdf={p.source.pdf}
          pageNumber={p.pageIndex + 1}
          naturalWidth={p.width}
          naturalHeight={p.height}
          version={isCurrent ? renderVersion : 0}
          eager={isCurrent}
        />
        {isCurrent && (
          <OverlayLayer page={p} fit={box} rot={rot} active={interactive && !animating} />
        )}
      </div>
    </div>
  )
}
