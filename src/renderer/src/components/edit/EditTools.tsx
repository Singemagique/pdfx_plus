import { useEffect, useRef, useState } from 'react'
import { useEdits, type ToolKind } from '../../edit/EditProvider'
import { newOverlayId, type RGB, type ShapeKind } from '../../edit/model'
import { SignaturePad } from './SignaturePad'

const SHAPE_KINDS: { kind: ShapeKind; label: string; icon: React.JSX.Element }[] = [
  { kind: 'rect', label: 'Rectangle', icon: <rect x="3" y="5" width="18" height="14" rx="1" /> },
  { kind: 'ellipse', label: 'Ellipse', icon: <ellipse cx="12" cy="12" rx="9" ry="7" /> },
  { kind: 'line', label: 'Line', icon: <line x1="4" y1="20" x2="20" y2="4" /> },
  {
    kind: 'arrow',
    label: 'Arrow',
    icon: (
      <>
        <line x1="4" y1="20" x2="20" y2="4" />
        <path d="M20 4l-6 1M20 4l-1 6" />
      </>
    )
  },
  {
    kind: 'underline',
    label: 'Underline',
    icon: (
      <>
        <path d="M7 4v7a5 5 0 0 0 10 0V4" />
        <line x1="5" y1="20" x2="19" y2="20" />
      </>
    )
  },
  {
    kind: 'strike',
    label: 'Strikethrough',
    icon: (
      <>
        <path d="M7 7c.5-2 2.5-3 5-3s4.5 1 5 2M8 17c.5 2 2 3 4 3s5-1 5-3" />
        <line x1="4" y1="12" x2="20" y2="12" />
      </>
    )
  }
]

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
  if (kind === 'text')
    return (
      <svg {...common}>
        <path d="M5 6V5h14v1" />
        <path d="M12 5v14" />
        <path d="M9.5 19h5" />
      </svg>
    )
  if (kind === 'shape')
    return (
      <svg {...common}>
        <rect x="3" y="9" width="11" height="11" rx="1" />
        <circle cx="16" cy="8" r="5" />
      </svg>
    )
  if (kind === 'crop')
    return (
      <svg {...common}>
        <path d="M6 2v14a2 2 0 0 0 2 2h14" />
        <path d="M2 6h14a2 2 0 0 1 2 2v14" />
      </svg>
    )
  if (kind === 'form')
    return (
      <svg {...common}>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M8 8h8M8 12h8M8 16h4" />
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
  { kind: 'ink', label: 'Draw' },
  { kind: 'text', label: 'Text' },
  { kind: 'shape', label: 'Shape' },
  { kind: 'crop', label: 'Crop' },
  { kind: 'form', label: 'Form' }
]

