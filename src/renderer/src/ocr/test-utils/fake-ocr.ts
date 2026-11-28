// Test doubles for the renderer OCR store: a scripted preload port (what `window.api.ocr` is), a
// minimal Find text access, page/document builders and recognised pages. Test-only.

import type {
  FromOcr,
  OcrDisconnectReason,
  PageResult,
  RecognizeRequest,
  ToOcr
} from '../../../../shared/ocr/protocol'
import type { TriagePage } from '../../../../shared/ocr/triage'
import { ENGINE_ID, PIPELINE_VERSION } from '../../../../shared/ocr/engine/tess-core'
import { pack, type PackedOcrPage, type PageClass } from '../../../../shared/ocr/types'
import { buildPageText, type PageText, type PageTextItem } from '../../search/extract'
import type { FindTextAccess } from '../../search/find-controller'
import type { DocEntry, PageEntry, PdfSource } from '../../types'
import type { OcrPortLike } from '../ocr-store'

type AllKeys<T> = T extends unknown ? keyof T : never
type PostKind = AllKeys<ToOcr>
type PostPayload<K extends PostKind> = ToOcr extends infer M
  ? M extends Record<K, infer P>
    ? P
    : never
  : never

/** The preload port: records posts, and lets the test speak for the coordinator and main. */
export class FakeOcrPort implements OcrPortLike {
  readonly posts: ToOcr[] = []
  connects = 0
  private listeners = new Set<(m: unknown) => void>()

  connect(): void {
    this.connects++
  }
  post(message: ToOcr): boolean {
    // What the real port does: a structured clone (no transfer list).
    this.posts.push(structuredClone(message))
    return true
  }
  onMessage(cb: (m: unknown) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  /** Deliver a raw message (anything: the store validates). */
  emit(m: FromOcr | unknown): void {
    for (const l of [...this.listeners]) l(structuredClone(m))
  }
  connected(): void {
    this.emit({ link: { state: 'connected' } })
  }
  disconnected(reason: OcrDisconnectReason): void {
    this.emit({ link: { state: 'disconnected', reason } })
  }
  /** The keys of the posts, in order (`open`, `triage`, …). */
  kinds(): string[] {
    return this.posts.map((p) => Object.keys(p)[0])
  }
  /** The payloads of every post of one kind (`of('open')[0].src`). */
  of<K extends PostKind>(kind: K): Array<PostPayload<K>> {
    return this.posts
      .filter((p) => kind in p)
      .map((p) => (p as Record<string, unknown>)[kind]) as Array<PostPayload<K>>
  }
  recognizes(): RecognizeRequest[] {
    return this.of('recognize') as unknown as RecognizeRequest[]
  }
  clear(): void {
    this.posts.length = 0
  }
}

/** A page's native text: `chars` letters on one line (0: a scan's empty text layer). */
export function nativeText(chars: number, height = 792): PageText {
  const vt = [1, 0, 0, -1, 0, height]
  const items: PageTextItem[] = chars
    ? [
        {
          str: 'x'.repeat(chars),
          t: [10, 0, 0, 10, 20, 700],
          width: chars * 5,
          height: 10,
          ascent: 0.8,
          descent: -0.2,
          vertical: false,
          rtl: false,
          hasEOL: true
        }
      ]
    : []
  return buildPageText(items, vt)
}

/** A Find text access over fixed native texts (by page key), recording supplements. */
export class FakeText implements FindTextAccess {
  readonly reads: string[] = []
  readonly supplements = new Map<string, { mode: string; items: readonly PageTextItem[] } | null>()
  private listeners = new Set<(key: string, t: PageText) => void>()
  constructor(readonly texts: Map<string, PageText> = new Map()) {}

  setSupplement(
    key: string,
    s: { mode: 'append' | 'replace'; items: readonly PageTextItem[] } | null
  ): boolean {
    this.supplements.set(key, s)
    return true
  }
  async readNative(key: string): Promise<PageText | undefined> {
    this.reads.push(key)
    const t = this.texts.get(key)
    if (t) for (const l of [...this.listeners]) l(key, t)
    return t
  }
  onNativeText(listener: (key: string, t: PageText) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getPageText(key: string): PageText | undefined {
    return this.texts.get(key)
  }
  /** Find's full extraction stored `key`'s text. */
  extracted(key: string, t: PageText): void {
    this.texts.set(key, t)
    for (const l of [...this.listeners]) l(key, t)
  }
}

/** A source with `n` pages, its own bytes and a pdf.js stand-in. */
export function source(id: string, opts: { origin?: 'image'; bytes?: Uint8Array } = {}): PdfSource {
  const pdf = { getPage: async () => ({ userUnit: 1 }), numPages: 99 }
  const s: PdfSource = {
    id,
    bytes: opts.bytes ?? new Uint8Array([0x25, 0x50, 0x44, 0x46, id.length]),
    pdf: pdf as unknown as PdfSource['pdf']
  }
  if (opts.origin) s.origin = opts.origin
  return s
}

export function pageOf(
  src: PdfSource,
  pageIndex: number,
  id = `${src.id}-p${pageIndex}`
): PageEntry {
  return { id, source: src, pageIndex, width: 612, height: 792 }
}

export function doc(id: string, pages: PageEntry[]): DocEntry {
  return { id, name: `${id}.pdf`, pages }
}

/** Triage's answer for a page. */
export function triaged(index: number, pageClass: PageClass | null): TriagePage {
  return {
    index,
    pageClass,
    renderDpi: pageClass === 'protected' ? null : 300,
    raster: pageClass === 'protected' ? null : { width: 2550, height: 3300 },
    effectiveDpi: 300,
    bitsPerPixel: 1,
    imageOrigin: false
  }
}

/** A recognised page with `words` on one line at the top left (overlay frame, 12 pt). */
export function recognisedPage(words: string[], langs = ['eng'], y = 700): PackedOcrPage {
  let x = 72
  return pack({
    v: 1,
    engineId: ENGINE_ID,
    dataHashes: Object.fromEntries(langs.map((l) => [l, 'a'.repeat(64)])),
    langs,
    pipelineVersion: PIPELINE_VERSION,
    pageClass: 'scanned',
    renderDpi: 300,
    physDpi: 300,
    orientation: 0,
    skewDeg: 0,
    meanConfCal: 0.9,
    confSource: 'word',
    status: 'ok',
    lines: [
      {
        angle: 0,
        size: 12,
        words: words.map((t) => {
          const w = { t, x, y, w: t.length * 6, conf: 90, confCal: 0.9 }
          x += t.length * 6 + 6
          return w
        })
      }
    ]
  })
}

export function okResult(page: PackedOcrPage): PageResult {
  return {
    status: 'ok',
    renderDpi: 300,
    raster: { width: 2550, height: 3300 },
    recognition: page
  }
}

/** Let microtasks, the store's pump and zero-delay timers run. */
export async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
}

/** Run idle work at once (on the next macrotask). */
export const eagerIdle = (fn: () => void): (() => void) => {
  const t = setTimeout(fn, 0)
  return () => clearTimeout(t)
}
