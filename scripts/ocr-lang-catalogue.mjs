// `node scripts/ocr-lang-catalogue.mjs`: regenerate src/main/ocr/lang-manifest.json, the compiled
// catalogue of downloadable OCR languages (DESIGN.md §3.2.5). The app never fetches this catalogue:
// it is built here, reviewed, committed and compiled in. Every hash the app ever trusts for a
// downloaded or installed language file comes from this file.
//
// For each language it downloads the npm registry tarball of @tesseract.js-data/<code>@1.0.0 into a
// fresh temp directory, checks the tarball against the registry's `dist.integrity` (SHA-512), takes
// 4.0.0_best_int/<code>.traineddata.gz out of it, and records the byte count and SHA-256 of the
// gzipped file and of the gunzipped .traineddata. It then fetches the jsDelivr URL the app will use
// and checks that jsDelivr serves exactly the same bytes, so the recorded host is known-good.
//
// Options: `--only rus,jpn` (re-measure a few, keep the rest), `--check` (measure everything and
// fail if the committed file differs; writes nothing). Node 20+ (global fetch). No dependencies.
//
// RTL languages (ara, heb, fas, urd…) are deliberately absent: the RTL gate (§3.7.4) is not
// implemented, so they are not offered.

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const OUT = fileURLToPath(new URL('../src/main/ocr/lang-manifest.json', import.meta.url))
const VERSION = '1.0.0'
const DATA_DIR = '4.0.0_best_int'

/**
 * The catalogue: Tesseract code, English name, native name, ISO 15924 script, BCP 47 tag. The
 * bundled languages (eng, deu, fra, spa) are not listed: engine-manifest.ts holds those.
 */
const LANGS = [
  ['bul', 'Bulgarian', 'Български', 'Cyrl', 'bg'],
  ['cat', 'Catalan', 'Català', 'Latn', 'ca'],
  ['ces', 'Czech', 'Čeština', 'Latn', 'cs'],
  ['chi_sim', 'Chinese (Simplified)', '简体中文', 'Hans', 'zh-Hans'],
  ['chi_tra', 'Chinese (Traditional)', '繁體中文', 'Hant', 'zh-Hant'],
  ['dan', 'Danish', 'Dansk', 'Latn', 'da'],
  ['ell', 'Greek', 'Ελληνικά', 'Grek', 'el'],
  ['est', 'Estonian', 'Eesti', 'Latn', 'et'],
  ['fin', 'Finnish', 'Suomi', 'Latn', 'fi'],
  ['hin', 'Hindi', 'हिन्दी', 'Deva', 'hi'],
  ['hrv', 'Croatian', 'Hrvatski', 'Latn', 'hr'],
  ['hun', 'Hungarian', 'Magyar', 'Latn', 'hu'],
  ['ind', 'Indonesian', 'Bahasa Indonesia', 'Latn', 'id'],
  ['ita', 'Italian', 'Italiano', 'Latn', 'it'],
  ['jpn', 'Japanese', '日本語', 'Jpan', 'ja'],
  ['kor', 'Korean', '한국어', 'Kore', 'ko'],
  ['lav', 'Latvian', 'Latviešu', 'Latn', 'lv'],
  ['lit', 'Lithuanian', 'Lietuvių', 'Latn', 'lt'],
  ['nld', 'Dutch', 'Nederlands', 'Latn', 'nl'],
  ['nor', 'Norwegian', 'Norsk', 'Latn', 'no'],
  ['pol', 'Polish', 'Polski', 'Latn', 'pl'],
  ['por', 'Portuguese', 'Português', 'Latn', 'pt'],
  ['ron', 'Romanian', 'Română', 'Latn', 'ro'],
  ['rus', 'Russian', 'Русский', 'Cyrl', 'ru'],
  ['slk', 'Slovak', 'Slovenčina', 'Latn', 'sk'],
  ['slv', 'Slovenian', 'Slovenščina', 'Latn', 'sl'],
  ['srp', 'Serbian (Cyrillic)', 'Српски', 'Cyrl', 'sr'],
  ['swe', 'Swedish', 'Svenska', 'Latn', 'sv'],
  ['tur', 'Turkish', 'Türkçe', 'Latn', 'tr'],
  ['ukr', 'Ukrainian', 'Українська', 'Cyrl', 'uk'],
  ['vie', 'Vietnamese', 'Tiếng Việt', 'Latn', 'vi']
]

const UA = { 'user-agent': 'pdfx-ocr-lang-catalogue' }
const sha256 = (b) => createHash('sha256').update(b).digest('hex')
const jsdelivr = (code) =>
  `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${code}@${VERSION}/${DATA_DIR}/${code}.traineddata.gz`

async function get(url) {
  const r = await fetch(url, { headers: UA, redirect: 'follow' })
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
  return new Uint8Array(await r.arrayBuffer())
}

