// The OCR record/replay cache (DESIGN.md §3.9.3): `src/shared/ocr/test-utils/ocr-cache/v1/
// <spec>-<sha8>.json` holds the engine's raw hOCR for each recorded input, and `CACHE_INFO.json`
// the engine configuration it was recorded with. Tier-0 tests replay the hOCR through the parser
// and mapping without the engine; tier 1 checks the live engine still produces it.
//
// - `<sha8>` is the first 8 hex digits of SHA-256(input PGM SHA-256, languages, parameters): the
//   input the engine saw, so a changed raster is a new entry, never a silent overwrite.
// - The hOCR is stored zlib-compressed and base64-encoded (it is 30–450 KB of markup per page; the
//   cache stays small enough to commit) with its SHA-256 so a corrupt entry cannot pass.
// - `PDFX_OCR_CACHE_STRICT=1` turns every replay mismatch (and a CACHE_INFO mismatch) into a test
//   failure; `yarn ocr:record` regenerates everything.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strFromU8, strToU8, unzlibSync, zlibSync } from 'fflate'

import {
  ENGINE_ID,
  PIPELINE_VERSION,
  configHashInput,
  encodePgm,
  fullPageParams,
  type TessParams
} from '../engine/tess-core'
import type { GrayImage } from '../engine/types'
import type { FontId } from './synth'
import { HOCR_PAGE_IDS, type HocrPageId } from './hocr-pages'

export const CACHE_DIR = fileURLToPath(new URL('./ocr-cache/v1/', import.meta.url))
export const CACHE_INFO_FILE = join(CACHE_DIR, 'CACHE_INFO.json')

export const STRICT = process.env.PDFX_OCR_CACHE_STRICT === '1'
export const RECORD = process.env.PDFX_OCR_RECORD === '1'

/** One recorded input: a synth preset (tier-1 accuracy) or an hOCR line-class page (parser). */
export type CacheSpec =
  | { id: string; kind: 'synth'; preset: string; seed: number; font?: FontId; langs: string[] }
  | { id: HocrPageId; kind: 'hocr-page'; langs: string[] }

const synth = (preset: string, langs = ['eng']): CacheSpec => ({
  id: preset,
  kind: 'synth',
  preset,
  seed: 1,
  langs
})

/** Every PR1 preset at seed 1 (the tier-1 gate set), eng unless the text needs others. */
export const TIER1_SPECS: CacheSpec[] = [
  synth('clean300'),
  synth('skew2'),
  synth('blur1'),
  synth('noise'),
  synth('jpeg35'),
  synth('fax200'),
  synth('low150'),
  synth('rot90page'),
  synth('rot180page'),
  synth('photoLike'),
  synth('twocol'),
  synth('smallprint6pt'),
  synth('numbers-table'),
  synth('latin-diacritics', ['deu', 'fra', 'spa'])
]

export const HOCR_PAGE_SPECS: CacheSpec[] = HOCR_PAGE_IDS.map((id) => ({
  id,
  kind: 'hocr-page' as const,
  langs: ['eng']
}))

export const ALL_SPECS: CacheSpec[] = [...TIER1_SPECS, ...HOCR_PAGE_SPECS]

export interface CacheInfo {
  engineId: string
  coreSha256: string
  glueSha256: string
  dataSha256: Record<string, string>
  /** Pass 1's parameters (`user_defined_dpi` is per entry). */
  params: Omit<TessParams, 'user_defined_dpi'>
  PIPELINE_VERSION: number
  configHash: string
}

const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex')

/** The CACHE_INFO a recording with these engine files would write (the manifest's hashes). */
export function cacheInfoFor(files: {
  coreSha256: string
  glueSha256: string
  dataSha256: Record<string, string>
}): CacheInfo {
  const { user_defined_dpi: _dpi, ...params } = fullPageParams(300)
  const { coreSha256, glueSha256, dataSha256 } = files
  return {
    engineId: ENGINE_ID,
    coreSha256,
    glueSha256,
    dataSha256,
    params,
    PIPELINE_VERSION,
    configHash: sha256(
      configHashInput({
        engineId: ENGINE_ID,
        coreSha256,
        dataSha256,
        pipelineVersion: PIPELINE_VERSION,
        params: { ...params }
      })
    )
  }
}

