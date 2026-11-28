// The PR6 pipeline record/replay cache (DESIGN.md §3.9.3): one entry per tier-1 page holds EVERY
// recognition the pipeline ran for it (pass 1, the band reads, the retries, the adaptive pass), in
// order, each with its input size, an FNV-1a of its input pixels, its parameters and its hOCR.
// `src/shared/ocr/test-utils/ocr-cache/v1/pipeline/<spec>-<sha8>.json`, `<sha8>` from the first
// render's PGM SHA-256, the languages and PIPELINE_VERSION.
//
// - Tier 1 (pipeline.ocr.test.ts) checks the live recognitions against the entry: always on
//   clean300, on every page with PDFX_OCR_CACHE_STRICT=1; `yarn ocr:record` rewrites them.
// - Tier 0 (pipeline-replay.node.test.ts) runs the pipeline with `replayRecognizer`, which answers
//   each recognition from the entry after checking it is asked for exactly the recorded input
//   (parameters, size and pixels): a change to preprocessing, geometry or the pass plan fails there
//   without the engine, and must be re-recorded.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { strFromU8, strToU8, unzlibSync, zlibSync } from 'fflate'

import { PIPELINE_VERSION, encodePgm, type TessParams } from '../../../shared/ocr/engine/tess-core'
import type { GrayImage } from '../../../shared/ocr/engine/types'
import { CACHE_DIR } from '../../../shared/ocr/test-utils/ocr-replay'
import { fnv1a, recognizePage, recognizeRawPass1 } from '../process/recognize-core'
import type { RecognizeReply } from './engine-harness'
import type { RecordedRecognition, Recognizer } from './page-harness'

export const PIPELINE_CACHE_DIR = join(CACHE_DIR, 'pipeline')

export interface PipelineSpec {
  id: string
  preset: string
  seed: number
  langs: string[]
  /** The page's edit rotation (the request's), when it has one. */
  editRotation?: 0 | 90 | 180 | 270
}

export interface PipelineEntry {
  v: 1
  spec: PipelineSpec
  pipelineVersion: number
  firstRaster: { width: number; height: number; dpi: number; pgmSha256: string }
  recognitions: Array<{
    phase: 'first' | 'adaptive'
    id: string
    params: TessParams
    width: number
    height: number
    fnv: number
    hocrSha256: string
    hocrZlib: string
  }>
  /** What the page came out as, for the tier-0 replay to compare. */
  outcome: { orientation: number; skewDeg: number; kept: string; keptDpi: number; words: number }
}

const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex')

export function pipelineKey(
  first: GrayImage,
  langs: string[]
): { pgmSha256: string; sha8: string } {
  const pgmSha256 = sha256(encodePgm(first))
  return {
    pgmSha256,
    sha8: sha256(`${pgmSha256}\n${langs.join('+')}\npipeline=${PIPELINE_VERSION}`).slice(0, 8)
  }
}

const isEntryOf = (file: string, id: string): boolean =>
  file.startsWith(`${id}-`) && /^[0-9a-f]{8}\.json$/.test(file.slice(id.length + 1))

export function pipelineFiles(): string[] {
  return existsSync(PIPELINE_CACHE_DIR)
    ? readdirSync(PIPELINE_CACHE_DIR)
        .filter((f) => f.endsWith('.json'))
        .sort()
    : []
}

export function decodeHocr(r: PipelineEntry['recognitions'][number]): string {
  const hocr = strFromU8(unzlibSync(Uint8Array.from(Buffer.from(r.hocrZlib, 'base64'))))
  if (sha256(hocr) !== r.hocrSha256) throw new Error('pipeline cache entry is corrupt')
  return hocr
}

/** The entry for this spec and first raster, or null. */
export function readPipelineEntry(
  spec: PipelineSpec,
  first: GrayImage
): (PipelineEntry & { file: string }) | null {
  const { sha8 } = pipelineKey(first, spec.langs)
  const file = join(PIPELINE_CACHE_DIR, `${spec.id}-${sha8}.json`)
  if (!existsSync(file)) return null
  return { ...(JSON.parse(readFileSync(file, 'utf8')) as PipelineEntry), file }
}

/** The one entry of a spec id, whatever its input (tier-0 replays). */
export function readPipelineEntryById(id: string): PipelineEntry {
  const files = pipelineFiles().filter((f) => isEntryOf(f, id))
  if (files.length !== 1)
    throw new Error(`expected one pipeline entry for ${id}, found ${files.length}`)
  return JSON.parse(readFileSync(join(PIPELINE_CACHE_DIR, files[0]), 'utf8')) as PipelineEntry
}

export function writePipelineEntry(
  spec: PipelineSpec,
  first: GrayImage & { dpi: number },
  recognitions: RecordedRecognition[],
  outcome: PipelineEntry['outcome']
): string {
  mkdirSync(PIPELINE_CACHE_DIR, { recursive: true })
  const { pgmSha256, sha8 } = pipelineKey(first, spec.langs)
  for (const f of pipelineFiles()) if (isEntryOf(f, spec.id)) rmSync(join(PIPELINE_CACHE_DIR, f))
  const entry: PipelineEntry = {
    v: 1,
    spec,
    pipelineVersion: PIPELINE_VERSION,
    firstRaster: { width: first.width, height: first.height, dpi: first.dpi, pgmSha256 },
    recognitions: recognitions.map((r) => ({
      phase: r.phase,
      id: r.id,
      params: r.params,
      width: r.width,
      height: r.height,
      fnv: r.fnv,
      hocrSha256: sha256(r.hocr),
      hocrZlib: Buffer.from(zlibSync(strToU8(r.hocr), { level: 9 })).toString('base64')
    })),
    outcome
  }
  const name = `${spec.id}-${sha8}.json`
  writeFileSync(join(PIPELINE_CACHE_DIR, name), JSON.stringify(entry, null, 2) + '\n')
  return name
}

/**
 * A recognizer that answers from a recorded entry, in order, after checking each call asks for
 * the recorded input. Throws on the first mismatch, naming it.
 */
export function replayRecognizer(entry: PipelineEntry): Recognizer & { remaining(): number } {
  let k = 0
  const engine = {
    recognize(img: GrayImage, params: TessParams): { hocr: string } {
      const r = entry.recognitions[k]
      if (!r) throw new Error(`${entry.spec.id}: recognition ${k} was never recorded`)
      const want = { id: r.id, params: r.params, width: r.width, height: r.height, fnv: r.fnv }
      const got = { id: r.id, params, width: img.width, height: img.height, fnv: fnv1a(img.data) }
      if (JSON.stringify(got) !== JSON.stringify(want))
        throw new Error(
          `${entry.spec.id}: recognition ${k} input differs from the recording: ` +
            `${JSON.stringify(got)} vs ${JSON.stringify(want)}`
        )
      k++
      return { hocr: decodeHocr(r) }
    }
  }
  return {
    remaining: () => entry.recognitions.length - k,
    async recognize(img, dpi, _langs, returnHocr = false, extra = {}): Promise<RecognizeReply> {
      const outcome = extra.rawPass1
        ? recognizeRawPass1(engine, img, dpi, returnHocr)
        : recognizePage(engine, img, dpi, {
            returnHocr,
            reuse: extra.reuse,
            adaptive: extra.adaptive,
            prior: extra.editRotation,
            calibration: extra.calibration,
            now: () => 0
          })
      return { outcome, heap: 0, stderrLines: 0, tripwire: 0 }
    }
  }
}
