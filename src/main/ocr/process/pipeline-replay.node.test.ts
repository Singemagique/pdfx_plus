// Tier 0 (DESIGN.md §3.9.3): the PR6 pipeline replayed without the engine. Each recorded tier-1
// page (pipeline-cache.ts) runs through the same harness as tier 1 (PDFium triage, triage DPI,
// PDFium raster, preprocessing, orientation, deskew, the pass plan, the adaptive re-render,
// mapping) with a recognizer that answers from the recording and checks every call asks for
// exactly the recorded input (parameters, size and pixels). So a change to any engine-free step
// fails here, deterministically, and the outcome (orientation, skew, kept pass, words) must be the
// recorded one.

import { describe, expect, it } from 'vitest'

import { loadNodeSynthDeps } from '../../../shared/ocr/test-utils/node-deps'
import '../../../shared/ocr/test-utils/quality-presets'
import { synthesize } from '../../../shared/ocr/test-utils/synth'
import { pageHarness } from '../test-utils/page-harness'
import { readPipelineEntryById, replayRecognizer } from '../test-utils/pipeline-cache'

const REPLAYED = [
  'clean300',
  'skew2',
  'rot180page',
  'rot90page',
  'noise',
  'photoLike',
  'border-scan',
  'smallprint6pt',
  'numbers-table'
]

describe('the PR6 pipeline replays its recordings exactly', () => {
  it.each(REPLAYED)(
    '%s',
    async (id) => {
      const entry = readPipelineEntryById(id)
      const deps = await loadNodeSynthDeps()
      const r = await synthesize({ preset: entry.spec.preset, seed: entry.spec.seed }, deps)
      const rec = replayRecognizer(entry)
      const harness = await pageHarness(rec)
      const run = await harness.run(r.pdfBytes, r.gt.page, { langs: entry.spec.langs })
      expect(rec.remaining()).toBe(0)
      expect({
        orientation: run.page.orientation,
        skewDeg: run.page.skewDeg,
        kept: run.kept,
        keptDpi: run.raster.dpi,
        words: run.page.lines.reduce((n, l) => n + l.words.length, 0)
      }).toEqual(entry.outcome)
      expect([run.firstRaster.width, run.firstRaster.height, run.firstRaster.dpi]).toEqual([
        entry.firstRaster.width,
        entry.firstRaster.height,
        entry.firstRaster.dpi
      ])
    },
    60_000
  )
})
