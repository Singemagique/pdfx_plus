// The OCR replay cache, with this app's engine: the manifest's hashes for CACHE_INFO.json. The cache
// format and the spec lists live in src/shared/ocr/test-utils/ocr-replay.ts (shared tier-0 tests
// replay it too).

import { mkdirSync, writeFileSync } from 'node:fs'

import {
  CACHE_DIR,
  CACHE_INFO_FILE,
  cacheInfoFor,
  type CacheInfo
} from '../../../shared/ocr/test-utils/ocr-replay'
import { ENGINE_CORE, ENGINE_DATA } from '../process/engine-manifest'

export * from '../../../shared/ocr/test-utils/ocr-replay'

/** CACHE_INFO for the engine files the manifest pins. */
export function currentCacheInfo(): CacheInfo {
  return cacheInfoFor({
    coreSha256: ENGINE_CORE.wasm.sha256,
    glueSha256: ENGINE_CORE.js.sha256,
    dataSha256: Object.fromEntries(Object.entries(ENGINE_DATA).map(([l, d]) => [l, d.sha256]))
  })
}

export function writeCacheInfo(): void {
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(CACHE_INFO_FILE, JSON.stringify(currentCacheInfo(), null, 2) + '\n')
}
