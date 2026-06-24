import { useCallback } from 'react'
import { imageToPdf } from '../pdfx/images'
import { importIntoDocs, loadIncomingPages, loadSource, pagesFromSource } from '../pdfx/source'
import { dedupeNames } from './names'
import { findSelectedTarget } from './selection'
import type { Collection } from './useCollection'
import type { IncomingFile } from './types'

export function usePaste(
  collection: Collection,
  addFiles: (files: IncomingFile[]) => Promise<void>,
  setBusy: (busy: boolean) => void,
  flash: (message: string) => void
) {
  const { docs, selected, setDocs, insertPagesAfter, pasteAfterSelected } = collection

  const pasteFiles = useCallback(
    async (files: IncomingFile[]) => {
      const target = findSelectedTarget(docs, selected)
      if (!target) {
        await addFiles(files)
        return
      }
      setBusy(true)
      try {
        const reference = target.doc.pages[target.index]
        const entries = await loadIncomingPages(files, {
          width: reference.width,
          height: reference.height
        })
        insertPagesAfter(target, entries)
      } catch (error) {
        console.error('Paste failed', error)
        flash('Could not paste')
      } finally {
        setBusy(false)
      }
    },
    [docs, selected, addFiles, insertPagesAfter, flash, setBusy]
  )

  const pasteImage = useCallback(
    async (png: Uint8Array) => {
      try {
        const target = findSelectedTarget(docs, selected)
        if (target) {
          const reference = target.doc.pages[target.index]
          const bytes = await imageToPdf(png, { width: reference.width, height: reference.height })
          const { source, sizes } = await loadSource(bytes)
          insertPagesAfter(target, pagesFromSource(source, sizes, [0]))
        } else {
          const entries = await importIntoDocs('Pasted image', await imageToPdf(png))
          setDocs((prev) => [...prev, ...dedupeNames(prev, entries)])
        }
      } catch (error) {
        console.error('Image paste failed', error)
        flash('Could not paste image')
      }
    },
    [docs, selected, insertPagesAfter, setDocs, flash]
  )

  const handlePaste = useCallback(async () => {
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

  return { handlePaste }
}