export function EditTools(): React.JSX.Element {
  const { tool, setTool, undo, redo, canUndo, canRedo } = useEdits()
  const { highlightPalette, highlightColor, setHighlightColor } = useEdits()
  const { overlays, addOverlay, addAttachment, currentPage, select, rotatePage } = useEdits()
  const { crops, setCrop } = useEdits()
  const { shapeKind, setShapeKind, shapeColor, shapePalette, setShapeColor } = useEdits()
  const { inkColor, inkPalette, setInkColor, inkWidth, inkWidths, setInkWidth } = useEdits()
  const { savedSignature, setSavedSignature } = useEdits()
  const fileRef = useRef<HTMLInputElement>(null)
  const [padOpen, setPadOpen] = useState(false)

  const placeImage = async (
    bytes: Uint8Array,
    mime: 'image/png' | 'image/jpeg',
    widthFrac = 0.4
  ): Promise<void> => {
    if (!currentPage) return
    let natW = 1
    let natH = 1
    try {
      const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }))
      natW = bmp.width
      natH = bmp.height
      bmp.close()
    } catch {
      /* keep 1:1 fallback */
    }
    const targetW = Math.min(currentPage.width * widthFrac, natW)
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

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    await placeImage(bytes, file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png')
  }

  const onSign = (): void => {
    if (savedSignature) void placeImage(savedSignature, 'image/png', 0.3)
    else setPadOpen(true)
  }

  // Undo/redo keyboard shortcuts while the editor surface (full view) is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  return (
    <>
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
        <button
          className="tool-btn"
          onClick={onSign}
          title={savedSignature ? 'Stamp your saved signature' : 'Draw a signature'}
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
            <path d="M3 17c3 0 4-7 6-7s2 5 4 5 3-8 5-8" />
            <path d="M3 21h18" />
          </svg>
          <span>Sign</span>
        </button>
        {savedSignature && (
          <button
            className="tool-btn icon-only"
            onClick={() => setPadOpen(true)}
            title="Redraw signature"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
            </svg>
          </button>
        )}
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
        {tool === 'ink' && (
          <span className="tool-swatches">
            {inkPalette.map((c) => (
              <button
                key={c.name}
                className={`swatch${rgbEq(c.rgb, inkColor) ? ' active' : ''}`}
                style={{ background: cssColor(c.rgb) }}
                onClick={() => setInkColor(c.rgb)}
                title={c.name}
                aria-label={`Ink ${c.name}`}
              />
            ))}
            <span className="tool-sep" />
            {inkWidths.map((w, i) => (
              <button
                key={w}
                className={`shape-btn${inkWidth === w ? ' active' : ''}`}
                onClick={() => setInkWidth(w)}
                title={['Thin', 'Medium', 'Thick'][i] ?? `${w}px`}
                aria-label={`Width ${w}`}
              >
                <span className="width-dot" style={{ width: 5 + i * 4, height: 5 + i * 4 }} />
              </button>
            ))}
          </span>
        )}
        {tool === 'shape' && (
          <span className="tool-swatches">
            {SHAPE_KINDS.map((s) => (
              <button
                key={s.kind}
                className={`shape-btn${shapeKind === s.kind ? ' active' : ''}`}
                onClick={() => setShapeKind(s.kind)}
                title={s.label}
                aria-label={s.label}
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
                  {s.icon}
                </svg>
              </button>
            ))}
            <span className="tool-sep" />
            {shapePalette.map((c) => (
              <button
                key={c.name}
                className={`swatch${rgbEq(c.rgb, shapeColor) ? ' active' : ''}`}
                style={{ background: cssColor(c.rgb) }}
                onClick={() => setShapeColor(c.rgb)}
                title={c.name}
                aria-label={`Shape ${c.name}`}
              />
            ))}
          </span>
        )}
        {tool === 'crop' && (
          <span className="tool-swatches">
            <span className="tool-hint">Drag to crop</span>
            <button
              className="shape-btn"
              onClick={() => currentPage && setCrop(currentPage.pageKey, null)}
              disabled={!currentPage || !crops.get(currentPage.pageKey)}
              title="Remove crop from this page"
              aria-label="Reset crop"
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
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </span>
        )}
        <span className="tool-sep" />
        <button
          className="tool-btn icon-only"
          onClick={() => currentPage && rotatePage(currentPage.pageKey, -90)}
          disabled={!currentPage}
          title="Rotate page left"
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
            <path d="M3 9a9 9 0 1 0 3-5" />
            <path d="M3 3v5h5" />
          </svg>
        </button>
        <button
          className="tool-btn icon-only"
          onClick={() => currentPage && rotatePage(currentPage.pageKey, 90)}
          disabled={!currentPage}
          title="Rotate page right"
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
            <path d="M21 9a9 9 0 1 1-3-5" />
            <path d="M21 3v5h-5" />
          </svg>
        </button>
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
      {padOpen && (
        <SignaturePad
          onSave={(bytes) => {
            setSavedSignature(bytes)
            setPadOpen(false)
            void placeImage(bytes, 'image/png', 0.3)
          }}
          onClose={() => setPadOpen(false)}
        />
      )}
    </>
  )
}
