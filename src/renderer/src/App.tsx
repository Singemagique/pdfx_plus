import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getDocument } from 'pdfjs-dist'
import { zipSync } from 'fflate'
import { buildPdf, buildPdfx, partitionPages, readManifest, stripExtension } from './pdfx/format'
import { imageToPdf, isImageBytes, isImageFile, stripImageExtension } from './pdfx/images'
import type { DocEntry, PageEntry, PdfSource } from './types'
import { Toolbar } from './components/Toolbar'
import { DocumentRow } from './components/DocumentRow'
import { EmptyState } from './components/EmptyState'
import { FullView } from './components/FullView'
import { Canvas, type CanvasHandle } from './components/Canvas'
import { BASE_PAGE_HEIGHT, computeLayout } from './canvas/layout'

interface IncomingFile {
  name: string
  data: Uint8Array
}

interface PageRef {
  docId: string
  pageId: string
}

const toExportPage = (
  page: PageEntry
): { sourceKey: string; bytes: Uint8Array; pageIndex: number } => ({
  sourceKey: page.source.id,
  bytes: page.source.bytes,
  pageIndex: page.pageIndex
})

// Load PDF bytes into a shared source. Sources stay alive for the session,
// since page references (including the clipboard) may outlive their row.
async function loadSource(
  bytes: Uint8Array
): Promise<{ source: PdfSource; sizes: { width: number; height: number }[] }> {
  // pdf.js transfers the buffer to its worker, so hand it a copy.
  const pdf = await getDocument({ data: bytes.slice() }).promise
  const source: PdfSource = { id: crypto.randomUUID(), bytes, pdf }
  const sizes: { width: number; height: number }[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const viewport = page.getViewport({ scale: 1 })
    sizes.push({ width: viewport.width, height: viewport.height })
  }
  return { source, sizes }
}

function pagesFromSource(
  source: PdfSource,
  sizes: { width: number; height: number }[],
  indices: number[]
): PageEntry[] {
  return indices.map((pageIndex) => ({
    id: crypto.randomUUID(),
    source,
    pageIndex,
    width: sizes[pageIndex].width,
    height: sizes[pageIndex].height
  }))
}

// Import a .pdf/.pdfx into document entries.
async function importIntoDocs(filename: string, bytes: Uint8Array): Promise<DocEntry[]> {
  const { source, sizes } = await loadSource(bytes)
  const manifest = await readManifest(source.pdf)
  return partitionPages(manifest, source.pdf.numPages, stripExtension(filename)).map((part) => ({
    id: crypto.randomUUID(),
    name: part.name,
    pages: pagesFromSource(source, sizes, part.indices)
  }))
}

