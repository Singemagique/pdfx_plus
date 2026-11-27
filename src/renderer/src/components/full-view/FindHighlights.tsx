import type { PageEntry } from '../../types'
import { usePageHighlights } from '../../search/FindContext'

interface FindHighlightsProps {
  page: PageEntry
  /** The upright page box (`.full-page`'s CSS size). */
  box: { w: number; h: number }
}

/**
 * Find matches drawn over the full-view page. The layer sits inside `.full-page`, so it inherits the
 * box's rotate()/zoom transform just as the overlay layer does: rects only need the fit scale. It
 * stacks under the overlay layer, so a redaction box still covers whatever it hides.
 */
export function FindHighlights({ page, box }: FindHighlightsProps): React.JSX.Element | null {
  const highlights = usePageHighlights(page.id)
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
