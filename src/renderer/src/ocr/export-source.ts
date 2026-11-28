// What useExport needs from the OCR side (DESIGN.md §3.7.1), as an injectable interface so the
// export wiring can land and be tested before the store exists. The real implementation is the
// renderer OCR store (`ocr-store.ts`, PR7b); until then `noOcrExportSource` is used, which never
// adds a layer.

import type { PackedOcrPage } from '../../../shared/ocr/types'
import type { EditLayer } from '../pdfx/build'
import type { DocEntry } from '../types'

export interface OcrExportSource {
  /**
   * Called BEFORE the save dialog and before `busy` is raised, whenever recognised text would be
   * included. While recognition is still running for `docs` it asks "Text recognition is still
   * running (5 of 12 pages)…" [Wait and export] [Export now] [Cancel]; waiting shows the OCR pill's
   * progress, never the App busy overlay. Resolves false on Cancel (the export does not happen),
   * true otherwise (immediately when nothing is running).
   */
  flushOrConfirm(docs: DocEntry[]): Promise<boolean>
  /**
   * The recognised pages of `docs` by page key, with the edit history's Replace/Remove choices
   * (`editLayer.ocrSelect`) applied by `applyOcrSelections` (ocr-select.ts); undefined when there
   * are none. Called after the save path is chosen; the result goes through `withOcrLayer`
   * (ocr-export.ts) before any build. The choices themselves stay on the layer: the bake drops a
   * reopened page's own PDFx OCR layer wherever one is recorded (build.ts `dropsSourceOcr`).
   */
  snapshotFor(docs: DocEntry[], editLayer: EditLayer): Map<string, PackedOcrPage> | undefined
  /** The persistent "Include Recognized Text When Exporting" setting (`ocr.includeInExports`, D7). */
  includeInExports(): boolean
}

/** No OCR results anywhere: nothing to wait for, nothing to include. */
export const noOcrExportSource: OcrExportSource = {
  flushOrConfirm: async () => true,
  snapshotFor: () => undefined,
  includeInExports: () => true
}
