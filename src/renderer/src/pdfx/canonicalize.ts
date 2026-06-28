// pdfx-canon/1 — a SEMANTIC canonical hash of decoded page content (PRD §4.6). pdf-lib's save() is
// not byte-deterministic (random font/object suffixes, rewritten dates, object streams, source /ID),
// so the integrity gate must NOT hash file bytes. Instead, per page we hash: a domain prefix + page
// index, the geometry (MediaBox / effective CropBox / normalized Rotate) under canonical number
// formatting, and the content streams Flate-decoded and re-tokenized (numbers canonicalized, strings
// length-tagged, operators/names verbatim, whitespace collapsed). This is invariant to compression,
// object numbering, whitespace, and date/ID drift.
//
// Scope: covers geometry + content-stream tokens (the load-bearing visible content for PDFx's copied
// pages). Resource-program hashing (re-embedded fonts/images) and exotic content (Type3, tiling
// patterns, OCG) remain out of scope, so tampering confined to those is not yet detected. This now
// drives a HARD tamper gate on open (compareIntegrity): a definite mismatch blocks auto-loading the
// saved edits and prompts the user, rather than only warning.
import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFStream } from 'pdf-lib'
import { unzlibSync } from 'fflate'

export const CANON_ALG = 'pdfx-canon/1'
const DOMAIN = 'pdfx-canon/1\n'
const enc = new TextEncoder()

export interface IntegrityRecord {
  canonAlg: string
  flattenedSha256: string
  pageHashes: string[]
}

/** Canonical number: round to 1e-4, fixed-then-trimmed decimals, -0 → 0. */
export function canonicalNumber(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const r = Math.round(n * 1e4) / 1e4
  if (r === 0) return '0'
  return r.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}

const isWS = (c: number): boolean =>
  c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32
const isDelim = (c: number): boolean =>
  c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125

/** Re-tokenize a decoded content stream into canonical bytes (whitespace-collapsed, numbers
 *  canonicalized, literal/hex strings length-tagged, names/operators verbatim). */
function canonTokens(bytes: Uint8Array, out: number[]): void {
  const push = (s: string): void => {
    for (const b of enc.encode(s)) out.push(b)
  }
  const pushBytes = (b: Uint8Array): void => {
    for (const x of b) out.push(x)
  }
  const n = bytes.length
  let i = 0
  while (i < n) {
    const c = bytes[i]
    if (isWS(c)) {
      i++
      continue
    }
    if (c === 0x25) {
      // comment → to EOL
      while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i++
      continue
    }
    if (c === 0x28) {
      // ( literal string )
      let depth = 1
      let j = i + 1
      for (; j < n && depth > 0; j++) {
        if (bytes[j] === 0x5c)
          j++ // escape — skip next
        else if (bytes[j] === 0x28) depth++
        else if (bytes[j] === 0x29 && --depth === 0) break
      }
      const raw = bytes.subarray(i + 1, j)
      push(`(${raw.length}:`)
      pushBytes(raw)
      push(') ')
      i = j + 1
      continue
    }
    if (c === 0x3c) {
      if (bytes[i + 1] === 0x3c) {
        push('<< ')
        i += 2
        continue
      }
      let j = i + 1
      while (j < n && bytes[j] !== 0x3e) j++
      push('<')
      pushBytes(bytes.subarray(i + 1, j))
      push('> ')
      i = j + 1
      continue
    }
    if (c === 0x3e) {
      if (bytes[i + 1] === 0x3e) push('>> ')
      i += bytes[i + 1] === 0x3e ? 2 : 1
      continue
    }
    if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) {
      push(String.fromCharCode(c) + ' ')
      i++
      continue
    }
    if (c === 0x2f) {
      // /Name
      let j = i + 1
      while (j < n && !isWS(bytes[j]) && !isDelim(bytes[j]) && bytes[j] !== 0x25) j++
      pushBytes(bytes.subarray(i, j))
      push(' ')
      i = j
      continue
    }
    // number or operator/keyword
    let j = i
    while (j < n && !isWS(bytes[j]) && !isDelim(bytes[j]) && bytes[j] !== 0x25) j++
    const tok = bytes.subarray(i, j)
    const str = String.fromCharCode(...tok)
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(str)) {
      push(canonicalNumber(parseFloat(str)) + ' ')
    } else if (str === 'ID') {
      // inline image: raw data until a whitespace-delimited EI
      push('ID ')
      let k = j + 1
      const start = k
      while (k < n) {
        if (
          bytes[k] === 0x45 &&
          bytes[k + 1] === 0x49 &&
          isWS(bytes[k - 1]) &&
          (k + 2 >= n || isWS(bytes[k + 2]) || isDelim(bytes[k + 2]))
        )
          break
        k++
      }
      push(`img${k - start}: `)
      pushBytes(bytes.subarray(start, k))
      push(' EI ')
      i = k + 2
      continue
    } else {
      pushBytes(tok)
      push(' ')
    }
    i = j
  }
}

