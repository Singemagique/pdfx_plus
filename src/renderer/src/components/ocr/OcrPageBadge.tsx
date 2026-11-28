// The page-cell badge (DESIGN.md §3.8 "Page cell badge"): a "T with scan lines" glyph on scanned
// pages whose text is not recognised, a progress ring while the page is queued or running, nothing
// once it is done, or a dot for Low confidence. It reads its own page through the store, so a
// notification re-renders only the cells whose state changed; with no scans nothing is drawn.

import { memo } from 'react'
import { useOcrPageState, useOcrStore } from '../../ocr/OcrContext'

export const BADGE_COPY = {
  label: 'Scanned page – text not recognized',
  tooltip: 'Scanned page — its text isn’t searchable yet',
  running: 'Recognizing text',
  queued: 'Waiting to recognize text',
  held: 'Text recognition paused',
  low: 'Text recognized with low confidence'
} as const

/** "T with scan lines". */
export function ScanTextGlyph({ size = 12 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3 3h7M6.5 3v8" />
      <path d="M10 8h3.5M10 11h3.5M2.5 14h11" opacity="0.7" />
    </svg>
  )
}

function Ring({ running }: { running: boolean }): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="ocr-ring">
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeWidth="2"
      />
      {running && (
        <circle
          className="ocr-ring-arc"
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="12 26"
        />
      )}
    </svg>
  )
}

function OcrPageBadgeImpl({ pageKey }: { pageKey: string }): React.JSX.Element | null {
  const { store } = useOcrStore()
  const s = useOcrPageState(pageKey)
  if (!store || !s) return null
  if (s.status === 'queued' || s.status === 'running' || s.status === 'held') {
    const label =
      s.status === 'running'
        ? BADGE_COPY.running
        : s.status === 'held'
          ? BADGE_COPY.held
          : BADGE_COPY.queued
    return (
      <span className="ocr-badge" role="img" aria-label={label} title={label}>
        <Ring running={s.status === 'running'} />
      </span>
    )
  }
  if (s.hasText) {
    if (s.status !== 'low-confidence') return null
    return (
      <span
        className="ocr-badge dot"
        role="img"
        aria-label={BADGE_COPY.low}
        title={BADGE_COPY.low}
      />
    )
  }
  // Remove Recognized Text chose no text for it: the user's call, not a prompt to recognise.
  if (!s.scan || s.removed) return null
  return (
    <span className="ocr-badge" role="img" aria-label={BADGE_COPY.label} title={BADGE_COPY.tooltip}>
      <ScanTextGlyph />
    </span>
  )
}

export const OcrPageBadge = memo(OcrPageBadgeImpl)
