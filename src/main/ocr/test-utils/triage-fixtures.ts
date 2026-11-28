// Test-only: the PR4b triage fixtures (DESIGN.md §3.9.1), built at test time from synth scans
// (src/shared/ocr/test-utils/triage-presets.ts) and from hand-written PDF pieces. Nothing here is
// committed binary data: the bytes are ours, generated on every run.
//
// - `placedScan`: a scan image on any placement matrix, optionally inside nested Form XObjects
//   (rotated-placement, formxobject-scan, skew, non-90° rotation).
// - `stripScan`: the scan cut into horizontal image strips (strip-scan).
// - `imagesPage`: several images, each on its own placement, in drawing order (mrc-scan, a logo
//   before the scan, off-page and cropped images, rotated coverage).
// - `addText`: vector text over a page, visible or invisible (fax-header, near-scanned-bates,
//   ocr-foreign, mixed, text pages), in any render mode.
// - `encryptedScan`: a scan written with the Standard security handler, owner password only
//   (encrypted-owner; R2 RC4-40, R3 RC4-128 and R6 AES-256), ported from the PR0 spike's
//   encrypt.mjs (ISO 32000-1 7.6.3 algorithms 2–5, ISO 32000-2 algorithm 2.B).
// - `jpxPage`, `jpxMaskPage`, `j2k`, `jp2`: a page whose image (optionally Form-nested, or after
//   many other objects), or an image's /SMask, is JPXDecode data we write by hand (SOC + SIZ +
//   EOC, or that codestream in a JP2 wrapper). Triage only ever reads the SIZ, so the codestream
//   needs no tiles; it must never be rendered.

import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { zlibSync } from 'fflate'
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  StandardFonts,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setTextRenderingMode,
  type PDFFont
} from 'pdf-lib'

import '../../../shared/ocr/test-utils/triage-presets'
import type { GreyImage } from '../../../shared/ocr/test-utils/degrade'
import { loadNodeSynthDeps } from '../../../shared/ocr/test-utils/node-deps'
import { synthesize, type SynthResult } from '../../../shared/ocr/test-utils/synth'
import type { Matrix6 } from '../../../shared/ocr/triage'

const scans = new Map<string, Promise<SynthResult>>()

/** A synth scan of `preset` (cached per worker: several fixtures start from the same one). */
export function scan(preset: string, seed = 1): Promise<SynthResult> {
  const key = `${preset}:${seed}`
  let p = scans.get(key)
  if (!p) {
    p = loadNodeSynthDeps().then((deps) => synthesize({ preset, seed }, deps))
    scans.set(key, p)
  }
  return p
}

/** The raster as image samples: 1 bpc when it is pure black/white (like synth's scans), else 8. */
function samples(raster: GreyImage): { bits: number; data: Uint8Array } {
  const { width: w, height: h, data } = raster
  if (!data.every((v) => v === 0 || v === 255)) return { bits: 8, data }
  const rowBytes = (w + 7) >> 3
  const out = new Uint8Array(rowBytes * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (data[y * w + x]) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7)
  return { bits: 1, data: out }
}

/** Register `raster` as a Flate DeviceGray image XObject. */
export function imageXObject(doc: PDFDocument, raster: GreyImage): PDFRef {
  const s = samples(raster)
  return doc.context.register(
    doc.context.stream(zlibSync(s.data, { level: 1 }), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: raster.width,
      Height: raster.height,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: s.bits,
      Filter: 'FlateDecode'
    })
  )
}

const n = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(4))
const cm = (m: Matrix6): string => `${m.map(n).join(' ')} cm`

function setContent(doc: PDFDocument, page: ReturnType<PDFDocument['addPage']>, ops: string): void {
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(ops)))
}

/**
 * One page of `size` pt showing `raster` placed by `place` (the image's cm). With `forms`, the
 * image is drawn inside nested Form XObjects, outermost first, each with that /Matrix; `formCtm`
 * is the CTM at each form's `Do`.
 */
