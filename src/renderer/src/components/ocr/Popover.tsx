// A small anchored popover for the OCR surfaces (the job popover, the summary popover): fixed under
// its anchor (clamped to the window), the first control focused on open and focus back on the
// anchor on close, Esc or a click outside closes it. Keys stop here, so the canvas, full view and
// editor shortcuts on window (Delete removes a page, arrows flip pages) never fire from inside.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface PopoverProps {
  anchor: HTMLElement | null
  label: string
  onClose: () => void
  children: ReactNode
  className?: string
}

const MARGIN = 8

export function Popover({
  anchor,
  label,
  onClose,
  children,
  className
}: PopoverProps): React.JSX.Element {
  const box = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>(() => place(anchor, null))

  useLayoutEffect(() => {
    setPos(place(anchor, box.current))
  }, [anchor])

  useEffect(() => {
    ;(box.current?.querySelector<HTMLElement>('button, [href], input') ?? box.current)?.focus()
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node | null
      if (box.current?.contains(t) || anchor?.contains(t)) return
      onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      if (anchor?.isConnected) anchor.focus()
    }
  }, [anchor, onClose])

  return createPortal(
    <div
      ref={box}
      className={`ocr-popover${className ? ` ${className}` : ''}`}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
      }}
    >
      {children}
    </div>,
    document.body
  )
}

function place(anchor: HTMLElement | null, el: HTMLElement | null): { left: number; top: number } {
  const r = anchor?.getBoundingClientRect()
  const w = el?.offsetWidth ?? 320
  const h = el?.offsetHeight ?? 0
  const vw = window.innerWidth || 1024
  const vh = window.innerHeight || 768
  let left = r ? r.left : MARGIN
  let top = r ? r.bottom + 6 : 64
  left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN))
  if (h && top + h > vh - MARGIN) top = Math.max(MARGIN, (r ? r.top - 6 : vh) - h)
  return { left, top }
}
