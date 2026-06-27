import { useCallback, useEffect } from 'react'
import { findConverter } from '../pdfx/convert'
import { importIntoDocs, loadIncomingPages } from '../pdfx/source'
import type { ImportedMirror } from '../pdfx/mirror'
import { dedupeNames } from './names'
import { applyExternalDrop } from './external-drop'
import type { Collection } from './useCollection'
import type { DropTarget } from '../canvas/layout'
import type { IncomingFile } from './types'

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
          const { docs: entries, mirror } = await importIntoDocs(name, data)
          setDocs((prev) => [...prev, ...dedupeNames(prev, entries)])
          if (mirror) loadEditState(mirror)
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
        await applyExternalDrop(files, target, {
          docs: docsRef.current,
          addFiles,
          insertPagesIntoDoc,
          spliceDocsAfter
        })
      } catch (error) {
        console.error('Drop failed', error)
        flash('Could not add files')
      } finally {
        setBusy(false)
      }
    },
    [addFiles, insertPagesIntoDoc, spliceDocsAfter, flash, setBusy, docsRef]
  )

  return { addFiles, openViaDialog, addPagesToDoc, handleExternalDropFiles }
}