export async function placedScan(
  raster: GreyImage,
  size: { width: number; height: number },
  place: Matrix6,
  forms: { matrix: Matrix6; ctm?: Matrix6 }[] = []
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([size.width, size.height])
  const img = imageXObject(doc, raster)
  let inner = `q ${cm(place)} /Im0 Do Q`
  let resources: PDFDict = doc.context.obj({ XObject: { Im0: img } })
  for (let i = forms.length - 1; i >= 0; i--) {
    const f = forms[i]
    const form = doc.context.register(
      doc.context.stream(inner, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [-20000, -20000, 20000, 20000],
        Matrix: f.matrix,
        Resources: resources
      })
    )
    inner = `q ${f.ctm ? cm(f.ctm) + ' ' : ''}/Fm${i} Do Q`
    resources = doc.context.obj({ XObject: { [`Fm${i}`]: form } })
  }
  page.node.set(PDFName.of('Resources'), resources)
  setContent(doc, page, inner)
  return doc.save()
}

/**
 * One page of `size` pt drawing each layer's raster with its placement, in order (the first is
 * drawn first, i.e. underneath). `cropBox` sets a CropBox smaller than the MediaBox.
 */
export async function imagesPage(
  size: { width: number; height: number },
  layers: { raster: GreyImage; place: Matrix6 }[],
  opts: { cropBox?: [number, number, number, number] } = {}
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([size.width, size.height])
  const xo: Record<string, PDFRef> = {}
  const ops = layers.map((l, i) => {
    xo[`L${i}`] = imageXObject(doc, l.raster)
    return `q ${cm(l.place)} /L${i} Do Q`
  })
  page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: xo }))
  if (opts.cropBox) page.node.set(PDFName.of('CropBox'), doc.context.obj(opts.cropBox))
  setContent(doc, page, ops.join('\n'))
  return doc.save()
}

/** A `w` × `h` grey raster with mid-grey values (8 bpc when embedded), e.g. an MRC background. */
export function greyRaster(w: number, h: number): GreyImage {
  const data = new Uint8Array(w * h)
  for (let i = 0; i < data.length; i++) data[i] = 96 + (i % 61)
  return { width: w, height: h, data }
}

/** The scan's own page: the image filling a page of its size at `dpi`. */
export function fillPage(raster: GreyImage, dpi: number): Promise<Uint8Array> {
  const w = (raster.width * 72) / dpi
  const h = (raster.height * 72) / dpi
  return placedScan(raster, { width: w, height: h }, [w, 0, 0, h, 0, 0])
}

/** The scan cut into `strips` horizontal image strips stacked to fill the page. */
export async function stripScan(raster: GreyImage, dpi: number, strips = 4): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const W = (raster.width * 72) / dpi
  const H = (raster.height * 72) / dpi
  const page = doc.addPage([W, H])
  const xo: Record<string, PDFRef> = {}
  const ops: string[] = []
  let row = 0
  for (let k = 0; k < strips; k++) {
    const rows = Math.round(((k + 1) * raster.height) / strips) - row
    const strip: GreyImage = {
      width: raster.width,
      height: rows,
      data: raster.data.subarray(row * raster.width, (row + rows) * raster.width)
    }
    xo[`S${k}`] = imageXObject(doc, strip)
    // Image rows run top-down: strip k sits below the k earlier ones.
    const top = H - (row * 72) / dpi
    const h = (rows * 72) / dpi
    ops.push(`q ${cm([W, 0, 0, h, 0, top - h])} /S${k} Do Q`)
    row += rows
  }
  page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: xo }))
  setContent(doc, page, ops.join('\n'))
  return doc.save()
}

export interface TextItem {
  text: string
  x: number
  y: number
  size: number
  /** Render mode 3 (no paint). */
  invisible?: boolean
  /** Any other text render mode (e.g. 7, clip only); `invisible` is mode 3. */
  mode?: number
  font?: 'helvetica' | 'times' | 'courier'
  /** Baseline rotation, degrees counter-clockwise. */
  rotate?: number
}

const FONTS = {
  helvetica: StandardFonts.Helvetica,
  times: StandardFonts.TimesRoman,
  courier: StandardFonts.Courier
} as const

