// Node-side loading of the Tesseract core and data (DESIGN.md §3.2.2, §3.2.6), shared by the
// coordinator, the recognize thread and the tier-1 tests. Every byte is checked against the compiled
// manifest (engine-manifest.ts) before it is compiled, required or handed to the engine.
//
// - The .wasm is read and SHA-checked once per process, compiled once, and the WebAssembly.Module is
//   posted to every recognize thread (one artifact, checked once).
// - The glue (.js) is SHA-checked in the realm that runs it, immediately before it is require()d
//   from the same directory (`loadGlue`).
// - Each traineddata.gz is SHA-checked in the coordinator, kept in a SharedArrayBuffer (posted to
//   threads without a copy), gunzipped with fflate in the thread and the raw bytes checked again.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'fflate'

import { OcrError, type OcrPaths } from '../../../shared/ocr/protocol'
import type { TessFactory } from '../../../shared/ocr/engine/tess-core'
import type { LoadedEngine } from './coordinator'
import {
  ENGINE_CORE,
  manifestDataFor,
  type ManifestData,
  type ManifestFile
} from './engine-manifest'

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Throws OcrError('init') unless `bytes` are exactly the manifest's. Never echoes a path. */
export function verifyBytes(
  bytes: Uint8Array,
  want: Pick<ManifestFile, 'bytes' | 'sha256'>,
  what: string
): void {
  if (bytes.byteLength !== want.bytes)
    throw new OcrError('init', `${what}: size ${bytes.byteLength}, expected ${want.bytes}`)
  if (sha256Hex(bytes) !== want.sha256) throw new OcrError('init', `${what}: SHA-256 mismatch`)
}

/** Read a file and verify it; the returned bytes are the verified ones. */
export async function readVerified(
  path: string,
  want: Pick<ManifestFile, 'bytes' | 'sha256'>,
  what: string
): Promise<Uint8Array<ArrayBuffer>> {
  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = new Uint8Array(await readFile(path))
  } catch {
    throw new OcrError('init', `${what}: not readable`)
  }
  verifyBytes(bytes, want, what)
  return bytes
}

/** Read, verify and compile the core (the coordinator does this once per process). */
export async function compileCore(coreDir: string): Promise<WebAssembly.Module> {
  const bytes = await readVerified(join(coreDir, ENGINE_CORE.wasm.file), ENGINE_CORE.wasm, 'core')
  return WebAssembly.compile(bytes)
}

/**
 * The glue's factory, require()d from `coreDir` after its bytes were checked in this realm. The
 * require names a literal file relative to `coreDir`, never a computed module name.
 */
export function loadGlue(coreDir: string): TessFactory {
  const file = join(coreDir, ENGINE_CORE.js.file)
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(readFileSync(file))
  } catch {
    throw new OcrError('init', 'glue: not readable')
  }
  verifyBytes(bytes, ENGINE_CORE.js, 'glue')
  const factory = createRequire(pathToFileURL(file))('./tesseract-core-simd-lstm.js') as unknown
  if (typeof factory !== 'function') throw new OcrError('init', 'glue: no factory export')
  return factory as TessFactory
}

/** A gzip member starts 1f 8b; a .traineddata never does (it starts with its component count). */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

/**
 * Read and verify one language's data into a SharedArrayBuffer: a `.traineddata.gz` against the
 * manifest's gzipped size and SHA-256, a raw `.traineddata` (Install from file... keeps the raw file
 * when that is what matched, section 3.2.5) against the raw ones. Bundled languages and the
 * catalogue alike (`manifestDataFor`); any other language is refused before a byte is read.
 */
export async function loadTraineddataGz(lang: string, path: string): Promise<SharedArrayBuffer> {
  const want = manifestDataFor(lang)
  if (!want) throw new OcrError('init', `no manifest entry for ${lang}`)
  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = new Uint8Array(await readFile(path))
  } catch {
    throw new OcrError('init', `traineddata ${lang}: not readable`)
  }
  if (isGzip(bytes)) verifyBytes(bytes, want, `traineddata ${lang}`)
  else verifyBytes(bytes, { bytes: want.rawBytes, sha256: want.rawSha256 }, `traineddata ${lang}`)
  const sab = new SharedArrayBuffer(bytes.byteLength)
  new Uint8Array(sab).set(bytes)
  return sab
}

/**
 * A downloaded or installed language for a running coordinator (PR9): its verified bytes and the
 * SHA-256 that goes into every page's `dataHashes` (always the catalogue's gzipped hash, so one
 * language has one identity whichever form is on disk).
 */
export async function loadLanguage(
  lang: string,
  path: string
): Promise<{ data: SharedArrayBuffer; sha256: string }> {
  const data = await loadTraineddataGz(lang, path)
  return { data, sha256: manifestDataFor(lang)!.sha256 }
}

/**
 * The coordinator's engine load (once per process): verify and compile the core, verify the glue
 * once here too (so a bad file fails `init` at once rather than in every thread), and verify each
 * bundled language's data. Any mismatch rejects with OcrError('init'): OCR is off, never degraded.
 */
export async function loadEngine(paths: OcrPaths): Promise<LoadedEngine> {
  const module = await compileCore(paths.ocrCore)
  await readVerified(join(paths.ocrCore, ENGINE_CORE.js.file), ENGINE_CORE.js, 'glue')
  const data: Record<string, SharedArrayBuffer> = {}
  const dataHashes: Record<string, string> = {}
  for (const [lang, path] of Object.entries(paths.tessdata)) {
    data[lang] = await loadTraineddataGz(lang, path)
    dataHashes[lang] = manifestDataFor(lang)!.sha256
  }
  return { assets: { module, coreDir: paths.ocrCore, data }, dataHashes }
}

/**
 * Gunzip a verified .traineddata.gz and check the raw bytes too (in the thread that uses them).
 * `want` defaults to the manifest's entry (tests pass their own to reach the raw check).
 */
export function gunzipTraineddata(
  lang: string,
  gz: Uint8Array,
  want: ManifestData | undefined = manifestDataFor(lang)
): Uint8Array {
  if (!want) throw new OcrError('init', `no manifest entry for ${lang}`)
  if (!isGzip(gz)) {
    // A raw .traineddata (installed from a file as-is): only the raw check applies.
    const raw = gz.buffer instanceof SharedArrayBuffer ? new Uint8Array(gz) : gz
    verifyBytes(raw, { bytes: want.rawBytes, sha256: want.rawSha256 }, `traineddata ${lang} (raw)`)
    return raw
  }
  verifyBytes(gz, want, `traineddata ${lang}`)
  // fflate's gunzipSync wants a plain Uint8Array; a SharedArrayBuffer view is copied first.
  const plain = gz.buffer instanceof SharedArrayBuffer ? new Uint8Array(gz) : gz
  let raw: Uint8Array
  try {
    raw = gunzipSync(plain)
  } catch {
    throw new OcrError('init', `traineddata ${lang}: not a valid gzip`)
  }
  verifyBytes(raw, { bytes: want.rawBytes, sha256: want.rawSha256 }, `traineddata ${lang} (raw)`)
  return raw
}