export interface CacheEntry {
  v: 1
  spec: CacheSpec
  input: { width: number; height: number; dpi: number; pgmSha256: string }
  langs: string[]
  params: TessParams
  hocrSha256: string
  /** zlib + base64 of the UTF-8 hOCR. */
  hocrZlib: string
}

export function inputKey(
  img: GrayImage,
  dpi: number,
  langs: string[]
): {
  pgmSha256: string
  sha8: string
  params: TessParams
} {
  const pgmSha256 = sha256(encodePgm(img))
  const params = fullPageParams(dpi)
  const sha8 = sha256(`${pgmSha256}\n${langs.join('+')}\n${JSON.stringify(params)}`).slice(0, 8)
  return { pgmSha256, sha8, params }
}

export const entryName = (id: string, sha8: string): string => `${id}-${sha8}.json`

/** The recorded hOCR for this spec and input, or null if there is none (or it is for other input). */
export function readEntry(
  spec: CacheSpec,
  img: GrayImage,
  dpi: number
): { hocr: string; file: string } | null {
  const { sha8 } = inputKey(img, dpi, spec.langs)
  const file = join(CACHE_DIR, entryName(spec.id, sha8))
  if (!existsSync(file)) return null
  return { hocr: decodeEntry(JSON.parse(readFileSync(file, 'utf8')) as CacheEntry), file }
}

/** The recorded entry for a spec id, whatever its input hash (tier-0 replays). */
export function readEntryById(id: string): CacheEntry {
  const files = cacheFiles().filter((f) => isEntryOf(f, id))
  if (files.length !== 1)
    throw new Error(`expected one cache entry for ${id}, found ${files.length}`)
  return JSON.parse(readFileSync(join(CACHE_DIR, files[0]), 'utf8')) as CacheEntry
}

/** Is `file` an entry name of spec `id` (`<id>-<8 hex>.json`)? */
export function isEntryOf(file: string, id: string): boolean {
  return file.startsWith(`${id}-`) && /^[0-9a-f]{8}\.json$/.test(file.slice(id.length + 1))
}

export function decodeEntry(e: CacheEntry): string {
  const hocr = strFromU8(unzlibSync(Uint8Array.from(Buffer.from(e.hocrZlib, 'base64'))))
  if (sha256(hocr) !== e.hocrSha256) throw new Error(`cache entry ${e.spec.id} is corrupt`)
  return hocr
}

/** Write (or replace) the entry for `spec`; earlier entries of the same spec are removed. */
export function writeEntry(spec: CacheSpec, img: GrayImage, dpi: number, hocr: string): string {
  mkdirSync(CACHE_DIR, { recursive: true })
  const { pgmSha256, sha8, params } = inputKey(img, dpi, spec.langs)
  for (const f of cacheFiles()) if (isEntryOf(f, spec.id)) rmSync(join(CACHE_DIR, f))
  const entry: CacheEntry = {
    v: 1,
    spec,
    input: { width: img.width, height: img.height, dpi, pgmSha256 },
    langs: spec.langs,
    params,
    hocrSha256: sha256(hocr),
    hocrZlib: Buffer.from(zlibSync(strToU8(hocr), { level: 9 })).toString('base64')
  }
  const name = entryName(spec.id, sha8)
  writeFileSync(join(CACHE_DIR, name), JSON.stringify(entry, null, 2) + '\n')
  return name
}

export function readCacheInfo(): CacheInfo | null {
  return existsSync(CACHE_INFO_FILE)
    ? (JSON.parse(readFileSync(CACHE_INFO_FILE, 'utf8')) as CacheInfo)
    : null
}

/** The entry files in the cache (CACHE_INFO.json excluded). */
export function cacheFiles(): string[] {
  if (!existsSync(CACHE_DIR)) return []
  return readdirSync(CACHE_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'CACHE_INFO.json')
    .sort()
}