/** Draw `items` over page 0 of `pdf` (pdf-lib drawText; invisible ones under `3 Tr`). */
export async function addText(
  pdf: Uint8Array,
  items: TextItem[],
  opts: { renameFont?: string } = {}
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf)
  const page = doc.getPage(0)
  const fonts = new Map<string, PDFFont>()
  for (const it of items) {
    const id = it.font ?? 'helvetica'
    let font = fonts.get(id)
    if (!font) {
      font = await doc.embedFont(FONTS[id])
      fonts.set(id, font)
    }
    const mode = it.invisible ? 3 : it.mode
    if (mode !== undefined) page.pushOperators(pushGraphicsState(), setTextRenderingMode(mode))
    page.drawText(it.text, {
      x: it.x,
      y: it.y,
      size: it.size,
      font,
      color: rgb(0, 0, 0),
      rotate: it.rotate ? degrees(it.rotate) : undefined
    })
    if (mode !== undefined) page.pushOperators(popGraphicsState())
  }
  if (opts.renameFont) {
    await doc.flush() // standard fonts are only written into the context on flush/save
    for (const font of fonts.values()) {
      const dict = doc.context.lookup(font.ref, PDFDict)
      dict.set(PDFName.of('BaseFont'), PDFName.of(opts.renameFont))
    }
  }
  return doc.save()
}

/** Lines of the sample bank's words as text items, filling `box` (pt) at `size`. */
export function paragraphItems(
  words: string[],
  box: { x: number; y: number; w: number; h: number },
  size: number,
  opts: Pick<TextItem, 'invisible' | 'font'> = {}
): TextItem[] {
  const out: TextItem[] = []
  const perLine = Math.max(1, Math.floor(box.w / (size * 0.5 * 7)))
  let y = box.y + box.h - size
  for (let i = 0; i < words.length && y >= box.y; i += perLine, y -= size * 1.35)
    out.push({ text: words.slice(i, i + perLine).join(' '), x: box.x, y, size, ...opts })
  return out
}

// ---------------------------------------------------------------------------------------------
// Encryption (Standard security handler, owner password only).

const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex')
const md5 = (...b: Buffer[]): Buffer => createHash('md5').update(Buffer.concat(b)).digest()
const padPw = (pw: string): Buffer =>
  Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32)

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i)
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255
    ;[s[i], s[j]] = [s[j], s[i]]
  }
  const out = Buffer.alloc(data.length)
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255
    j = (j + s[i]) & 255
    ;[s[i], s[j]] = [s[j], s[i]]
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255]
  }
  return out
}

const le32 = (v: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeInt32LE(v)
  return b
}

function aesCbc(bits: number, key: Buffer, iv: Buffer, data: Buffer, pad = true): Buffer {
  const c = createCipheriv(`aes-${bits}-cbc`, key, iv)
  c.setAutoPadding(pad)
  return Buffer.concat([c.update(data), c.final()])
}

/** ISO 32000-2 Algorithm 2.B. */
function hash2B(pw: Buffer, salt: Buffer, udata: Buffer): Buffer {
  let k = createHash('sha256')
    .update(Buffer.concat([pw, salt, udata]))
    .digest()
  for (let i = 0; ; i++) {
    const k1 = Buffer.concat(Array(64).fill(Buffer.concat([pw, k, udata])))
    const e = aesCbc(128, k.subarray(0, 16), k.subarray(16, 32), k1, false)
    let sum = 0
    for (let j = 0; j < 16; j++) sum += e[j]
    k = createHash(['sha256', 'sha384', 'sha512'][sum % 3])
      .update(e)
      .digest()
    if (i >= 63 && e[e.length - 1] <= i - 31) break
  }
  return k.subarray(0, 32)
}

interface Handler {
  dict: string
  enc: (num: number, gen: number, data: Buffer) => Buffer
}

