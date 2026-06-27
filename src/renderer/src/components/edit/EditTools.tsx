import { useEffect, useRef } from 'react'
import { useEdits, type ToolKind } from '../../edit/EditProvider'
import { newOverlayId, type RGB } from '../../edit/model'

const cssColor = (c: RGB): string =>
  `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`
const rgbEq = (a: RGB, b: RGB): boolean => a.r === b.r && a.g === b.g && a.b === b.b

function ToolIcon({ kind }: { kind: ToolKind }): React.JSX.Element {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  if (kind === 'browse')
    return (
      <svg {...common}>
        <path d="M5 3l6 17 2.5-6.5L20 11z" />
      </svg>
    )
  if (kind === 'highlight')
    return (
      <svg {...common}>
        <path d="M3 21h18" />
        <rect x="6" y="4" width="12" height="9" rx="2" />
      </svg>
    )
  return (
    <svg {...common}>
      <path d="M3 21l4-1 11-11a2.8 2.8 0 0 0-4-4L3 16z" />
      <path d="M13 5l4 4" />
    </svg>
  )
}

const TOOLS: { kind: ToolKind; label: string }[] = [
  { kind: 'browse', label: 'Browse' },
  { kind: 'highlight', label: 'Highlight' },
  { kind: 'ink', label: 'Draw' }
]

export function EditTools(): React.JSX.Element {
  const { tool, setTool, undo, redo, canUndo, canRedo } = useEdits()
  const { highlightPalette, highlightColor, setHighlightColor } = useEdits()
  const { overlays, addOverlay, addAttachment, currentPage, select } = useEdits()
  const fileRef = useRef<HTMLInputElement>(null)

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file || !currentPage) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    const mime = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    let natW = 1
    let natH = 1
    try {
      const bmp = await createImageBitmap(new Blob([bytes], { type: mime }))
      natW = bmp.width
      natH = bmp.height
      bmp.close()
    } catch {
      /* keep 1:1 fallback */
    }
    const targetW = Math.min(currentPage.width * 0.4, natW)
    const targetH = (targetW * natH) / natW
    const attachmentId = newOverlayId()
    addAttachment(attachmentId, bytes, mime)
    const id = newOverlayId()
    const z = overlays.filter((o) => o.pageKey === currentPage.pageKey).length
    addOverlay({
      id,
      pageKey: currentPage.pageKey,
      z,
      createdAt: Date.now(),
      geom: {
        x: (currentPage.width - targetW) / 2,
        y: (currentPage.height - targetH) / 2,
        w: targetW,
        h: targetH,
        rotation: 0,
        opacity: 1
      },
      type: 'image',
      attachmentId,
      mime
    })
    setTool('browse')
    select(id)
  }

  // Undo/redo keyboard shortcuts while the editor surface (full view) is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  return (
    <div className="edit-tools">
      {TOOLS.map((t) => (
        <button
          key={t.kind}
          className={`tool-btn${tool === t.kind ? ' active' : ''}`}
          onClick={() => setTool(t.kind)}
          title={t.label}
        >
          <ToolIcon kind={t.kind} />
          <span>{t.label}</span>
        </button>
      ))}
      <button
        className="tool-btn"
        onClick={() => fileRef.current?.click()}
        title="Place an image or signature (PNG / JPEG)"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="8.5" cy="9.5" r="1.5" />
          <path d="M21 16l-5-5-9 9" />
        </svg>
        <span>Image</span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg"
        style={{ display: 'none' }}
        onChange={(e) => void onFile(e)}
      />
      {tool === 'highlight' && (
        <span className="tool-swatches">
          {highlightPalette.map((c) => (
            <button
              key={c.name}
              className={`swatch${rgbEq(c.rgb, highlightColor) ? ' active' : ''}`}
              style={{ background: cssColor(c.rgb) }}
              onClick={() => setHighlightColor(c.rgb)}
              title={`Highlight ${c.name}`}
              aria-label={`Highlight ${c.name}`}
            />
          ))}
        </span>
      )}
      <span className="tool-sep" />
      <button
        className="tool-btn icon-only"
        onClick={undo}
        disabled={!canUndo}
        title="Undo (Ctrl/Cmd+Z)"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 14L4 9l5-5" />
          <path d="M4 9h11a5 5 0 0 1 0 10h-1" />
        </svg>
      </button>
      <button
        className="tool-btn icon-only"
        onClick={redo}
        disabled={!canRedo}
        title="Redo (Ctrl/Cmd+Shift+Z)"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M15 14l5-5-5-5" />
          <path d="M20 9H9a5 5 0 0 0 0 10h1" />
        </svg>
      </button>
    </div>
  )
}
