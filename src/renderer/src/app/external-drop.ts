import { findConverter } from '../pdfx/convert'
import { importIntoDocs, loadSource, pagesFromSource } from '../pdfx/source'
import type { ImportedMirror } from '../pdfx/mirror'
import type { IntegrityComparison } from '../pdfx/canonicalize'
import type { DocEntry, PageEntry } from '../types'
import type { DropTarget } from '../canvas/layout'
import type { IncomingFile } from './types'

export interface ExternalDropDeps {
  docs: DocEntry[]
  addFiles: (files: IncomingFile[]) => Promise<void>
  insertPagesIntoDoc: (docId: string, index: number, entries: PageEntry[]) => void
  spliceDocsAfter: (anchorDocId: string | null, newDocs: DocEntry[]) => void
}

/**
 * The editable mirror (overlays/rotations/crops) + tamper record carried by a dropped `.pdfx`.
 * The drop helpers surface these so the caller can gate + load the saved edits — dropping a `.pdfx`
 * onto a non-empty canvas must NOT silently discard its edits (they key by source page identity, so
 * they rebind correctly wherever the pages land).
 */
export interface DropMirror {
  mirror: ImportedMirror | null
  integrity: IntegrityComparison
}

async function dropSingleFileInto(
  file: IncomingFile,
  target: { docId: string; index: number },
  deps: ExternalDropDeps
): Promise<DropMirror[]> {
  const doc = deps.docs.find((d) => d.id === target.docId)
  if (!doc) {
    await deps.addFiles([file]) // addFiles runs its own mirror + tamper gate
    return []
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
    return [] // a converted image/office file has no editable mirror
  }
  // A PDF (possibly a .pdfx): route through importIntoDocs so the mirror is deserialized and rebound
  // to the freshly-loaded pages, and the tamper record is computed — then thread both back to the
  // caller instead of dropping them on the floor.
  const { docs: imported, mirror, integrity } = await importIntoDocs(file.name, file.data)
  if (imported.length > 1) {
    deps.spliceDocsAfter(target.docId, imported)
  } else {
    deps.insertPagesIntoDoc(target.docId, target.index, imported[0].pages)
  }
  return [{ mirror, integrity }]
}

async function dropFilesAsNewDocs(
  files: IncomingFile[],
  target: DropTarget,
  deps: ExternalDropDeps
): Promise<DropMirror[]> {
  const anchorDocId =
    target.kind === 'between' ? (deps.docs[target.docIndex - 1]?.id ?? null) : target.docId
  const newDocs: DocEntry[] = []
  const mirrors: DropMirror[] = []
  for (const file of files) {
    const conv = findConverter(file.name, file.data)
    const name = conv ? conv.rename(file.name) : file.name
    const data = conv ? await conv.toPdf(file.name, file.data, undefined, file.path) : file.data
    const res = await importIntoDocs(name, data)
    newDocs.push(...res.docs)
    mirrors.push({ mirror: res.mirror, integrity: res.integrity })
  }
  deps.spliceDocsAfter(anchorDocId, newDocs)
  return mirrors
}

/**
 * Place dropped files relative to an existing collection. Returns the editable mirrors carried by any
 * dropped `.pdfx` (already rebound to the new pages) so the caller can run the tamper gate and load
 * the saved edits. The pages are placed before the gate runs, so on a drop a "cancel"/tamper choice
 * only skips loading the edits rather than removing the just-placed pages.
 */
export async function applyExternalDrop(
  files: IncomingFile[],
  target: DropTarget,
  deps: ExternalDropDeps
): Promise<DropMirror[]> {
  if (target.kind === 'into' && files.length === 1) {
    return dropSingleFileInto(files[0], target, deps)
  }
  return dropFilesAsNewDocs(files, target, deps)
}