function securityHandler(
  R: 2 | 3 | 6,
  owner: string,
  user: string,
  P: number,
  id0: Buffer
): Handler {
  if (R === 6) {
    const fileKey = randomBytes(32)
    const upw = Buffer.from(user, 'utf8')
    const opw = Buffer.from(owner, 'utf8')
    const uvs = randomBytes(8)
    const uks = randomBytes(8)
    const U = Buffer.concat([hash2B(upw, uvs, Buffer.alloc(0)), uvs, uks])
    const UE = aesCbc(256, hash2B(upw, uks, Buffer.alloc(0)), Buffer.alloc(16), fileKey, false)
    const ovs = randomBytes(8)
    const oks = randomBytes(8)
    const O = Buffer.concat([hash2B(opw, ovs, U), ovs, oks])
    const OE = aesCbc(256, hash2B(opw, oks, U), Buffer.alloc(16), fileKey, false)
    const perms = Buffer.concat([
      le32(P),
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
      Buffer.from('Tadb'),
      randomBytes(4)
    ])
    const c = createCipheriv('aes-256-ecb', fileKey, null)
    c.setAutoPadding(false)
    const Perms = Buffer.concat([c.update(perms), c.final()])
    return {
      dict: `<< /Filter /Standard /V 5 /R 6 /Length 256 /P ${P} /O <${O.toString('hex')}> /U <${U.toString('hex')}> /OE <${OE.toString('hex')}> /UE <${UE.toString('hex')}> /Perms <${Perms.toString('hex')}> /CF << /StdCF << /CFM /AESV3 /AuthEvent /DocOpen /Length 32 >> >> /StmF /StdCF /StrF /StdCF >>`,
      enc: (_num, _gen, data) => {
        const iv = randomBytes(16)
        return Buffer.concat([iv, aesCbc(256, fileKey, iv, data)])
      }
    }
  }
  // R2 is RC4-40 (5-byte key, no 50/19 rounds, Algorithm 4 for U); R3 is RC4-128.
  const r2 = R === 2
  const len = r2 ? 5 : 16
  // Algorithm 3: O.
  let h = md5(padPw(owner || user))
  if (!r2) for (let i = 0; i < 50; i++) h = md5(h)
  const okey = h.subarray(0, len)
  let O = rc4(okey, padPw(user))
  if (!r2) for (let i = 1; i <= 19; i++) O = rc4(Buffer.from(okey.map((b) => b ^ i)), O)
  // Algorithm 2: the file key.
  let k = md5(padPw(user), O, le32(P), id0)
  if (!r2) for (let i = 0; i < 50; i++) k = md5(k.subarray(0, len))
  const key = k.subarray(0, len)
  // Algorithm 4 (R2) or 5 (R3): U.
  let U: Buffer
  if (r2) U = rc4(key, PAD)
  else {
    let x = rc4(key, md5(PAD, id0))
    for (let i = 1; i <= 19; i++) x = rc4(Buffer.from(key.map((b) => b ^ i)), x)
    U = Buffer.concat([x, Buffer.alloc(16)])
  }
  const objKey = (num: number, gen: number): Buffer =>
    md5(
      key,
      Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255])
    ).subarray(0, Math.min(len + 5, 16))
  return {
    dict: r2
      ? `<< /Filter /Standard /V 1 /R 2 /Length 40 /P ${P} /O <${O.toString('hex')}> /U <${U.toString('hex')}> >>`
      : `<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${P} /O <${O.toString('hex')}> /U <${U.toString('hex')}> >>`,
    enc: (num, gen, data) => rc4(objKey(num, gen), data)
  }
}

/**
 * The scan as an encrypted one-page PDF: R3 (RC4-128) or R6 (AES-256), owner password only, so
 * PDFium and pdf.js open it with the empty password (PR0) and report revision `R`. With `user`
 * set, a password is needed to open it at all.
 */
