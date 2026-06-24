import { PageSize, SVG_UNIT_TO_PT, PT_TO_PX, widthPx, pageCss } from './markup-units'

export const prepareSvg = (markup: string): { svg: string; size: PageSize | null } => {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml')
  const el = doc.documentElement
  if (doc.querySelector('parsererror') || !el || el.nodeName.toLowerCase() !== 'svg') {
    return { svg: markup, size: null }
  }
  el.querySelectorAll('script,foreignObject').forEach((n) => n.remove())
  el.querySelectorAll('*').forEach((n) =>
    Array.from(n.attributes).forEach((a) => {
      const name = a.name.toLowerCase()
      // Strip event handlers and javascript: URLs on links (parity with the HTML path).
      if (name.startsWith('on')) {
        n.removeAttribute(a.name)
      } else if ((name === 'href' || name === 'xlink:href') && /^\s*javascript:/i.test(a.value)) {
        n.removeAttribute(a.name)
      }
    })
  )
  const num = (v: string | null): number => (v ? parseFloat(v) : NaN)
  const w = num(el.getAttribute('width'))
  const h = num(el.getAttribute('height'))
  let size: PageSize | null = null
  if (w > 0 && h > 0) {
    size = { width: w * SVG_UNIT_TO_PT, height: h * SVG_UNIT_TO_PT }
  } else {
    const vb = el
      .getAttribute('viewBox')
      ?.trim()
      .split(/[\s,]+/)
      .map(Number)
    if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
      size = { width: vb[2] * SVG_UNIT_TO_PT, height: vb[3] * SVG_UNIT_TO_PT }
    }
  }
  return { svg: new XMLSerializer().serializeToString(el), size }
}

export const wrapSvg = (svg: string, page: PageSize, fit: boolean): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${pageCss(page)}body{width:${widthPx(page)}px;height:${Math.round(page.height * PT_TO_PX)}px;display:flex;align-items:center;justify-content:center}svg{${fit ? 'max-width:100%;max-height:100%' : 'width:100%;height:100%'};display:block}</style></head><body>${svg}</body></html>`
