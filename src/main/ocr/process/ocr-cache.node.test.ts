// The replay cache's own hygiene (DESIGN.md §3.9.3), engine-free: every file belongs to a known
// spec (no orphans), every spec has exactly one entry, recorded from the input the spec produces
// today (a stale input hash is an orphan too), each entry's hOCR matches its recorded SHA-256 and
// parses, and CACHE_INFO.json names this engine. Tier 1 (engine.ocr.test.ts) checks the live engine
// against the entries.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { hocrToRaw, parseHocr } from '../../../shared/ocr/hocr'
import { hocrPage } from '../../../shared/ocr/test-utils/hocr-pages'
import { loadNodeSynthDeps } from '../../../shared/ocr/test-utils/node-deps'
import { synthesize } from '../../../shared/ocr/test-utils/synth'
import {
  ALL_SPECS,
  CACHE_DIR,
  STRICT,
  cacheFiles,
  currentCacheInfo,
  decodeEntry,
  entryName,
  inputKey,
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

  it('every entry was recorded from the input its spec produces today (a stale one is an orphan)', async () => {
    // Synth and the hOCR pages are deterministic and engine-free, so tier 0 can rebuild each input
    // and check the entry's recorded PGM hash and name: otherwise a synth or degrade change would
    // leave tier 0 replaying hOCR for a page that no longer exists, and outside strict mode tier 1
    // would only warn.
    const deps = await loadNodeSynthDeps()
    const stale: string[] = []
    for (const spec of ALL_SPECS) {
      const { img, dpi } =
        spec.kind === 'synth'
          ? await synthesize({ preset: spec.preset, seed: spec.seed, font: spec.font }, deps).then(
              (r) => ({ img: r.raster, dpi: r.gt.dpi })
            )
          : await hocrPage(spec.id, deps.rasterize).then((p) => ({ img: p.raster, dpi: p.dpi }))
      const key = inputKey(img, dpi, spec.langs)
      const file = cacheFiles().find((f) => isEntryOf(f, spec.id))
      const e = readEntryById(spec.id)
      if (
        file !== entryName(spec.id, key.sha8) ||
        e.input.pgmSha256 !== key.pgmSha256 ||
        e.input.width !== img.width ||
        e.input.height !== img.height ||
        e.input.dpi !== dpi ||
        JSON.stringify(e.params) !== JSON.stringify(key.params)
      )
        stale.push(spec.id)
    }
    expect(stale, 'entries recorded for an input their spec no longer produces').toEqual([])
  }, 120_000)

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