export function encryptedScan(
  raster: GreyImage,
  dpi: number,
  R: 2 | 3 | 6,
  opts: { user?: string; owner?: string; P?: number } = {}
): Uint8Array {
  const id0 = randomBytes(16)
  const sh = securityHandler(R, opts.owner ?? 'owner-pw', opts.user ?? '', opts.P ?? -3904, id0)
  const W = (raster.width * 72) / dpi
  const H = (raster.height * 72) / dpi
  const content = sh.enc(4, 0, Buffer.from(`q ${n(W)} 0 0 ${n(H)} 0 0 cm /Im0 Do Q`))
  const s = samples(raster)
  const image = sh.enc(5, 0, Buffer.from(zlibSync(s.data, { level: 1 })))
  const stream = (dict: string, data: Buffer): Buffer =>
    Buffer.concat([Buffer.from(`${dict}\nstream\n`), data, Buffer.from('\nendstream')])
  const objs: (string | Buffer)[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(W)} ${n(H)}] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>`,
    stream(`<< /Length ${content.length} >>`, content),
    stream(
      `<< /Type /XObject /Subtype /Image /Width ${raster.width} /Height ${raster.height} /ColorSpace /DeviceGray /BitsPerComponent ${s.bits} /Filter /FlateDecode /Length ${image.length} >>`,
      image
    ),
    sh.dict
  ]
  return writePdf(objs, ` /Encrypt 6 0 R /ID [<${id0.toString('hex')}> <${id0.toString('hex')}>]`)
}

/** Serialise numbered objects (1..n) with a classic xref table; `trailerExtra` joins the trailer. */
export function writePdf(objs: (string | Buffer)[], trailerExtra = ''): Uint8Array {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offs: number[] = []
  let len = parts[0].length
  objs.forEach((o, i) => {
    const b = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1'),
      Buffer.from('\nendobj\n')
    ])
    offs.push(len)
    parts.push(b)
    len += b.length
  })
  const xref = [
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`,
    ...offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
  ].join('')
  parts.push(
    Buffer.from(
      `${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${len}\n%%EOF\n`,
      'latin1'
    )
  )
  return new Uint8Array(Buffer.concat(parts))
}

// ---------------------------------------------------------------------------------------------
// JPX.

/** A JPEG 2000 codestream that is only SOC + SIZ + EOC: enough for the pre-check, never decodable. */
export function j2k(opts: {
  width: number
  height: number
  components: number
  bits?: number
  /** Per component (XRsiz, YRsiz); default all (1, 1). */
  sub?: Array<[number, number]>
}): Uint8Array {
  const c = opts.components
  const siz = Buffer.alloc(2 + 2 + 38 + 3 * c)
  siz.writeUInt16BE(0xff51, 0)
  siz.writeUInt16BE(38 + 3 * c, 2)
  siz.writeUInt16BE(0, 4) // Rsiz
  siz.writeUInt32BE(opts.width, 6)
  siz.writeUInt32BE(opts.height, 10)
  siz.writeUInt32BE(0, 14)
  siz.writeUInt32BE(0, 18)
  siz.writeUInt32BE(opts.width, 22) // one tile
  siz.writeUInt32BE(opts.height, 26)
  siz.writeUInt32BE(0, 30)
  siz.writeUInt32BE(0, 34)
  siz.writeUInt16BE(c, 38)
  for (let i = 0; i < c; i++) {
    const [x, y] = opts.sub?.[i] ?? [1, 1]
    siz[40 + 3 * i] = (opts.bits ?? 8) - 1
    siz[41 + 3 * i] = x
    siz[42 + 3 * i] = y
  }
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0x4f]), siz, Buffer.from([0xff, 0xd9])]))
}

const box = (type: string, payload: Buffer): Buffer => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + payload.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, payload])
}

/** `codestream` in a JP2 file with an `ihdr` and a `colr` box of EnumCS `enumcs` (16 sRGB, 17 grey). */
export function jp2(
  codestream: Uint8Array,
  opts: { width: number; height: number; components: number; enumcs: number }
): Uint8Array {
  const sig = box('jP  ', Buffer.from([0x0d, 0x0a, 0x87, 0x0a]))
  const ftyp = box('ftyp', Buffer.from('jp2 \0\0\0\0jp2 ', 'latin1'))
  const ihdr = Buffer.alloc(14)
  ihdr.writeUInt32BE(opts.height, 0)
  ihdr.writeUInt32BE(opts.width, 4)
  ihdr.writeUInt16BE(opts.components, 8)
  ihdr[10] = 7 // 8 bits
  ihdr[11] = 7 // compression: JPEG 2000
  const colr = Buffer.alloc(7)
  colr[0] = 1 // enumerated
  colr.writeUInt32BE(opts.enumcs, 3)
  const jp2h = box('jp2h', Buffer.concat([box('ihdr', ihdr), box('colr', colr)]))
  return new Uint8Array(Buffer.concat([sig, ftyp, jp2h, box('jp2c', Buffer.from(codestream))]))
}

