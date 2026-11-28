import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { computeLayout } from './canvas/layout'
import { Toolbar } from './components/Toolbar'
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
import { SignaturePad } from './components/edit/SignaturePad'
import { makePageKey } from './edit/model'
import { useFind } from './search/useFind'
import { useFindShortcuts } from './search/useFindShortcuts'
import { FindProvider } from './search/FindContext'
import type { FindMatch } from './search/find-controller'
import { FindBarHost } from './components/FindBar'
import { CloseIcon } from './components/icons'
import type { FullViewNav } from './components/full-view/use-full-view-controls'
import { OcrExportPrompt } from './components/OcrExportPrompt'
import { createOcrStore } from './ocr/ocr-store'
import { createLangPacks } from './ocr/lang-packs'
import { createOcrFindSupply } from './ocr/ocr-find-supply'
import { OcrUiProvider, type OcrActions, type OcrDialogRequest } from './ocr/OcrContext'
import {
  removedCopy,
  removeTargets,
  summarizeOcr,
  UNAVAILABLE_COPY,
  unavailableDetails
} from './ocr/ocr-ui'
import { useBannerSeen } from './ocr/useBannerSeen'
import { copyPageText } from './ocr/copy-page-text'
import { isSignedSource } from './ocr/signed-source'
import { OcrToolbarItems } from './components/ocr/OcrToolbarItems'
import { RecognizeDialog } from './components/ocr/RecognizeDialog'
import { OcrBanner } from './components/ocr/OcrBanner'
import { OcrSummaryPopover } from './components/ocr/OcrSummaryPopover'
import { OcrMenuSync, OcrSignDialog, OcrToasts } from './components/ocr/OcrAppParts'
import { useToast } from './app/useToast'
import { connectRecognizedText } from './ocr/recognized-text'