export default function App(): React.JSX.Element {
  const [docs, setDocs] = useState<DocEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [scale, setScale] = useState(1)
  // Bumped when the view settles (zoom/pan stops) so visible pages re-render crisp.
  const [renderVersion, setRenderVersion] = useState(0)
  const [selected, setSelected] = useState<PageRef | null>(null)
  const [fullView, setFullView] = useState<PageRef | null>(null)
  const [draggingPage, setDraggingPage] = useState<PageRef | null>(null)
  // Insertion gap shown while a page from another document hovers a row.
  const [dropHint, setDropHint] = useState<{ docId: string; index: number } | null>(null)
  const clipboardRef = useRef<PageEntry | null>(null)
  const dragDepth = useRef(0)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const canvasRef = useRef<CanvasHandle>(null)
  // Mirror of fullView so the stable menu-zoom handler can tell when a full
  // view is open (it then handles zoom itself instead of the canvas).
  const fullViewRef = useRef<PageRef | null>(null)
  fullViewRef.current = fullView

  const flash = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast(message)
    toastTimer.current = setTimeout(() => setToast(null), 4000)
  }, [])

  // Live scale drives the toolbar %.
  const onScaleChange = useCallback((next: number) => setScale(next), [])
  // The view settled (zoom/pan stopped) — refresh crisp page rendering.
  const onSettle = useCallback(() => setRenderVersion((v) => v + 1), [])

  // Native menu accelerators (Cmd/Ctrl +, -, 0) drive the canvas zoom — unless a
  // full view is open, which subscribes to the same channel and zooms itself.
  useEffect(() => {
    return window.api.onZoom((action) => {
      if (fullViewRef.current) return
      if (action === 'in') canvasRef.current?.zoomIn()
      else if (action === 'out') canvasRef.current?.zoomOut()
      else canvasRef.current?.reset()
    })
  }, [])

  const addFiles = useCallback(
    async (files: IncomingFile[]) => {
      if (files.length === 0) return
      setBusy(true)
      const failed: string[] = []
      for (const file of files) {
        try {
          // Images become single-page documents at their natural dimensions.
          const isImage = isImageFile(file.name) || isImageBytes(file.data)
          const name = isImage ? stripImageExtension(file.name) : file.name
          const data = isImage ? await imageToPdf(file.data) : file.data
          const entries = await importIntoDocs(name, data)
          setDocs((prev) => [...prev, ...entries])
        } catch (error) {
          console.error(`Failed to import ${file.name}`, error)
          failed.push(file.name)
        }
      }
      setBusy(false)
      if (failed.length > 0) flash(`Could not open ${failed.join(', ')}`)
    },
    [flash]
  )

  // Files opened via Finder / Explorer file association
  useEffect(() => {
    const unsubscribe = window.api.onFilesOpened((files) => void addFiles(files))
    void window.api.rendererReady()
    return unsubscribe
  }, [addFiles])

  const openViaDialog = useCallback(async () => {
    const files = await window.api.openFiles()
    await addFiles(files)
  }, [addFiles])

  // "Single PDF" is the same container as .pdfx (manifest included, so it
  // re-imports as separate documents) — only the extension differs.
  const exportCollection = useCallback(
    async (kind: 'pdfx' | 'pdf') => {
      if (docs.length === 0) {
        flash('Nothing to export')
        return
      }
      const filter =
        kind === 'pdfx'
          ? { name: 'PDFX', extensions: ['pdfx'] }
          : { name: 'PDF', extensions: ['pdf'] }
      const path = await window.api.chooseSavePath(`untitled.${kind}`, filter)
      if (!path) return
      setBusy(true)
      try {
        const filename = path.split(/[\\/]/).pop() ?? `untitled.${kind}`
        const bytes = await buildPdfx(
          docs.map((doc) => ({ name: doc.name, pages: doc.pages.map(toExportPage) })),
          stripExtension(filename).replace(/\.pdf$/i, '')
        )
        const saved = await window.api.writeFile(path, bytes)
        flash(`Saved ${saved}`)
      } catch (error) {
        console.error('Export failed', error)
        flash('Export failed')
      } finally {
        setBusy(false)
      }
    },
    [docs, flash]
  )

  // One plain .pdf per document, zipped, numbered to preserve order.
  const exportZip = useCallback(async () => {
    if (docs.length === 0) {
      flash('Nothing to export')
      return
    }
    const path = await window.api.chooseSavePath('untitled.zip', {
      name: 'ZIP',
      extensions: ['zip']
    })
    if (!path) return
    setBusy(true)
    try {
      const entries: Record<string, Uint8Array> = {}
      for (const [index, doc] of docs.entries()) {
        const safeName = doc.name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Untitled'
        const prefix = String(index + 1).padStart(2, '0')
        entries[`${prefix} - ${safeName}.pdf`] = await buildPdf(doc.pages.map(toExportPage))
      }
      const saved = await window.api.writeFile(path, zipSync(entries))
      flash(`Saved ${saved}`)
    } catch (error) {
      console.error('Export failed', error)
      flash('Export failed')
    } finally {
      setBusy(false)
    }
  }, [docs, flash])

  const removeDoc = useCallback((id: string) => {
    setDocs((prev) => prev.filter((d) => d.id !== id))
    setSelected((sel) => (sel?.docId === id ? null : sel))
  }, [])

  const moveDoc = useCallback((id: string, direction: -1 | 1) => {
    setDocs((prev) => {
      const index = prev.findIndex((d) => d.id === id)
      const target = index + direction
      if (index === -1 || target < 0 || target >= prev.length) return prev
      const next = [...prev]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }, [])

  // ---------- Page operations ----------

  const deletePage = useCallback(
    (target: PageRef) => {
      const doc = docs.find((d) => d.id === target.docId)
      const index = doc?.pages.findIndex((p) => p.id === target.pageId) ?? -1
      if (!doc || index === -1) return
      const pages = doc.pages.filter((p) => p.id !== target.pageId)
      const neighbor = pages[Math.min(index, pages.length - 1)]
      setDocs((prev) =>
        prev.map((d) => (d.id === doc.id ? { ...d, pages } : d)).filter((d) => d.pages.length > 0)
      )
      setSelected(neighbor ? { docId: doc.id, pageId: neighbor.id } : null)
    },
    [docs]
  )

  const copySelected = useCallback(() => {
    if (!selected) return
    const page = docs
      .find((d) => d.id === selected.docId)
      ?.pages.find((p) => p.id === selected.pageId)
    if (!page) return
    clipboardRef.current = page
    // Claim the clipboard so a stale system image doesn't shadow this copy on ⌘V.
    void window.api.clearClipboard()
    flash('Page copied — ⌘V pastes it after the selected page')
  }, [docs, selected, flash])

  const pasteAfterSelected = useCallback(() => {
    const clip = clipboardRef.current
    if (!clip || !selected) return
    const pasted: PageEntry = { ...clip, id: crypto.randomUUID() }
    setDocs((prev) =>
      prev.map((doc) => {
        if (doc.id !== selected.docId) return doc
        const index = doc.pages.findIndex((p) => p.id === selected.pageId)
        if (index === -1) return doc
        const pages = [...doc.pages]
        pages.splice(index + 1, 0, pasted)
        return { ...doc, pages }
      })
    )
    setSelected({ docId: selected.docId, pageId: pasted.id })
  }, [selected])

  // The selected page, if any — pastes insert right after it.
  const selectedTarget = useCallback((): { doc: DocEntry; index: number } | null => {
    if (!selected) return null
    const doc = docs.find((d) => d.id === selected.docId)
    const index = doc?.pages.findIndex((p) => p.id === selected.pageId) ?? -1
    return doc && index !== -1 ? { doc, index } : null
  }, [docs, selected])

  const insertPagesAfter = useCallback(
    (target: { doc: DocEntry; index: number }, entries: PageEntry[]) => {
      if (entries.length === 0) return
      setDocs((prev) =>
        prev.map((d) =>
          d.id === target.doc.id
            ? {
                ...d,
                pages: [
                  ...d.pages.slice(0, target.index + 1),
                  ...entries,
                  ...d.pages.slice(target.index + 1)
                ]
              }
            : d
        )
      )
      setSelected({ docId: target.doc.id, pageId: entries[entries.length - 1].id })
    },
    []
  )

  // Paste files copied in Finder/Explorer. With a page selected, their pages
  // are inserted right after it (images sized like the selected page);
  // without a selection they import as new documents, same as dropping.
  const pasteFiles = useCallback(
    async (files: IncomingFile[]) => {
      const target = selectedTarget()
      if (!target) {
        await addFiles(files)
        return
      }
      setBusy(true)
      try {
        const reference = target.doc.pages[target.index]
        const entries: PageEntry[] = []
        for (const file of files) {
          const isImage = isImageFile(file.name) || isImageBytes(file.data)
          const bytes = isImage
            ? await imageToPdf(file.data, { width: reference.width, height: reference.height })
            : file.data
          const { source, sizes } = await loadSource(bytes)
          entries.push(
            ...pagesFromSource(
              source,
              sizes,
              sizes.map((_, i) => i)
            )
          )
        }
        insertPagesAfter(target, entries)
      } catch (error) {
        console.error('Paste failed', error)
        flash('Could not paste')
      } finally {
        setBusy(false)
      }
    },
    [selectedTarget, addFiles, insertPagesAfter, flash]
  )

  // Paste raw image data (screenshots, copied images). With a page selected,
  // the image becomes a new page right after it, sized like that page (image
  // fit inside, centered) for consistency. Otherwise it becomes a new document.
  const pasteImage = useCallback(
    async (png: Uint8Array) => {
      try {
        const target = selectedTarget()
        if (target) {
          const reference = target.doc.pages[target.index]
          const bytes = await imageToPdf(png, { width: reference.width, height: reference.height })
          const { source, sizes } = await loadSource(bytes)
          insertPagesAfter(target, pagesFromSource(source, sizes, [0]))
        } else {
          const entries = await importIntoDocs('Pasted image', await imageToPdf(png))
          setDocs((prev) => [...prev, ...entries])
        }
      } catch (error) {
        console.error('Image paste failed', error)
        flash('Could not paste image')
      }
    },
    [selectedTarget, insertPagesAfter, flash]
  )

  const handlePaste = useCallback(async () => {
    // Order matters: a file copied in Finder/Explorer also puts a preview
    // icon on the clipboard — readImage() alone would paste that icon.
    const files = await window.api.readClipboardFiles()
    if (files.length > 0) {
      await pasteFiles(files)
      return
    }
    const png = await window.api.readClipboardImage()
    if (png && png.length > 0) {
      await pasteImage(png)
      return
    }
    pasteAfterSelected()
  }, [pasteFiles, pasteImage, pasteAfterSelected])

  // Live reorder while dragging within a document: place the dragged page at
  // `insertAt` (an index among the other pages). No-ops return `prev` so the
  // 60Hz dragover stream causes zero re-renders while the order is stable.
  const movePageToIndex = useCallback((docId: string, dragId: string, insertAt: number) => {
    setDocs((prev) => {
      const docIndex = prev.findIndex((d) => d.id === docId)
      if (docIndex === -1) return prev
      const doc = prev[docIndex]
      const from = doc.pages.findIndex((p) => p.id === dragId)
      if (from === -1) return prev
      const without = doc.pages.filter((p) => p.id !== dragId)
      const clamped = Math.max(0, Math.min(without.length, insertAt))
      const pages = [...without.slice(0, clamped), doc.pages[from], ...without.slice(clamped)]
      if (pages.every((p, i) => p === doc.pages[i])) return prev
      const next = [...prev]
      next[docIndex] = { ...doc, pages }
      return next
    })
  }, [])

  // Move a page into another document (cross-document drop). Committed on
  // drop, not live: live-moving would unmount the drag-source element, which
  // breaks Chromium's dragend event and strands the drag state.
  const movePageAcross = useCallback((source: PageRef, targetDocId: string, insertAt: number) => {
    if (source.docId === targetDocId) return
    setDocs((prev) => {
      const page = prev
        .find((d) => d.id === source.docId)
        ?.pages.find((p) => p.id === source.pageId)
      if (!page) return prev
      return prev
        .map((d) => {
          if (d.id === source.docId) {
            return { ...d, pages: d.pages.filter((p) => p.id !== source.pageId) }
          }
          if (d.id === targetDocId) {
            const clamped = Math.max(0, Math.min(d.pages.length, insertAt))
            return { ...d, pages: [...d.pages.slice(0, clamped), page, ...d.pages.slice(clamped)] }
          }
          return d
        })
        .filter((d) => d.pages.length > 0)
    })
    setSelected({ docId: targetDocId, pageId: source.pageId })
  }, [])

  const updateDropHint = useCallback((docId: string, index: number | null) => {
    setDropHint((prev) => {
      if (index === null) return prev?.docId === docId ? null : prev
      if (prev && prev.docId === docId && prev.index === index) return prev
      return { docId, index }
    })
  }, [])

  const endPageDrag = useCallback(() => {
    setDraggingPage(null)
    setDropHint(null)
  }, [])

  // ---------- Keyboard ----------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (fullView) return // FullView handles its own keys
      const mod = event.metaKey || event.ctrlKey
      if ((event.key === 'Backspace' || event.key === 'Delete') && selected) {
        event.preventDefault()
        deletePage(selected)
      } else if (mod && event.key.toLowerCase() === 'c' && selected) {
        copySelected()
      } else if (mod && event.key.toLowerCase() === 'v') {
        void handlePaste()
      } else if (event.key === 'Escape') {
        setSelected(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fullView, selected, deletePage, copySelected, handlePaste])

  // File menu actions
  useEffect(() => {
    return window.api.onMenu((action) => {
      if (action === 'open') void openViaDialog()
      else if (action === 'export-pdfx') void exportCollection('pdfx')
      else if (action === 'export-pdf') void exportCollection('pdf')
      else if (action === 'export-zip') void exportZip()
    })
  }, [openViaDialog, exportCollection, exportZip])

  // ---------- File drag & drop (internal page drags are filtered out) ----------

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      if (!event.dataTransfer.types.includes('Files')) return
      const dropped = Array.from(event.dataTransfer.files).filter(
        (f) => /\.(pdf|pdfx)$/i.test(f.name) || isImageFile(f.name) || f.type.startsWith('image/')
      )
      const files = await Promise.all(
        dropped.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))
      )
      await addFiles(files)
    },
    [addFiles]
  )

  const totalPages = docs.reduce((sum, d) => sum + d.pages.length, 0)
  const layout = useMemo(() => computeLayout(docs), [docs])
  const fullViewDoc = fullView ? docs.find((d) => d.id === fullView.docId) : undefined
  const draggedEntry = draggingPage
    ? docs.find((d) => d.id === draggingPage.docId)?.pages.find((p) => p.id === draggingPage.pageId)
    : undefined
  const dropHintWidth = draggedEntry
    ? Math.max(6, Math.round((BASE_PAGE_HEIGHT * draggedEntry.width) / draggedEntry.height))
    : 0

  // Memoized so live zoom-scale updates (toolbar %) don't re-render every page.
  const docNodes = useMemo(
    () =>
      layout.items.map((item, index) => {
        const doc = item.doc
        return (
          <div
            key={doc.id}
            className="canvas-doc"
            style={{ left: item.x, top: item.y, width: item.width }}
          >
            <DocumentRow
              doc={doc}
              index={index}
              total={layout.items.length}
              pageHeight={BASE_PAGE_HEIGHT}
              renderVersion={renderVersion}
              selectedPageId={selected?.docId === doc.id ? selected.pageId : null}
              draggingPageId={draggingPage?.docId === doc.id ? draggingPage.pageId : null}
              foreignDragActive={draggingPage !== null && draggingPage.docId !== doc.id}
              dropHintIndex={dropHint?.docId === doc.id ? dropHint.index : null}
              dropHintWidth={dropHintWidth}
              onRemove={() => removeDoc(doc.id)}
              onMove={(direction) => moveDoc(doc.id, direction)}
              onSelectPage={(pageId) => setSelected({ docId: doc.id, pageId })}
              onOpenPage={(pageId) => setFullView({ docId: doc.id, pageId })}
              onPageDragStart={(pageId) => setDraggingPage({ docId: doc.id, pageId })}
              onPageDragEnd={endPageDrag}
              onPageDragTo={(insertAt) => {
                if (draggingPage?.docId === doc.id) {
                  movePageToIndex(doc.id, draggingPage.pageId, insertAt)
                }
              }}
              onForeignDragOver={(insertAt) => updateDropHint(doc.id, insertAt)}
              onForeignDrop={(insertAt) => {
                if (draggingPage) {
                  movePageAcross(draggingPage, doc.id, insertAt)
                  endPageDrag()
                }
              }}
            />
          </div>
        )
      }),
    [
      layout,
      renderVersion,
      selected,
      draggingPage,
      dropHint,
      dropHintWidth,
      removeDoc,
      moveDoc,
      endPageDrag,
      movePageToIndex,
      updateDropHint,
      movePageAcross
    ]
  )

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={(e) => {
        e.preventDefault()
        if (!e.dataTransfer.types.includes('Files')) return
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <Toolbar
        documentCount={docs.length}
        pageCount={totalPages}
        busy={busy}
        zoom={scale}
        onZoomIn={() => canvasRef.current?.zoomIn()}
        onZoomOut={() => canvasRef.current?.zoomOut()}
        onZoomReset={() => canvasRef.current?.reset()}
        onOpen={openViaDialog}
        onExport={() => exportCollection('pdfx')}
      />

      {docs.length === 0 ? (
        <EmptyState busy={busy} onOpen={openViaDialog} />
      ) : (
        <Canvas
          ref={canvasRef}
          contentWidth={layout.contentWidth}
          contentHeight={layout.contentHeight}
          slotHeight={layout.slotHeight}
          onScaleChange={onScaleChange}
          onSettle={onSettle}
          onBackgroundClick={() => setSelected(null)}
        >
          {docNodes}
        </Canvas>
      )}

      {fullView && fullViewDoc && (
        <FullView
          doc={fullViewDoc}
          startPageId={fullView.pageId}
          onClose={() => setFullView(null)}
        />
      )}

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-card">Drop to add</div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