/**
 * A Letter page filled by a JPXDecode image of `data`. `colorSpace`: a family name, 'icc3' (an
 * [/ICCBased n 0 R] array with /N 3, the profile behind an indirect reference), or null (none).
 * `decoy`: a second, valid JPX image elsewhere on the page.
 */
export async function jpxPage(
  data: Uint8Array,
  opts: {
    width: number
    height: number
    colorSpace: string | 'icc3' | null
    decoy?: Uint8Array
    /** Draw the image inside this many nested (identity) Form XObjects. */
    forms?: number
    /** Page content drawn before the image (e.g. many cheap path objects). */
    before?: string
  }
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const ctx = doc.context
  const dict: Record<string, unknown> = {
    Type: 'XObject',
    Subtype: 'Image',
    Width: opts.width,
    Height: opts.height,
    BitsPerComponent: 8,
    Filter: 'JPXDecode'
  }
  if (opts.colorSpace === 'icc3') {
    const icc = ctx.register(ctx.stream(new Uint8Array(128), { N: 3, Alternate: 'DeviceRGB' }))
    dict.ColorSpace = ctx.register(ctx.obj([PDFName.of('ICCBased'), icc]))
  } else if (opts.colorSpace) dict.ColorSpace = opts.colorSpace
  const img = ctx.register(ctx.stream(data, dict as never))
  const xo: Record<string, PDFRef> = { Im0: img }
  const ops = ['q 612 0 0 792 0 0 cm /Im0 Do Q']
  if (opts.decoy) {
    xo.Im1 = ctx.register(
      ctx.stream(opts.decoy, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 8,
        Height: 8,
        BitsPerComponent: 8,
        ColorSpace: 'DeviceGray',
        Filter: 'JPXDecode'
      })
    )
    ops.unshift('q 10 0 0 10 0 0 cm /Im1 Do Q')
  }
  let resources = ctx.obj({ XObject: xo })
  let content = ops.join('\n')
  for (let i = 0; i < (opts.forms ?? 0); i++) {
    const form = ctx.register(
      ctx.stream(content, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 612, 792],
        Resources: resources
      })
    )
    content = `q /Fm${i} Do Q`
    resources = ctx.obj({ XObject: { [`Fm${i}`]: form } })
  }
  page.node.set(PDFName.of('Resources'), resources)
  setContent(doc, page, (opts.before ?? '') + content)
  return doc.save({ useObjectStreams: false })
}

/**
 * A Letter page filled by a Flate DeviceGray image whose /SMask (or /Mask, with `key`) is a
 * JPXDecode stream of `mask` with the given /ColorSpace (null: none, as a soft mask may omit it).
 */
export async function jpxMaskPage(
  mask: Uint8Array,
  opts: { colorSpace: string | null; key?: 'SMask' | 'Mask'; size?: number }
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const ctx = doc.context
  const px = opts.size ?? 64
  const maskDict: Record<string, unknown> = {
    Type: 'XObject',
    Subtype: 'Image',
    Width: px,
    Height: px,
    BitsPerComponent: 8,
    Filter: 'JPXDecode'
  }
  if (opts.colorSpace) maskDict.ColorSpace = opts.colorSpace
  const maskRef = ctx.register(ctx.stream(mask, maskDict as never))
  const grey = new Uint8Array(px * px).fill(128)
  const img = ctx.register(
    ctx.stream(zlibSync(grey, { level: 1 }), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: px,
      Height: px,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8,
      Filter: 'FlateDecode',
      [opts.key ?? 'SMask']: maskRef
    } as never)
  )
  page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Im0: img } }))
  setContent(doc, page, 'q 612 0 0 792 0 0 cm /Im0 Do Q')
  return doc.save({ useObjectStreams: false })
}
