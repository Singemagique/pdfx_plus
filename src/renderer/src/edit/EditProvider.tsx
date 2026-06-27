// React binding for the edit model (model.ts) + undo/redo store (history.ts).
//
// The store is created once in App (useEditStore) and shared via context so the overlay
// layer and the tool palette can reach it without threading props through FullView's deep
// component chain. App also reads `editLayer` to bake overlays on export.

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { apply, canRedo, canUndo, initHistory, redo, undo, type History } from './history'
import { groupByPage, type Overlay, type RGB, type ShapeKind } from './model'
import type { Attachment } from '../pdfx/flatten'
import type { EditLayer } from '../pdfx/build'

export type ToolKind = 'browse' | 'highlight' | 'ink' | 'text' | 'shape'

/** The page currently focused in full view, so palette actions know where to place things. */
export interface CurrentPage {
  pageKey: string
  width: number
  height: number
}

export interface EditStore {
  overlays: Overlay[]
  tool: ToolKind
  setTool: (t: ToolKind) => void
  highlightColor: RGB
  highlightPalette: NamedColor[]
  setHighlightColor: (rgb: RGB) => void
  inkColor: RGB
  inkPalette: NamedColor[]
  setInkColor: (rgb: RGB) => void
  inkWidth: number
  inkWidths: number[]
  setInkWidth: (w: number) => void
  shapeKind: ShapeKind
  setShapeKind: (s: ShapeKind) => void
  shapeColor: RGB
  shapePalette: NamedColor[]
  setShapeColor: (rgb: RGB) => void
  shapeWidth: number
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
  addAttachment: (id: string, bytes: Uint8Array, mime: string) => void
  currentPage: CurrentPage | null
  setCurrentPage: (p: CurrentPage | null) => void
  rotations: Map<string, number>
  rotatePage: (pageKey: string, delta: number) => void
  savedSignature: Uint8Array | null
  setSavedSignature: (bytes: Uint8Array | null) => void
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
// Shared stroke palette for the pen (ink) and shapes; they just default differently.
const STROKE_PALETTE: NamedColor[] = [
  { name: 'Red', rgb: { r: 0.85, g: 0.15, b: 0.18 } },
  { name: 'Black', rgb: { r: 0.1, g: 0.1, b: 0.12 } },
  { name: 'Blue', rgb: { r: 0.13, g: 0.42, b: 0.9 } },
  { name: 'Green', rgb: { r: 0.13, g: 0.6, b: 0.25 } }
]
const STROKE_WIDTHS = [1.5, 3, 6]
const SHAPE_WIDTH = 2

export function useEditStore(): EditStore {
  const [history, setHistory] = useState<History<EditState>>(() => initHistory({ overlays: [] }))
  const [tool, setToolState] = useState<ToolKind>('browse')
  const [highlightColor, setHighlightColor] = useState<RGB>(HIGHLIGHT_PALETTE[0].rgb)
  const [inkColor, setInkColor] = useState<RGB>(STROKE_PALETTE[1].rgb) // black
  const [inkWidth, setInkWidth] = useState<number>(STROKE_WIDTHS[0])
  const [shapeKind, setShapeKind] = useState<ShapeKind>('rect')
  const [shapeColor, setShapeColor] = useState<RGB>(STROKE_PALETTE[0].rgb) // red
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Image/stamp bytes, embedded as PDF file streams on export and referenced by overlays.
  const [attachments, setAttachments] = useState<Map<string, Attachment>>(() => new Map())
  const [currentPage, setCurrentPage] = useState<CurrentPage | null>(null)

  const [rotations, setRotations] = useState<Map<string, number>>(() => new Map())
  const [savedSignature, setSavedSignature] = useState<Uint8Array | null>(null)

  const addAttachment = useCallback((id: string, bytes: Uint8Array, mime: string) => {
    setAttachments((m) => new Map(m).set(id, { bytes, mime }))
  }, [])

  const rotatePage = useCallback((pageKey: string, delta: number) => {
    setRotations((m) => {
      const next = ((((m.get(pageKey) ?? 0) + delta) % 360) + 360) % 360
      const n = new Map(m)
      if (next === 0) n.delete(pageKey)
      else n.set(pageKey, next)
      return n
    })
  }, [])

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
    () => ({ overlays: groupByPage(overlays), attachments, rotations }),
    [overlays, attachments, rotations]
  )

  return {
    overlays,
    tool,
    setTool,
    highlightColor,
    highlightPalette: HIGHLIGHT_PALETTE,
    setHighlightColor,
    inkColor,
    inkPalette: STROKE_PALETTE,
    setInkColor,
    inkWidth,
    inkWidths: STROKE_WIDTHS,
    setInkWidth,
    shapeKind,
    setShapeKind,
    shapeColor,
    shapePalette: STROKE_PALETTE,
    setShapeColor,
    shapeWidth: SHAPE_WIDTH,
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
    addAttachment,
    currentPage,
    setCurrentPage,
    rotations,
    rotatePage,
    savedSignature,
    setSavedSignature,
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
