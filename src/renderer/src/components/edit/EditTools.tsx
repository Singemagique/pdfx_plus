import { useEffect } from 'react'
import { useEdits, type ToolKind } from '../../edit/EditProvider'

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
