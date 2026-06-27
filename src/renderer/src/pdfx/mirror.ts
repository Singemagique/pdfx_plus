// PDFX v1.1 editable mirror: serialize the edit model into the manifest on .pdfx export,
// and reconstruct it on import — so edits survive save → reopen. In-memory overlays/rotations
// are keyed by page key (sourceId#pageIndex), which is regenerated each load; the mirror keys
// by (document index, page-within-document) instead, and we translate on both ends.

import { makePageKey, newOverlayId, type Overlay } from '../edit/model'
import type { DocEntry } from '../types'
import type { Attachment } from './flatten'
import type { EditLayer } from './build'
import type { ExportDocument, ManifestAttachment, ManifestEdit, PdfxManifest } from './format'

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(s)
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)
  return bytes
}

const attachmentIdOf = (o: Overlay): string | undefined =>
  o.type === 'image' || o.type === 'signatureVisual' ? o.attachmentId : undefined

export interface SerializedMirror {
  edits: ManifestEdit[]
  attachments: Record<string, ManifestAttachment>
}

/** Build the manifest `edits` + `attachments` from the edit layer, or null if there's nothing. */
export function serializeMirror(
  documents: ExportDocument[],
  edits: EditLayer
): SerializedMirror | null {
  const editsArr: ManifestEdit[] = []
  const usedAttachments = new Set<string>()
  let docIndex = 0 // index into the manifest's documents[] (empty docs are skipped on export)

  for (const doc of documents) {
    if (doc.pages.length === 0) continue
    doc.pages.forEach((page, pi) => {
      const key = makePageKey(page.sourceKey, page.pageIndex)
      const overlays = edits.overlays.get(key) ?? []
      const rotation = edits.rotations?.get(key) ?? 0
      if (overlays.length === 0 && !rotation) return
      editsArr.push({
        doc: docIndex,
        page: pi,
        ...(rotation ? { rotation } : {}),
        ...(overlays.length ? { overlays } : {})
      })
      for (const o of overlays) {
        const id = attachmentIdOf(o)
        if (id) usedAttachments.add(id)
      }
    })
    docIndex++
  }

  if (editsArr.length === 0) return null

  const attachments: Record<string, ManifestAttachment> = {}
  for (const id of usedAttachments) {
    const a = edits.attachments.get(id)
    if (a) attachments[id] = { mime: a.mime, data: toBase64(a.bytes) }
  }
  return { edits: editsArr, attachments }
}

export interface ImportedMirror {
  overlays: Overlay[]
  rotations: Array<[string, number]>
  attachments: Array<[string, Attachment]>
}

/** Reconstruct overlays/rotations/attachments from a manifest, keyed to the freshly-loaded docs. */
export function deserializeMirror(manifest: PdfxManifest, docs: DocEntry[]): ImportedMirror | null {
  if (!manifest.edits || manifest.edits.length === 0) return null
  const overlays: Overlay[] = []
  const rotations: Array<[string, number]> = []

  for (const edit of manifest.edits) {
    const page = docs[edit.doc]?.pages[edit.page]
    if (!page) continue
    const key = makePageKey(page.source.id, page.pageIndex)
    if (edit.rotation) rotations.push([key, edit.rotation])
    for (const o of edit.overlays ?? []) {
      overlays.push({ ...o, id: newOverlayId(), pageKey: key })
    }
  }

  const attachments: Array<[string, Attachment]> = Object.entries(manifest.attachments ?? {}).map(
    ([id, a]) => [id, { bytes: fromBase64(a.data), mime: a.mime }]
  )
  return { overlays, rotations, attachments }
}