export default function App(): React.JSX.Element {
  // Ref-count busy instead of a plain boolean: overlapping operations (a 2nd-instance open / Explorer
  // double-click that isn't gated) must not let the first one's setBusy(false) re-enable the toolbar
  // while another is still running. Every caller pairs setBusy(true)/(false) via finally, so the
  // count stays balanced. (P2-9)
  const [busyCount, setBusyCount] = useState(0)
  const busy = busyCount > 0
  const setBusy = useCallback(
    (b: boolean) => setBusyCount((n) => Math.max(0, n + (b ? 1 : -1))),
    []
  )
  const [signOpen, setSignOpen] = useState(false)
  // The Sign dialog stays MOUNTED while the user places a signature box — it's only hidden.
  // Unmounting it would destroy every useState field inside (mode, cert, passphrase, reason, TSA
  // URL, LTV, PIN, cert/token selection), so the auto-reopen used to hand back a blank dialog and
  // the user had to retype everything.
  const [placing, setPlacing] = useState(false)
  const [padOpen, setPadOpen] = useState(false)
  // True while the Sign dialog is waiting for the user to place a box on the page (it hid itself
  // to let them); when the placement lands we reveal the dialog so they never hunt for a 2nd button.
  const awaitingPlacement = useRef(false)
  const [scale, setScale] = useState(1)
  const [renderVersion, setRenderVersion] = useState(0)
  const canvasRef = useRef<CanvasHandle | null>(null)

  // A toast with a button ([Resume], [Details]) stays until it is used or dismissed (useToast).
  const { toast, flash, dismiss: dismissToast } = useToast()

  const collection = useCollection(flash)
  const fullViewState = useFullView()
  const editStore = useEditStore()
  const { fullView } = fullViewState
  const docs = collection.docs
  // Documents wrap to a width derived from the canvas viewport (reported by the canvas once it is
  // mounted, then on resize); until then computeLayout's default stands in. Cells take each page's
  // cropped + rotated geometry; both maps keep their identity across unrelated edits (EditProvider
  // memoizes them), so the edits object is built inside the memo, never listed as a dep.
  const [wrapWidth, setWrapWidth] = useState<number | undefined>(undefined)
  const { rotations, crops } = editStore
  const layout = useMemo(
    () => computeLayout(docs, { rotations, crops }, wrapWidth),
    [docs, rotations, crops, wrapWidth]
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

  // "Place on page" from the Sign dialog: switch to the signature tool, open the first page if we're
  // in the collection view (placement needs the editor canvas), and hide the dialog so the user can
  // drag a box. The effect below reveals it — with all its fields intact — once they do.
  const requestPlacement = useCallback(() => {
    // Never enter placing mode without the editor canvas being up: `placing` hides the dialog, and
    // the abandon effect below would immediately (and confusingly) close it again.
    if (!fullViewState.fullView) {
      const first = docs[0]?.pages[0]
      if (!first) return
      fullViewState.openPage(docs[0].id, first.id)
    }
    awaitingPlacement.current = true
    editStore.setTool('signature')
    setPlacing(true)
  }, [editStore, fullViewState, docs])

  useEffect(() => {
    if (awaitingPlacement.current && signaturePlacement) {
      awaitingPlacement.current = false
      setPlacing(false)
      setSignOpen(true)
    }
  }, [signaturePlacement])

  // If the user abandons "Place on page" by switching away from the signature tool, drop the pending
  // reopen latch — otherwise a later, unrelated signature placement would unexpectedly reopen the
  // Sign dialog (the dialog hid itself, which never runs onClose). (P2-4) The abandoned dialog is
  // also fully closed, so a hidden-but-mounted dialog can never linger invisibly.
  useEffect(() => {
    if (editStore.tool === 'signature' || !awaitingPlacement.current) return
    awaitingPlacement.current = false
    setPlacing(false)
    setSignOpen(false)
  }, [editStore.tool])

  // The OTHER way to abandon a placement is to close full view (Escape, handled window-level in
  // use-full-view-input, or the close button) — and that leaves `editStore.tool` on 'signature', so
  // the effect above never fires for it. Without this, Escape during "Place on page…" left
  // signOpen=true + placing=true: an invisible display:none dialog, and a Toolbar Sign button that
  // was a silent no-op forever after (setSignOpen(true) on already-true state changes nothing).
  //
  // It cannot mis-fire on the OPENING transition. requestPlacement calls openPage() and
  // setPlacing(true) from one React event handler, so React batches them into a single commit: the
  // first render this effect ever sees with `placing === true` already has a non-null `fullView`.
  // And requestPlacement refuses to set `placing` at all when there is no page to open, so `placing`
  // is never true with full view legitimately closed. Composes with the tool-switch abandon above —
  // both do the same three idempotent resets, so firing both is harmless.
  useEffect(() => {
    if (!placing || fullView) return
    awaitingPlacement.current = false
    setPlacing(false)
    setSignOpen(false)
  }, [placing, fullView])

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
    onExternalDrop: handleExternalDropFiles,
    onDropError: flash
  })

  const onPaste = useCallback(() => void handlePaste(), [handlePaste])
  const [ocrDialog, setOcrDialog] = useState<OcrDialogRequest | null>(null)
  const modalOpen = (signOpen && !placing) || padOpen || !!ocrDialog
  const modalOpenRef = useRef(modalOpen)
  modalOpenRef.current = modalOpen
  useKeyboardShortcuts({
    // Never behind a modal dialog: a key that lands outside it must not delete or copy a page.
    active: !fullViewState.fullView && !modalOpen,
    selected: collection.selected,
    onDeletePage: collection.deletePage,
    onDuplicate: collection.duplicatePage,
    onCopy: collection.copySelected,
    onPaste,
    onClearSelection: collection.clearSelection
  })

  // Find. Its controller is created once and never re-renders App: the bar, the page cells and the
  // full-view highlights subscribe to it directly.
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const selectedRef = useRef(collection.selected)
  selectedRef.current = collection.selected
  const hiddenPageIdRef = useRef(fullViewState.hiddenPageId)
  hiddenPageIdRef.current = fullViewState.hiddenPageId
  const fullViewNavRef = useRef<FullViewNav | null>(null)
  const getAnchorPageId = useCallback(
    () =>
      fullViewState.fullViewRef.current
        ? hiddenPageIdRef.current
        : (selectedRef.current?.pageId ?? null),
    [fullViewState.fullViewRef]
  )
  const onFindNavigate = useCallback(
    (m: FindMatch) => {
      if (fullViewState.fullViewRef.current) {
        fullViewNavRef.current?.goTo(m.docId, m.pageId)
        return
      }
      const slot = layoutRef.current.items
        ?.find((i) => i.doc.id === m.docId)
        ?.pages.find((p) => p.pageId === m.pageId)
      if (slot) canvasRef.current?.revealRect(slot)
    },
    [fullViewState.fullViewRef]
  )
  const find = useFind({
    docs,
    overlays: editStore.overlays,
    getAnchorPageId,
    onNavigate: onFindNavigate
  })
  useFindShortcuts({ controller: find, enabled: !modalOpen })

  // Text recognition (DESIGN.md §3.5.2): the OCR store and its Find supply live outside React
  // state, like the find controller, and are created once. The port is connected only when OCR is
  // really needed (a scan, an imported image, a request); a text PDF never spawns the process.
  const [ocrStore] = useState(() =>
    createOcrStore({
      port: window.api.ocr ?? null,
      text: find.text,
      getSettings: window.api.getSettings,
      setSettings: window.api.setSettings
    })
  )
  const [ocrSupply] = useState(() => createOcrFindSupply({ store: ocrStore, text: find.text }))
  // Downloadable languages (PR9): the list comes from main; nothing downloads without consent.
  const [langPacks] = useState(() =>
    createLangPacks(window.api.ocrLangs ?? null, (t) => window.api.writeClipboardText(t))
  )
  const { ocrSelect, selectOcr, editLayer } = editStore
  // After useFind's own effects (declared above, so they run first): the engine knows the page
  // keys before anything is supplied for them.
  useEffect(() => ocrStore.reconcile(docs), [ocrStore, docs])
  useEffect(
    () => ocrStore.syncEdits({ ocrSelect, rotations, selectOcr }),
    [ocrStore, ocrSelect, rotations, selectOcr]
  )
  useEffect(() => ocrSupply.sync(docs, editLayer), [ocrSupply, docs, editLayer])
  // "Show recognized text" (full view) draws the supply's filtered words (PR10).
  useEffect(() => connectRecognizedText(ocrSupply), [ocrSupply])
  // The page in view is recognised first (§3.3.6): the full-view page, else the selected one.
  const focusPageId = fullView ? fullViewState.hiddenPageId : (collection.selected?.pageId ?? null)
  const focus = useMemo(() => {
    if (!focusPageId) return null
    for (const d of docs) {
      const page = d.pages.find((p) => p.id === focusPageId)
      if (page) return { docId: d.id, key: makePageKey(page.source.id, page.pageIndex) }
    }
    return null
  }, [docs, focusPageId])
  const focusKey = focus?.key ?? null
  useEffect(() => ocrStore.setFocus(focusKey), [ocrStore, focusKey])

  // ---- Text recognition UI (DESIGN.md §3.8)
  const [showRecognizedText, setShowRecognizedText] = useState(false)
  const [summaryAt, setSummaryAt] = useState<{
    anchor: HTMLElement | null
    docId: string | null
  } | null>(null)
  // The full-view banner shows at most once per document per session.
  const banner = useBannerSeen(fullView ? (focus?.docId ?? fullView.docId) : null)

  // What the actions read when they run (they are created once, so the context stays stable).
  const latestOcr = useRef({ docs, focus, fullViewState })
  latestOcr.current = { docs, focus, fullViewState }
  const { rotatePage } = editStore
  const ocrActions = useMemo<OcrActions>(
    () => ({
      openDialog: (req) => {
        if (modalOpenRef.current) return
        setOcrDialog(req ?? {})
      },
      recognizeNow: (keys) => {
        if (keys.length === 0) return
        if (ocrStore.recognize(keys) === null) {
          const reason = ocrStore.getSnapshot().unavailable
          flash(UNAVAILABLE_COPY, {
            label: 'Details',
            run: () => flash(unavailableDetails(reason))
          })
        }
      },
      openSummary: (anchor, docId) => setSummaryAt({ anchor, docId }),
      viewPage: (docId, pageId) => {
        const fv = latestOcr.current.fullViewState
        if (fv.fullViewRef.current) fullViewNavRef.current?.goTo(docId, pageId)
        else fv.openPage(docId, pageId)
      },
      rotatePage: (pageKey, delta) => rotatePage(pageKey, delta)
    }),
    [ocrStore, flash, rotatePage]
  )
  const ocrValue = useMemo(
    () => ({ store: ocrStore, supply: ocrSupply, actions: ocrActions, langs: langPacks }),
    [ocrStore, ocrSupply, ocrActions, langPacks]
  )

  /** The Document menu's commands (§3.8): the page in view, else the selected page. */
  const onOcrMenu = useCallback(
    async (action: string): Promise<void> => {
      const { docs: liveDocs, focus: f } = latestOcr.current
      if (action === 'recognize-text') ocrActions.openDialog({ mode: 'recognize' })
      else if (action === 'replace-recognized-text') ocrActions.openDialog({ mode: 'replace' })
      else if (action === 'recognize-all-scanned') {
        const keys = summarizeOcr(liveDocs, ocrStore).unrecognized
        if (keys.length === 0) flash('No scanned pages are waiting for text recognition')
        else ocrActions.recognizeNow(keys)
      } else if (action === 'remove-recognized-text') {
        const { keys, none } = removeTargets(summarizeOcr(liveDocs, ocrStore), f?.key ?? null)
        if (keys.length === 0) {
          flash(none)
          return
        }
        ocrStore.remove(keys) // one undo step for all of them
        flash(removedCopy(keys.length))
      } else if (action === 'show-recognized-text') setShowRecognizedText((v) => !v)
      else if (action === 'include-recognized-text') {
        const next = !ocrStore.settings()['ocr.includeInExports']
        try {
          await ocrStore.setSettings({ 'ocr.includeInExports': next })
        } catch (err) {
          console.warn('ocr: could not save the export setting', err)
        }
        // Electron flipped the checkbox on click: put back what the setting really is.
        window.api.setMenuChecked?.(
          'include-recognized-text',
          ocrStore.settings()['ocr.includeInExports']
        )
      } else if (action === 'copy-page-text') {
        if (!f) {
          flash('Select a page to copy its text')
          return
        }
        const r = await copyPageText(f.key, {
          text: find.text,
          supply: ocrSupply,
          write: (t) => window.api.writeClipboardText(t)
        })
        flash(
          r.copied
            ? 'Page text copied'
            : r.reason === 'empty'
              ? 'This page has no text to copy'
              : 'Couldn’t copy the page text'
        )
      }
    },
    [ocrActions, ocrStore, ocrSupply, flash, find]
  )
  const signedSources = useMemo(
    () => docs.some((d) => d.pages.some((p) => isSignedSource(p.source?.bytes))),
    [docs]
  )

  const {
    exportCollection,
    exportZip,
    signAndExport,
    signWithCardAndExport,
    signWithWindowsCertAndExport
  } = useExport(
    docs,
    editLayer,
    setBusy,
    flash,
    editStore.signaturePlacement,
    editStore.savedSignature,
    ocrStore.exportSource
  )

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

  // Notices raised by the main process — today, the files an open/drop/paste batch could not read.
  // Optional-called because `window.api` is injected by the preload bridge: a partial stand-in (or
  // an older preload next to a newer renderer) must not take the whole app down at mount.
  useEffect(() => {
    return window.api.onNotice?.((message) => flash(message))
  }, [flash])

  useEffect(() => {
    return window.api.onMenu((action) => {
      if (action === 'open') void openViaDialog()
      else if (action === 'export-pdfx') void exportCollection('pdfx')
      else if (action === 'export-pdf') void exportCollection('pdf')
      else if (action === 'export-zip') void exportZip()
      else if (action === 'find' && !modalOpenRef.current) find.open()
      else if (action === 'show-recognized-text' || action === 'include-recognized-text')
        void onOcrMenu(action) // settings: fine with a dialog open
      else if (!modalOpenRef.current) void onOcrMenu(action)
    })
  }, [openViaDialog, exportCollection, exportZip, find, onOcrMenu])

  const totalPages = docs.reduce((sum, d) => sum + d.pages.length, 0)
  const fullViewDoc = fullView ? docs.find((d) => d.id === fullView.docId) : undefined

  return (
    <EditProvider store={editStore}>
      <FindProvider value={find}>
        <OcrUiProvider value={ocrValue} docs={docs} showRecognizedText={showRecognizedText}>
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
              ocr={<OcrToolbarItems busy={busy} />}
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
              onWrapWidthChange={setWrapWidth}
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
                  navRef={fullViewNavRef}
                  banner={
                    focus && (
                      <OcrBanner
                        docId={focus.docId}
                        pageKey={focus.key}
                        seen={banner.seen}
                        onShown={banner.onShown}
                        onDone={banner.onDone}
                      />
                    )
                  }
                />
                <EditTools />
              </>
            )}

            {signOpen && (
              <OcrSignDialog
                busy={busy}
                hidden={placing}
                onSign={signAndExport}
                onSignCard={signWithCardAndExport}
                listTokens={(modulePath) => window.api.listCardTokens(modulePath)}
                findModules={() => window.api.findCardModules()}
                listWindowsCerts={() => window.api.listWindowsCerts()}
                onSignWindowsCert={signWithWindowsCertAndExport}
                platform={window.api.platform}
                pathForFile={(file) => window.api.getPathForFile(file)}
                placementLabel={editStore.signaturePlacement?.label ?? null}
                onClearPlacement={() => editStore.setSignaturePlacement(null)}
                onPlaceRequest={requestPlacement}
                hasSavedSignature={!!editStore.savedSignature}
                onDrawSignature={() => setPadOpen(true)}
                onClose={() => {
                  awaitingPlacement.current = false
                  setPlacing(false)
                  setSignOpen(false)
                }}
              />
            )}

            {padOpen && (
              <SignaturePad
                onSave={(bytes) => {
                  editStore.setSavedSignature(bytes)
                  setPadOpen(false)
                }}
                onClose={() => setPadOpen(false)}
              />
            )}

            <FindBarHost controller={find} />

            <OcrExportPrompt store={ocrStore} signedNote={signedSources} />

            {ocrDialog && (
              <RecognizeDialog
                mode={ocrDialog.mode ?? 'recognize'}
                fixedKeys={ocrDialog.keys}
                focusDocId={focus?.docId ?? null}
                focusPageKey={focus?.key ?? null}
                inFullView={!!fullView}
                docs={docs}
                onClose={() => setOcrDialog(null)}
              />
            )}

            {summaryAt && (
              <OcrSummaryPopover
                anchor={summaryAt.anchor}
                docId={summaryAt.docId}
                onClose={() => setSummaryAt(null)}
              />
            )}

            <OcrToasts
              store={ocrStore}
              flash={flash}
              onDetails={() => ocrActions.openSummary(null, null)}
            />
            <OcrMenuSync showRecognizedText={showRecognizedText} />

            {/* Always mounted, so a new message is a change a screen reader announces (a live
                region that mounts with its text already in it is often not read). */}
            <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {toast?.message ?? ''}
            </div>
            {toast && (
              <div className="toast">
                {toast.message}
                {toast.action && (
                  <>
                    <button
                      className="toast-action"
                      onClick={() => {
                        const run = toast.action!.run
                        dismissToast()
                        run()
                      }}
                    >
                      {toast.action.label}
                    </button>
                    <button
                      className="toast-dismiss"
                      aria-label="Dismiss"
                      title="Dismiss"
                      onClick={dismissToast}
                    >
                      <CloseIcon size={11} />
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </OcrUiProvider>
      </FindProvider>
    </EditProvider>
  )
}
