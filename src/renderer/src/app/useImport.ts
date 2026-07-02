import { useCallback, useEffect } from 'react'
import { findConverter } from '../pdfx/convert'
import { importIntoDocs, loadIncomingPages } from '../pdfx/source'
import type { ImportedMirror } from '../pdfx/mirror'
import type { IntegrityComparison } from '../pdfx/canonicalize'
import { dedupeNames } from './names'
import { applyExternalDrop } from './external-drop'
import type { Collection } from './useCollection'
import type { DropTarget } from '../canvas/layout'
import type { IncomingFile } from './types'

type GateDecision = 'cancel' | 'load' | 'skip'

/**
 * Tamper gate for a .pdfx's saved edits (shared by File→Open and drop). With no mirror there's
 * nothing to load. If the content still matches the hash the edits were saved against, load them.
 * If it changed, prompt: the user can load the (possibly stale/forged) edits anyway, open without
 * them, or cancel the open entirely.
 */
async function tamperGate(
  mirror: ImportedMirror | null,
  integrity: IntegrityComparison
): Promise<GateDecision> {
  if (!mirror) return 'skip'
  if (!integrity.tampered) return 'load'
  const changed = integrity.changedPages
  const detail =
    changed.length === 0
      ? 'The document content changed since these edits were saved.'
      : changed.length > 10
        ? `${changed.length} pages changed since these edits were saved.`
        : `Page${changed.length > 1 ? 's' : ''} ${changed.join(', ')} changed since these edits were saved.`
  const choice = await window.api.confirmIntegrity(detail)
  return choice === 2 ? 'cancel' : choice === 1 ? 'load' : 'skip'
}

export function useImport(
  collection: Collection,
  loadEditState: (s: ImportedMirror) => void,
  setBusy: (busy: boolean) => void,
  flash: (message: string) => void
) {
  const { setDocs, docsRef, appendPagesToDoc, insertPagesIntoDoc, spliceDocsAfter } = collection

  const addFiles = useCallback(
    async (files: IncomingFile[]) => {
      if (files.length === 0) return
      setBusy(true)
      const failed: string[] = []
      for (const file of files) {
        try {
          const conv = findConverter(file.name, file.data)
          const name = conv ? conv.rename(file.name) : file.name
          const data = conv
            ? await conv.toPdf(file.name, file.data, undefined, file.path)
            : file.data
          const { docs: entries, mirror, integrity } = await importIntoDocs(name, data)
          const decision = await tamperGate(mirror, integrity)
          if (decision === 'cancel') continue // Cancel → don't open this file at all
          setDocs((prev) => [...prev, ...dedupeNames(prev, entries)])
          if (decision === 'load' && mirror) loadEditState(mirror)
        } catch (error) {
          console.error(`Failed to import ${file.name}`, error)
          failed.push(file.name)
        }
      }
      setBusy(false)
      if (failed.length > 0) flash(`Could not open ${failed.join(', ')}`)
    },
    [flash, setBusy, setDocs, loadEditState]
  )

  useEffect(() => {
    const unsubscribe = window.api.onFilesOpened((files) => void addFiles(files))
    void window.api.rendererReady()
    return unsubscribe
  }, [addFiles])

  const openViaDialog = useCallback(async () => {
    await addFiles(await window.api.openFiles())
  }, [addFiles])

  const addPagesToDoc = useCallback(
    async (docId: string) => {
      const files = await window.api.openFiles()
      if (files.length === 0) return
      const doc = docsRef.current.find((d) => d.id === docId)
      if (!doc) return
      setBusy(true)
      try {
        const reference = doc.pages[doc.pages.length - 1]
        const ref = reference ? { width: reference.width, height: reference.height } : undefined
        appendPagesToDoc(docId, await loadIncomingPages(files, ref))
      } catch (error) {
        console.error('Add page failed', error)
        flash('Could not add pages')
      } finally {
        setBusy(false)
      }
    },
    [flash, setBusy, docsRef, appendPagesToDoc]
  )

  const handleExternalDropFiles = useCallback(
    async (files: IncomingFile[], target: DropTarget | null) => {
      if (files.length === 0) return
      if (docsRef.current.length === 0 || !target) {
        await addFiles(files)
        return
      }
      setBusy(true)
      try {
        const dropped = await applyExternalDrop(files, target, {
          docs: docsRef.current,
          addFiles,
          insertPagesIntoDoc,
          spliceDocsAfter
        })
        // Load the saved edits carried by any dropped .pdfx (the pages are already placed, so a
        // tamper "cancel" here just skips the edits rather than removing the pages).
        for (const { mirror, integrity } of dropped) {
          if ((await tamperGate(mirror, integrity)) === 'load' && mirror) loadEditState(mirror)
        }
      } catch (error) {
        console.error('Drop failed', error)
        flash('Could not add files')
      } finally {
        setBusy(false)
      }
    },
    [addFiles, insertPagesIntoDoc, spliceDocsAfter, flash, setBusy, docsRef, loadEditState]
  )

  return { addFiles, openViaDialog, addPagesToDoc, handleExternalDropFiles }
}
