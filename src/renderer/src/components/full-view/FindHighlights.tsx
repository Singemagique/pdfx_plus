import { useLayoutEffect } from 'react'
import type { PageEntry } from '../../types'
import { usePageHighlights } from '../../search/FindContext'
import type { PageWindow } from '../../page-geometry'

interface FindHighlightsProps {
  page: PageEntry
  /** The upright FULL-page frame (`.page-frame`'s CSS size; larger than the window when cropped). */
  box: { w: number; h: number }
  /** The crop window actually shown, in page px (top-left origin); absent = the whole page. */
  window?: PageWindow
}

const intersects = (r: PageWindow, w: PageWindow): boolean =>
  r.x < w.x + w.w && r.x + r.w > w.x && r.y < w.y + w.h && r.y + r.h > w.y

/**
 * Find matches drawn over the full-view page. The layer sits inside `.page-frame` (inside
 * `.full-page`), so it inherits the box's rotate()/zoom transform just as the overlay layer does:
 * rects only need the fit scale. It stacks under the overlay layer, so a redaction box still covers
 * whatever it hides. Matches outside a crop window are not drawn (they would be clipped anyway, and
 * the find bar must not dodge a match nobody can see) but still count in the results: the text is
 * still in the exported PDF behind its CropBox.
 */
/** Fired on window after the highlights are (re)drawn, so the find bar can step off the match. */
export const FIND_HIGHLIGHTS_EVENT = 'pdfx:find-highlights'

export function FindHighlights({
  page,
  box,
  window: shown
}: FindHighlightsProps): React.JSX.Element | null {
  const all = usePageHighlights(page.id)
  // Every render: a new zoom or pan moves the rects as surely as new results do.
  useLayoutEffect(() => {
    window.dispatchEvent(new Event(FIND_HIGHLIGHTS_EVENT))
  })
  // And once gone (another page, the open/close animation), so the bar can move back.
  useLayoutEffect(() => () => void window.dispatchEvent(new Event(FIND_HIGHLIGHTS_EVENT)), [])
  const highlights = shown ? all.filter((h) => intersects(h.rect, shown)) : all
  if (highlights.length === 0) return null
  const s = box.w / page.width
  return (
    <div className="find-hl-layer" aria-hidden="true">
      {highlights.map((h, i) => (
        <div
          key={i}
          className={'find-hl' + (h.current ? ' current' : '')}
          style={{
            left: h.rect.x * s,
            top: h.rect.y * s,
            width: h.rect.w * s,
            height: h.rect.h * s
          }}
        />
      ))}
    </div>
  )
}
