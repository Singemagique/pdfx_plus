import type { PageEntry } from '../../types'
import { PageView } from '../PageView'
import { OverlayLayer } from '../edit/OverlayLayer'
import { FindHighlights } from './FindHighlights'
import { useEdits } from '../../edit/EditProvider'
import { frameOf, windowFractions } from '../../page-geometry'
import type { View } from './geometry'
import { DOUBLE_CLICK_ZOOM, TRANSITION_MS } from './geometry'
import { fullViewBox } from './page-display'

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
  const { rotations, crops, tool } = useEdits()

  // A page shows at its exported geometry: only its crop window, then its rotation. While the crop
  // tool is on, the current page shows whole instead, with the crop rectangle editable on top
  // (otherwise a crop could never be widened again) — but not during the open/close FLIP, which
  // animates to/from the collection cell's cropped aspect. FullView's fit agrees (currentFrameOf).
  const editingCrop = isCurrent && tool === 'crop' && !animating
  const frame = frameOf(p, { rotations, crops }, { ignoreCrop: editingCrop })
  const rot = frame.rotation
  // `.full-page` is the upright crop window; CSS-rotating it yields the displayed page that fits the
  // viewport, and it clips the full-page `.page-frame` positioned inside it (overlays, Find and the
  // pointer mapping all keep working in whole-page coordinates there).
  const { box, inner } = fullViewBox(frame, viewport)
  const fullFit = { w: inner.width, h: inner.height }
  const rotateT = rot ? ` rotate(${rot}deg)` : ''

  // The rotation the box's CSS transform actually carries right now: the open/close FLIP
  // transform has no rotate(), so PageView must plan its detail canvas unrotated then (and
  // re-plans, via this prop changing, once the rotated transform is back).
  const cssRotation = isCurrent && animating ? 0 : rot
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
        <div
          className="page-frame"
          style={{ left: inner.left, top: inner.top, width: inner.width, height: inner.height }}
        >
          <PageView
            pdf={p.source.pdf}
            pageNumber={p.pageIndex + 1}
            naturalWidth={p.width}
            naturalHeight={p.height}
            version={isCurrent ? renderVersion : 0}
            eager={isCurrent}
            rotation={cssRotation}
            clip={windowFractions(frame)}
          />
          {isCurrent && !animating && (
            <FindHighlights
              page={p}
              box={fullFit}
              window={frame.cropped ? frame.window : undefined}
            />
          )}
          {isCurrent && (
            <OverlayLayer page={p} fit={fullFit} rot={rot} active={interactive && !animating} />
          )}
        </div>
      </div>
    </div>
  )
}
