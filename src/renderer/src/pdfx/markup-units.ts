export interface PageSize {
  width: number
  height: number
}

export const PT_TO_PX = 96 / 72
export const PT_TO_MM = 25.4 / 72
export const SVG_UNIT_TO_PT = 72 / 96
export const LETTER: PageSize = { width: 612, height: 792 }
export const FONT = "-apple-system, system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

export const widthPx = (page: PageSize): number => Math.round(page.width * PT_TO_PX)

export const pageCss = (page: PageSize): string =>
  `@page{size:${page.width * PT_TO_MM}mm ${page.height * PT_TO_MM}mm;margin:0}html,body{margin:0;padding:0}*{box-sizing:border-box}`

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))

export const decodeUtf8 = (data: Uint8Array): string =>
  new TextDecoder('utf-8').decode(data).replace(/\r\n?/g, '\n')
