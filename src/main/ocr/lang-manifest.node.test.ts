// The compiled language catalogue (src/main/ocr/lang-manifest.json, PR9, DESIGN.md §3.2.5): every
// entry carries what the download, Install from file… and the engine's hash rule need (both sizes,
// both SHA-256s, a host), no RTL language is offered while the RTL gate (§3.7.4) is not
// implemented, and nothing overlaps the bundled four. scripts/ocr-lang-catalogue.mjs regenerates it
// from the npm registry; `node scripts/ocr-lang-catalogue.mjs --check` re-measures.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { bcp47FromTesseract } from '../../shared/ocr/lang'
import { LANG_RE } from '../../shared/ocr/protocol'
import { CJK_SCRIPTS, INSTALL_MAX_BYTES } from '../../shared/ocr/lang-packs'
import {
  BUNDLED_LANGS,
  LANG_CATALOGUE,
  LANG_MIRRORS,
  catalogueEntry,
  manifestDataFor
} from './process/engine-manifest'

const HEX64 = /^[0-9a-f]{64}$/

/** SHA-256 of the `languages` array as JSON (the generator prints the same digest). */
const languagesDigest = (languages: unknown): string =>
  createHash('sha256').update(JSON.stringify(languages)).digest('hex')
/**
 * The reviewed catalogue's digest [measured: `node scripts/ocr-lang-catalogue.mjs --check` passed
 * against the npm registry and jsDelivr on 2026-11-28].
 */
const LANGUAGES_SHA256 = 'ccd408f97faa5a40bb66e145a76093c051e301f3b7965017c5b3ab7099f979c8'
/** Right-to-left languages Tesseract has data for; none may be listed before the RTL gate. */
const RTL_CODES = ['ara', 'heb', 'fas', 'urd', 'yid', 'syr', 'pus', 'snd', 'uig', 'div', 'kur']
const RTL_SCRIPTS = ['Arab', 'Hebr', 'Syrc', 'Thaa', 'Nkoo', 'Adlm']

