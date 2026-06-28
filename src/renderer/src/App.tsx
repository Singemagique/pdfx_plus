import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { computeLayout } from './canvas/layout'
import { Toolbar } from './components/Toolbar'
import { SignDialog } from './components/SignDialog'
import { FullView } from './components/FullView'
import { CollectionCanvas } from './components/CollectionCanvas'
import type { CanvasHandle } from './components/Canvas'
import { useCollection } from './app/useCollection'
import { useFullView } from './app/useFullView'
import { useExport } from './app/useExport'
import { useImport } from './app/useImport'
import { usePaste } from './app/usePaste'
import { useDragController } from './app/useDragController'
import { useKeyboardShortcuts } from './app/useKeyboardShortcuts'
import { EditProvider, useEditStore } from './edit/EditProvider'
import { EditTools } from './components/edit/EditTools'
import { makePageKey } from './edit/model'

const TOAST_MS = 4000

export default function App(): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [signOpen, setSignOpen] = useState(false)
  const [scale, setScale] = useState(1)
  const [renderVersion, setRenderVersion] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const canvasRef = useRef<CanvasHandle | null>(null)

  const flash = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast(message)
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS)
  }, [])

  const collection = useCollection(flash)
  const fullViewState = useFullView()
  const editStore = useEditStore()
  const docs = collection.docs
  const layout = useMemo(
    () => computeLayout(docs, editStore.rotations),
    [docs, editStore.rotations]
  )

  // Drop a signature placement whose page no longer exists (its document/page was removed), so a
  // dangling placement can't silently produce no appearance — or land on the wrong page — on sign.
  const { signaturePlacement, setSignaturePlacement } = editStore
  useEffect(() => {
    if (!signaturePlacement) return
    const exists = docs.some((d) =>
      d.pages.some((p) => makePageKey(p.source.id, p.pageIndex) === signaturePlacement.pageKey)
    )
    if (!exists) setSignaturePlacement(null)
  }, [docs, signaturePlacement, setSignaturePlacement])

  const { exportCollection, exportZip, signAndExport, signWithCardAndExport } = useExport(
    docs,
    editStore.editLayer,
    setBusy,
    flash,
    editStore.signaturePlacement,
    editStore.savedSignature
  )
  const { addFiles, openViaDialog, addPagesToDoc, handleExternalDropFiles } = useImport(
    collection,
    editStore.loadEditState,
    setBusy,
    flash
  )
  const { handlePaste } = usePaste(collection, addFiles, setBusy, flash)

  const drag = useDragController({
    layout,
    canvasRef,
    movePageInto: collection.movePageInto,
    movePageToNewDoc: collection.movePageToNewDoc,
    onExternalDrop: handleExternalDropFiles
  })

  const onPaste = useCallback(() => void handlePaste(), [handlePaste])
  useKeyboardShortcuts({
    active: !fullViewState.fullView,
    selected: collection.selected,
    onDeletePage: collection.deletePage,
    onDuplicate: collection.duplicatePage,
    onCopy: collection.copySelected,
    onPaste,
    onClearSelection: collection.clearSelection
  })

  const onScaleChange = useCallback((next: number) => setScale(next), [])
  const onSettle = useCallback(() => setRenderVersion((v) => v + 1), [])

  const fullViewRef = fullViewState.fullViewRef
  useEffect(() => {
    return window.api.onZoom((action) => {
      if (fullViewRef.current) return
      if (action === 'in') canvasRef.current?.zoomIn()
      else if (action === 'out') canvasRef.current?.zoomOut()
      else canvasRef.current?.reset()
    })
  }, [fullViewRef])

  useEffect(() => {
    return window.api.onMenu((action) => {
      if (action === 'open') void openViaDialog()
      else if (action === 'export-pdfx') void exportCollection('pdfx')
      else if (action === 'export-pdf') void exportCollection('pdf')
      else if (action === 'export-zip') void exportZip()
    })
  }, [openViaDialog, exportCollection, exportZip])

  const totalPages = docs.reduce((sum, d) => sum + d.pages.length, 0)
  const { fullView } = fullViewState
  const fullViewDoc = fullView ? docs.find((d) => d.id === fullView.docId) : undefined

  return (
    <EditProvider store={editStore}>
      <div
        className={
          'app' + (drag.committing ? ' committing' : '') + (drag.dragKind ? ' dragging' : '')
        }
        onDragEnter={drag.handlers.onDragEnter}
        onDragOver={drag.handlers.onDragOver}
        onDragLeave={drag.handlers.onDragLeave}
        onDrop={drag.handlers.onDrop}
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
          onExportPdf={() => exportCollection('pdf')}
          onExportZip={exportZip}
          onSign={() => setSignOpen(true)}
        />

        <CollectionCanvas
          docs={docs}
          layout={layout}
          busy={busy}
          pagesDraggable={totalPages >= 2}
          renderVersion={renderVersion}
          selected={collection.selected}
          hiddenPageId={fullViewState.hiddenPageId}
          dragKind={drag.dragKind}
          draggingPage={drag.draggingPage}
          dropTarget={drag.dropTarget}
          collapsedId={drag.collapsedId}
          externalCount={drag.externalCount}
          canvasRef={canvasRef}
          onScaleChange={onScaleChange}
          onSettle={onSettle}
          onBackgroundClick={collection.clearSelection}
          onOpen={openViaDialog}
          onSelectPage={collection.selectPage}
          onOpenPage={fullViewState.openPage}
          onPageDragStart={drag.startPageDrag}
          onPageDragEnd={drag.clearDrag}
          onAddPage={addPagesToDoc}
          onMoveDoc={collection.moveDoc}
          onRemoveDoc={collection.removeDoc}
          onRenameDoc={collection.renameDoc}
        />

        {fullView && fullViewDoc && (
          <>
            <FullView
              docs={docs}
              startDocId={fullView.docId}
              startPageId={fullView.pageId}
              originRect={fullView.originRect}
              onActivePageChange={fullViewState.setHiddenPageId}
              onClose={fullViewState.closeFullView}
            />
            <EditTools />
          </>
        )}

        {signOpen && (
          <SignDialog
            busy={busy}
            onSign={signAndExport}
            onSignCard={signWithCardAndExport}
            listTokens={(modulePath) => window.api.listCardTokens(modulePath)}
            findModules={() => window.api.findCardModules()}
            pathForFile={(file) => window.api.getPathForFile(file)}
            placementLabel={editStore.signaturePlacement?.label ?? null}
            onClearPlacement={() => editStore.setSignaturePlacement(null)}
            onPlaceRequest={() => {
              editStore.setTool('signature')
              setSignOpen(false)
            }}
            hasSavedSignature={!!editStore.savedSignature}
            onClose={() => setSignOpen(false)}
          />
        )}

        {toast && <div className="toast">{toast}</div>}
      </div>
    </EditProvider>
  )
}
