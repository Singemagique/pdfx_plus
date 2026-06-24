import {
  PageSize,
  LETTER,
  PT_TO_PX,
  FONT,
  pageCss,
  widthPx,
  escapeHtml,
  decodeUtf8
} from './markup-units'
import { rtfToText } from './markup-rtf'
import { prepareSvg, wrapSvg } from './markup-svg'
import { buildHtmlDoc } from './markup-html'

export type { PageSize }

const MARKUP_EXT = /\.(txt|rtf|svg|html?)$/i

export const isMarkupFile = (name: string): boolean => MARKUP_EXT.test(name)
export const stripMarkupExtension = (name: string): string => name.replace(MARKUP_EXT, '')

const extOf = (name: string): string => (MARKUP_EXT.exec(name)?.[1] ?? '').toLowerCase()

const wrapText = (text: string, page: PageSize): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${pageCss(page)}body{width:${widthPx(page)}px;padding:${Math.round(widthPx(page) * 0.07)}px;font:15px/1.55 ${FONT};color:#16161a}pre{margin:0;font:inherit;white-space:pre-wrap;word-break:break-word}</style></head><body><pre>${escapeHtml(text)}</pre></body></html>`

export async function buildMarkupPdf(
  name: string,
  data: Uint8Array,
  fit?: PageSize,
  path?: string
): Promise<Uint8Array> {
  const e = extOf(name)
  if (e === 'svg') {
    const { svg, size } = prepareSvg(decodeUtf8(data))
    return window.api.markupToPdf(wrapSvg(svg, fit ?? size ?? LETTER, fit != null))
  }
  const page = fit ?? LETTER
  const fitPx = fit ? Math.round(fit.height * PT_TO_PX) : undefined
  if (e === 'html' || e === 'htm') {
    const read = path ? (ref: string) => window.api.readResource(path, ref) : undefined
    return window.api.markupToPdf(await buildHtmlDoc(decodeUtf8(data), page, read), fitPx)
  }
  const text = e === 'rtf' ? rtfToText(data) : decodeUtf8(data)
  return window.api.markupToPdf(wrapText(text, page), fitPx)
}