describe('lang-manifest.json', () => {
  it('lists the catalogue languages the design names, once each', () => {
    const codes = LANG_CATALOGUE.map((l) => l.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const c of [
      'ita',
      'por',
      'nld',
      'pol',
      'ces',
      'swe',
      'dan',
      'nor',
      'fin',
      'tur',
      'ell',
      'ukr',
      'rus',
      'kor',
      'chi_sim',
      'chi_tra',
      'jpn',
      'hin'
    ])
      expect(codes).toContain(c)
    for (const b of BUNDLED_LANGS) expect(codes).not.toContain(b)
  })

  it('offers no right-to-left language (the RTL gate is not implemented)', () => {
    for (const l of LANG_CATALOGUE) {
      expect(RTL_CODES).not.toContain(l.code)
      expect(RTL_SCRIPTS).not.toContain(l.script)
    }
  })

  it('every entry has names, script, BCP 47, both sizes, both hashes and a host', () => {
    for (const l of LANG_CATALOGUE) {
      expect(l.code, l.code).toMatch(LANG_RE)
      expect(l.name.length, l.code).toBeGreaterThan(0)
      expect(l.nativeName.length, l.code).toBeGreaterThan(0)
      expect(['Latn', 'Cyrl', 'Grek', 'Hans', 'Hant', 'Jpan', 'Kore', 'Deva']).toContain(l.script)
      // The text layer's /Lang comes from lang.ts: the catalogue must agree with it.
      expect(l.bcp47, l.code).toBe(bcp47FromTesseract(l.code))
      expect(Number.isInteger(l.bytes) && l.bytes > 100_000, l.code).toBe(true)
      expect(l.bytes, l.code).toBeLessThan(INSTALL_MAX_BYTES)
      expect(Number.isInteger(l.rawBytes) && l.rawBytes > l.bytes, l.code).toBe(true)
      expect(l.sha256Gz, l.code).toMatch(HEX64)
      expect(l.sha256Raw, l.code).toMatch(HEX64)
      expect(l.sha256Gz).not.toBe(l.sha256Raw)
      expect(l.urls.length, l.code).toBeGreaterThan(0)
      for (const u of l.urls) {
        const url = new URL(u)
        expect(url.protocol).toBe('https:')
        // A versioned, immutable URL: the package version is pinned in the path.
        expect(url.pathname).toContain(`@tesseract.js-data/${l.code}@1.0.0/4.0.0_best_int/`)
      }
    }
    const hashes = LANG_CATALOGUE.flatMap((l) => [l.sha256Gz, l.sha256Raw])
    expect(new Set(hashes).size).toBe(hashes.length)
  })

  it('records the sizes the design measured', () => {
    // §3.2.5: rus 2.68, chi_sim 1.72, jpn 2.03 MB [measured, PR0].
    expect(catalogueEntry('rus')!.bytes).toBe(2_679_598)
    expect((catalogueEntry('chi_sim')!.bytes / 1e6).toFixed(2)).toBe('1.72')
    expect((catalogueEntry('jpn')!.bytes / 1e6).toFixed(2)).toBe('2.03')
    // And a few more from the generator's measured run (gz, raw).
    const sizes: Record<string, [number, number]> = {
      ita: [1_660_998, 3_126_172],
      pol: [2_642_356, 5_426_310],
      ukr: [2_114_206, 4_365_622],
      ell: [1_324_749, 2_121_037],
      kor: [1_572_336, 2_208_378],
      hin: [1_389_692, 1_651_097]
    }
    for (const [code, [gz, raw]] of Object.entries(sizes))
      expect([catalogueEntry(code)!.bytes, catalogueEntry(code)!.rawBytes], code).toEqual([gz, raw])
  })

  it('is the reviewed catalogue: any edit to its languages needs a second, deliberate change here', () => {
    // The trust root: every hash PDFx accepts for a downloaded or installed file. Regenerating it
    // (`node scripts/ocr-lang-catalogue.mjs`, which prints this digest; `--check` re-measures from
    // the npm registry and jsDelivr) or editing it by hand changes this digest, so a bad hash or
    // size cannot ship green. Update it only with a re-measured, reviewed lang-manifest.json.
    const raw = JSON.parse(
      readFileSync(new URL('./lang-manifest.json', import.meta.url), 'utf8')
    ) as { languages: unknown }
    expect(languagesDigest(raw.languages)).toBe(LANGUAGES_SHA256)
  })

  it('every language has the script, names and tag of the generator’s table', () => {
    // scripts/ocr-lang-catalogue.mjs is the reviewed source of (code, name, native, script, tag).
    const script = readFileSync(
      new URL('../../../scripts/ocr-lang-catalogue.mjs', import.meta.url),
      'utf8'
    )
    const rows = [
      ...script.matchAll(/^\s*\['([a-z_]+)', '([^']+)', '([^']+)', '(\w{4})', '([\w-]+)'\],?$/gm)
    ].map((m) => m.slice(1, 6))
    expect(rows.length).toBe(LANG_CATALOGUE.length)
    expect(LANG_CATALOGUE.map((l) => [l.code, l.name, l.nativeName, l.script, l.bcp47])).toEqual(
      rows
    )
  })

  it('exactly the four CJK languages carry a CJK script (their labels warn about photos)', () => {
    const cjk = Object.fromEntries(
      LANG_CATALOGUE.filter((l) => CJK_SCRIPTS.has(l.script)).map((l) => [l.code, l.script])
    )
    expect(cjk).toEqual({ chi_sim: 'Hans', chi_tra: 'Hant', jpn: 'Jpan', kor: 'Kore' })
  })

  it('has an empty, clearly named optional mirror list (no GitHub release exists yet)', () => {
    const raw = JSON.parse(
      readFileSync(new URL('./lang-manifest.json', import.meta.url), 'utf8')
    ) as Record<string, unknown>
    expect(raw.optionalMirrors).toEqual([])
    expect(String(raw.optionalMirrorsNote)).toMatch(/ocr-data-1/)
    expect(LANG_MIRRORS).toEqual([])
  })

  it('the engine-manifest check covers the catalogue, and nothing else', () => {
    expect(manifestDataFor('eng')?.sha256).toBe(
      '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91'
    )
    for (const l of LANG_CATALOGUE)
      expect(manifestDataFor(l.code)).toMatchObject({
        bytes: l.bytes,
        sha256: l.sha256Gz,
        rawBytes: l.rawBytes,
        rawSha256: l.sha256Raw
      })
    for (const c of ['ara', 'heb', 'xxx', '__proto__', 'constructor'])
      expect(manifestDataFor(c)).toBeUndefined()
  })
})
