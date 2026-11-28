// The recognition configuration a result belongs to (DESIGN.md §3.5.2): the `configHash` the store
// files results under and the edit history's `ocrSelect` op names (Replace / Remove, §3.7.6).
//
// The design's hash is sha256(engineId ‖ coreSha256 ‖ sorted(lang:dataSha256) ‖ PIPELINE_VERSION
// ‖ paramsHash). The renderer must name a config BEFORE any page of it is recognised (a Replace is
// recorded when it is asked for, so an export while it runs can tell it is missing), and it never
// sees the core or language-data hashes until a result arrives. So the key here is the canonical
// text of what the renderer does know and what determines the output on one install: the engine
// id (which pins the core build), the pipeline version (which pins the pass parameters, §3.2.1)
// and the sorted language codes. The data hashes still travel in every result (`dataHashes`) and
// into the .pdfx provenance. It is an opaque identity, never parsed.

import { ENGINE_ID, PIPELINE_VERSION } from '../../../shared/ocr/engine/tess-core'

export interface OcrConfig {
  /** The opaque key results are filed under (`configHash` in edit history and the store). */
  hash: string
  /** Tesseract codes, sorted and distinct. */
  langs: string[]
}

/** The config of a recognition with `langs` on this build of the engine and pipeline. */
export function ocrConfig(langs: readonly string[]): OcrConfig {
  const sorted = [...new Set(langs)].sort()
  return { hash: `${ENGINE_ID}|p${PIPELINE_VERSION}|${sorted.join('+')}`, langs: sorted }
}
