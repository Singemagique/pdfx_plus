// React binding for the edit model (model.ts) + undo/redo store (history.ts).
//
// The store is created once in App (useEditStore) and shared via context so the overlay
// layer and the tool palette can reach it without threading props through FullView's deep
// component chain. App also reads `editLayer` to bake overlays on export.

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { apply, canRedo, canUndo, initHistory, redo, undo, type History } from './history'
import { groupByPage, type Overlay, type RGB } from './model'
import type { Attachment } from '../pdfx/flatten'
import type { EditLayer } from '../pdfx/build'

export type ToolKind = 'browse' | 'highlight' | 'ink'

export interface EditStore {
  overlays: Overlay[]
  tool: ToolKind
  setTool: (t: ToolKind) => void
  highlightColor: RGB
  highlightPalette: NamedColor[]
  setHighlightColor: (rgb: RGB) => void
  inkColor: RGB
  inkWidth: number
  selectedId: string | null
  select: (id: string | null) => void
  addOverlay: (o: Overlay) => void
  replaceOverlay: (next: Overlay) => void
  removeOverlay: (id: string) => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  attachments: Map<string, Attachment>
  /** Overlays + attachments shaped for the flatten-on-export pipeline. */
  editLayer: EditLayer
}

interface EditState {
  overlays: Overlay[]
}

export interface NamedColor {
  name: string
  rgb: RGB
}

const HIGHLIGHT_PALETTE: NamedColor[] = [
  { name: 'Yellow', rgb: { r: 1, g: 0.9, b: 0.2 } },
  { name: 'Green', rgb: { r: 0.5, g: 0.92, b: 0.45 } },
  { name: 'Pink', rgb: { r: 1, g: 0.58, b: 0.8 } }
]
const INK_COLOR: RGB = { r: 0.1, g: 0.1, b: 0.12 }
const INK_WIDTH = 2

export function useEditStore(): EditStore {
  const [history, setHistory] = useState<History<EditState>>(() => initHistory({ overlays: [] }))
  const [tool, setToolState] = useState<ToolKind>('browse')
  const [highlightColor, setHighlightColor] = useState<RGB>(HIGHLIGHT_PALETTE[0].rgb)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Image overlays will register bytes here once the PNG-stamp tool lands; empty for now.
  const [attachments] = useState<Map<string, Attachment>>(() => new Map())

  const overlays = history.present.overlays

  // Selection is only meaningful in Browse; switching to a drawing tool clears it.
  const setTool = useCallback((t: ToolKind) => {
    setToolState(t)
    if (t !== 'browse') setSelectedId(null)
  }, [])

  const addOverlay = useCallback((o: Overlay) => {
    setHistory((h) =>
      apply(h, (d) => {
        d.overlays.push(o)
      })
    )
  }, [])

  const replaceOverlay = useCallback((next: Overlay) => {
    setHistory((h) =>
      apply(h, (d) => {
        const i = d.overlays.findIndex((o) => o.id === next.id)
        if (i >= 0) d.overlays[i] = next
      })
    )
  }, [])

  const removeOverlay = useCallback((id: string) => {
    setHistory((h) =>
      apply(h, (d) => {
        const i = d.overlays.findIndex((o) => o.id === id)
        if (i >= 0) d.overlays.splice(i, 1)
      })
    )
    setSelectedId((cur) => (cur === id ? null : cur))
  }, [])

  const doUndo = useCallback(() => setHistory((h) => undo(h)), [])
  const doRedo = useCallback(() => setHistory((h) => redo(h)), [])

  const editLayer = useMemo<EditLayer>(
    () => ({ overlays: groupByPage(overlays), attachments }),
    [overlays, attachments]
  )

  return {
    overlays,
    tool,
    setTool,
    highlightColor,
    highlightPalette: HIGHLIGHT_PALETTE,
    setHighlightColor,
    inkColor: INK_COLOR,
    inkWidth: INK_WIDTH,
    selectedId,
    select: setSelectedId,
    addOverlay,
    replaceOverlay,
    removeOverlay,
    undo: doUndo,
    redo: doRedo,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    attachments,
    editLayer
  }
}

const EditContext = createContext<EditStore | null>(null)

export function EditProvider({
  store,
  children
}: {
  store: EditStore
  children: React.ReactNode
}): React.JSX.Element {
  return <EditContext.Provider value={store}>{children}</EditContext.Provider>
}

export function useEdits(): EditStore {
  const ctx = useContext(EditContext)
  if (!ctx) throw new Error('useEdits must be used within an EditProvider')
  return ctx
}
