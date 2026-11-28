// The replay cache's own hygiene (DESIGN.md §3.9.3), engine-free: every file belongs to a known
// spec (no orphans), every spec has exactly one entry, each entry's hOCR matches its recorded
// SHA-256 and parses, and CACHE_INFO.json names this engine. Tier 1 (engine.ocr.test.ts) checks the
// live engine against the entries.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { hocrToRaw, parseHocr } from '../../../shared/ocr/hocr'
import {
  ALL_SPECS,
  CACHE_DIR,
  STRICT,
  cacheFiles,
  currentCacheInfo,
  decodeEntry,
  isEntryOf,
  readCacheInfo,
  readEntryById,
  type CacheEntry
} from '../test-utils/ocr-cache'

describe('OCR replay cache', () => {
  it('has no orphaned entries', () => {
    const orphans = cacheFiles().filter((f) => !ALL_SPECS.some((s) => isEntryOf(f, s.id)))
    expect(orphans).toEqual([])
  })

  it('has exactly one entry per spec, each intact and parseable', () => {
    for (const spec of ALL_SPECS) {
      const e = readEntryById(spec.id)
      expect(e.spec).toEqual(spec)
      expect(e.langs).toEqual(spec.langs)
      const raw = hocrToRaw(parseHocr(decodeEntry(e)))
      expect(raw.lines.length, spec.id).toBeGreaterThan(0)
    }
  })

  it('detects a corrupted entry', () => {
    const file = cacheFiles().find((f) => isEntryOf(f, 'clean300'))!
    const e = JSON.parse(readFileSync(join(CACHE_DIR, file), 'utf8')) as CacheEntry
    expect(() => decodeEntry({ ...e, hocrSha256: '0'.repeat(64) })).toThrow(/corrupt/)
  })

  it('CACHE_INFO.json matches this engine (strict: exactly)', () => {
    const info = readCacheInfo()
    expect(info).not.toBeNull()
    expect(info!.engineId).toBe(currentCacheInfo().engineId)
    if (STRICT) expect(info).toEqual(currentCacheInfo())
  })
})