/** Decode + concatenate a page's content streams (Flate-inflated; raw passthrough otherwise). */
function decodedContent(page: PDFStream | PDFArray | undefined, doc: PDFDocument): Uint8Array[] {
  const streams: PDFStream[] = []
  if (page instanceof PDFArray) {
    for (let i = 0; i < page.size(); i++) {
      const s = doc.context.lookup(page.get(i))
      if (s instanceof PDFStream) streams.push(s)
    }
  } else if (page instanceof PDFStream) {
    streams.push(page)
  }
  return streams.map((s) => {
    const raw = (s as PDFRawStream).getContents()
    const filter = s.dict.lookup(PDFName.of('Filter'))
    return filter && String(filter).includes('FlateDecode') ? unzlibSync(raw) : raw
  })
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Compute the pdfx-canon/1 integrity record for an assembled PDFDocument. */
export async function computeIntegrity(doc: PDFDocument): Promise<IntegrityRecord> {
  const pages = doc.getPages()
  const pageHashes: string[] = []
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    const m = page.getMediaBox()
    const cb = page.getCropBox()
    const rotate = (((page.getRotation().angle % 360) + 360) % 360) as number
    const head =
      `${DOMAIN}p${i}\n` +
      `media ${[m.x, m.y, m.width, m.height].map(canonicalNumber).join(' ')}\n` +
      `crop ${[cb.x, cb.y, cb.width, cb.height].map(canonicalNumber).join(' ')}\n` +
      `rotate ${rotate}\ncontent\n`
    const out: number[] = Array.from(enc.encode(head))
    for (const chunk of decodedContent(page.node.Contents(), doc)) canonTokens(chunk, out)
    pageHashes.push(await sha256Hex(Uint8Array.from(out)))
  }
  const flat = enc.encode(`${DOMAIN}n${pages.length}\n${pageHashes.join('')}`)
  return { canonAlg: CANON_ALG, flattenedSha256: await sha256Hex(flat), pageHashes }
}

/** Recompute the integrity record over PDF bytes (for the open-side tamper check). */
export async function integrityOf(bytes: Uint8Array): Promise<IntegrityRecord> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  return computeIntegrity(doc)
}

export interface IntegrityComparison {
  /** True only when the content provably differs from what the .pdfx recorded (a tamper signal). */
  tampered: boolean
  /** 1-based page numbers whose hash changed (empty when only the whole-doc hash differs). */
  changedPages: number[]
}

/**
 * Compare a freshly recomputed record (`actual`) against the one a .pdfx embedded (`record`).
 * `tampered` is true ONLY when the algorithm matches AND the content hash differs — an absent record
 * or an unknown algorithm cannot prove tampering, so it is treated as clean. The caller (the import
 * gate) therefore blocks only on a definite mismatch and never on a can't-decide.
 */
export function compareIntegrity(
  actual: IntegrityRecord,
  record: IntegrityRecord | undefined
): IntegrityComparison {
  if (record?.canonAlg !== CANON_ALG) return { tampered: false, changedPages: [] }
  if (actual.flattenedSha256 === record.flattenedSha256)
    return { tampered: false, changedPages: [] }
  // Past here the whole-doc hash already proves a mismatch → tampered. Localize to pages defensively:
  // a malformed/short pageHashes must still report tampered, never throw (which would fail the gate
  // open: checkIntegrity swallows exceptions to CLEAN).
  const recHashes = Array.isArray(record.pageHashes) ? record.pageHashes : []
  const changedPages = actual.pageHashes
    .map((h, i) => (h !== recHashes[i] ? i + 1 : 0))
    .filter((n) => n > 0)
  return { tampered: true, changedPages }
}