/** The one regular file `name` in a (gunzipped) ustar archive. */
function untarOne(tar, name) {
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512)
    if (h.every((b) => b === 0)) break
    const str = (a, b) => new TextDecoder().decode(h.subarray(a, b)).replace(/\0.*$/s, '')
    const size = parseInt(str(124, 136).trim() || '0', 8)
    const prefix = str(345, 500)
    const path = (prefix ? `${prefix}/` : '') + str(0, 100)
    const type = String.fromCharCode(h[156] || 48)
    const start = off + 512
    if (type === '0' && path === name) return tar.slice(start, start + size)
    off = start + Math.ceil(size / 512) * 512
  }
  throw new Error(`${name} is not in the tarball`)
}

async function measure(code, tmp) {
  const meta = JSON.parse(
    new TextDecoder().decode(await get(`https://registry.npmjs.org/@tesseract.js-data/${code}`))
  )
  const dist = meta.versions?.[VERSION]?.dist
  if (!dist?.tarball || !dist.integrity?.startsWith('sha512-'))
    throw new Error(`${code}: no ${VERSION} tarball with a sha512 integrity`)
  const tgz = await get(dist.tarball)
  const integrity = 'sha512-' + createHash('sha512').update(tgz).digest('base64')
  if (integrity !== dist.integrity) throw new Error(`${code}: tarball integrity mismatch`)
  writeFileSync(join(tmp, `${code}-${VERSION}.tgz`), tgz)
  const gz = untarOne(gunzipSync(tgz), `package/${DATA_DIR}/${code}.traineddata.gz`)
  const raw = gunzipSync(gz)
  const url = jsdelivr(code)
  const served = await get(url)
  if (served.length !== gz.length || sha256(served) !== sha256(gz))
    throw new Error(`${code}: jsDelivr serves different bytes than the npm tarball`)
  return {
    bytes: gz.length,
    sha256Gz: sha256(gz),
    rawBytes: raw.length,
    sha256Raw: sha256(raw),
    url
  }
}

async function main() {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const onlyAt = args.indexOf('--only')
  const only = onlyAt >= 0 ? new Set(args[onlyAt + 1].split(',')) : null
  let previous = null
  try {
    previous = JSON.parse(readFileSync(OUT, 'utf8'))
  } catch {
    previous = null
  }
  const prevByCode = new Map((previous?.languages ?? []).map((l) => [l.code, l]))
  const tmp = mkdtempSync(join(tmpdir(), 'pdfx-lang-catalogue-'))
  const languages = []
  try {
    for (const [code, name, nativeName, script, bcp47] of LANGS) {
      let m
      if (only && !only.has(code) && prevByCode.has(code)) {
        const p = prevByCode.get(code)
        m = {
          bytes: p.bytes,
          sha256Gz: p.sha256Gz,
          rawBytes: p.rawBytes,
          sha256Raw: p.sha256Raw,
          url: p.urls[0]
        }
      } else {
        m = await measure(code, tmp)
        console.log(`${code}: ${m.bytes} B gz, ${m.rawBytes} B raw`)
      }
      languages.push({
        code,
        name,
        nativeName,
        script,
        bcp47,
        bytes: m.bytes,
        sha256Gz: m.sha256Gz,
        rawBytes: m.rawBytes,
        sha256Raw: m.sha256Raw,
        urls: [m.url]
      })
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  const out = {
    schema: 1,
    note: 'Generated by scripts/ocr-lang-catalogue.mjs. Compiled into the app; never fetched remotely.',
    source: `npm @tesseract.js-data/<code>@${VERSION}, ${DATA_DIR}/<code>.traineddata.gz`,
    dataVersion: DATA_DIR,
    // The design's PDFx GitHub release mirror ('ocr-data-1') does not exist yet: creating it is the
    // maintainer's call. Once it does, its asset URL templates ("{code}" is replaced) go here and
    // are tried after each language's own urls. The hashes above are checked whichever host serves.
    optionalMirrorsNote:
      'Empty on purpose: the PDFx GitHub release ocr-data-1 does not exist yet. Asset URL templates ({code}) go here once it does; they are tried after each language’s urls, with the same hash checks.',
    optionalMirrors: previous?.optionalMirrors ?? [],
    languages
  }
  const text = JSON.stringify(out, null, 2) + '\n'
  if (check) {
    const now = JSON.stringify({ ...out, optionalMirrors: [] })
    const was = JSON.stringify({ ...previous, optionalMirrors: [] })
    if (now !== was) {
      console.error('lang-manifest.json is out of date: run node scripts/ocr-lang-catalogue.mjs')
      process.exit(1)
    }
    console.log('lang-manifest.json matches the registry')
    return
  }
  writeFileSync(OUT, text)
  console.log(`wrote ${OUT} (${languages.length} languages)`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
