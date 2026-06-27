import { useEffect, useRef, useState } from 'react'

const W = 600
const H = 200

interface SignaturePadProps {
  onSave: (bytes: Uint8Array) => void
  onClose: () => void
}

/** A small modal to draw a signature once; saved as a transparent PNG for re-stamping. */
export function SignaturePad({ onSave, onClose }: SignaturePadProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)
  const [empty, setEmpty] = useState(true)

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    ctx.lineWidth = 3.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#16161a'
  }, [])

  const pos = (e: React.PointerEvent): { x: number; y: number } => {
    const c = canvasRef.current!
    const r = c.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }
  }

  const down = (e: React.PointerEvent): void => {
    drawing.current = true
    last.current = pos(e)
    canvasRef.current?.setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent): void => {
    if (!drawing.current) return
    const ctx = canvasRef.current!.getContext('2d')!
    const p = pos(e)
    ctx.beginPath()
    ctx.moveTo(last.current!.x, last.current!.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    last.current = p
    setEmpty(false)
  }
  const up = (): void => {
    drawing.current = false
    last.current = null
  }

  const clear = (): void => {
    canvasRef.current?.getContext('2d')?.clearRect(0, 0, W, H)
    setEmpty(true)
  }

  const save = (): void => {
    canvasRef.current?.toBlob((blob) => {
      if (!blob) return
      blob.arrayBuffer().then((buf) => onSave(new Uint8Array(buf)))
    }, 'image/png')
  }

  return (
    <div className="sig-backdrop" onPointerDown={onClose}>
      <div className="sig-modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="sig-title">Draw your signature</div>
        <canvas
          ref={canvasRef}
          className="sig-canvas"
          width={W}
          height={H}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
        <div className="sig-actions">
          <button className="btn ghost" onClick={clear}>
            Clear
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={empty}>
            Use signature
          </button>
        </div>
      </div>
    </div>
  )
}
