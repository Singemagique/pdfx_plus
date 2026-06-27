import { findConverter } from '../pdfx/convert'
import { importIntoDocs, loadSource, pagesFromSource } from '../pdfx/source'
import { partitionPages, readManifest, stripExtension } from '../pdfx/format'
import type { DocEntry, PageEntry } from '../types'
import type { DropTarget } from '../canvas/layout'
import type { IncomingFile } from './types'

export interface ExternalDropDeps {
  docs: DocEntry[]
  addFiles: (files: IncomingFile[]) => Promise<void>
  insertPagesIntoDoc: (docId: string, index: number, entries: PageEntry[]) => void
  spliceDocsAfter: (anchorDocId: string | null, newDocs: DocEntry[]) => void
}

async function dropSingleFileInto(
  file: IncomingFile,
  target: { docId: string; index: number },
  deps: ExternalDropDeps
): Promise<void> {
  const doc = deps.docs.find((d) => d.id === target.docId)
  if (!doc) {
    await deps.addFiles([file])
    return
  }
  const conv = findConverter(file.name, file.data)
  if (conv) {
    const ref = doc.pages[Math.min(target.index, doc.pages.length - 1)]
    const bytes = await conv.toPdf(
      file.name,
      file.data,
      { width: ref.width, height: ref.height },
      file.path
    )
    const { source, sizes } = await loadSource(bytes)
    const pages = pagesFromSource(
      source,
      sizes,
      sizes.map((_, i) => i)
    )
    deps.insertPagesIntoDoc(target.docId, target.index, pages)
    return
  }
  const { source, sizes } = await loadSource(file.data)
  const manifest = await readManifest(source.pdf)
  const parts = partitionPages(manifest, source.pdf.numPages, stripExtension(file.name))
  if (parts.length > 1) {
    const newDocs: DocEntry[] = parts.map((part) => ({
      id: crypto.randomUUID(),
      name: part.name,
      pages: pagesFromSource(source, sizes, part.indices)
    }))
    deps.spliceDocsAfter(target.docId, newDocs)
  } else {
    deps.insertPagesIntoDoc(
      target.docId,
      target.index,
      pagesFromSource(source, sizes, parts[0].indices)
    )
  }
}

async function dropFilesAsNewDocs(
  files: IncomingFile[],
  target: DropTarget,
  deps: ExternalDropDeps
): Promise<void> {
  const anchorDocId =
    target.kind === 'between' ? (deps.docs[target.docIndex - 1]?.id ?? null) : target.docId
  const newDocs: DocEntry[] = []
  for (const file of files) {
    const conv = findConverter(file.name, file.data)
    const name = conv ? conv.rename(file.name) : file.name
    const data = conv ? await conv.toPdf(file.name, file.data, undefined, file.path) : file.data
    newDocs.push(...(await importIntoDocs(name, data)).docs)
  }
  deps.spliceDocsAfter(anchorDocId, newDocs)
}

export async function applyExternalDrop(
  files: IncomingFile[],
  target: DropTarget,
  deps: ExternalDropDeps
): Promise<void> {
  if (target.kind === 'into' && files.length === 1) {
    await dropSingleFileInto(files[0], target, deps)
  } else {
    await dropFilesAsNewDocs(files, target, deps)
  }
}
