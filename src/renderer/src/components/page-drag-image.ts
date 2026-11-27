import { normalizeRotation } from '../page-geometry'

/**
 * The image shown under the cursor while a page cell is dragged: the cell's on-screen box with its
 * base raster drawn in. That raster is the upright page — or only its crop window — so it is drawn
 * turned by the page's edit `rotation` to match what the cell displays.
 */
export function buildPageDragImage(pageEl: HTMLElement, rect: DOMRect, rotation = 0): HTMLElement {
  const w = rect.width
  const h = rect.height
  const k = pageEl.offsetHeight ? h / pageEl.offsetHeight : 1

  const wrap = document.createElement('div')
  Object.assign(wrap.style, {
    position: 'fixed',
    top: '0',
    left: '-100000px',
    width: `${w}px`,
    height: `${h}px`,
    borderRadius: `${10 * k}px`,
    overflow: 'hidden',
    background: 'var(--surface)',
    pointerEvents: 'none'
  })

  const src = pageEl.querySelector('canvas.pageview-base') as HTMLCanvasElement | null
  if (src && src.classList.contains('ready')) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(w * dpr))
    c.height = Math.max(1, Math.round(h * dpr))
    Object.assign(c.style, { width: '100%', height: '100%', display: 'block' })
    const ctx = c.getContext('2d')
    if (ctx) {
      const rot = normalizeRotation(rotation)
      const quarter = rot === 90 || rot === 270
      const dw = quarter ? c.height : c.width
      const dh = quarter ? c.width : c.height
      ctx.translate(c.width / 2, c.height / 2)
      if (rot) ctx.rotate((rot * Math.PI) / 180)
      ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh)
    }
    wrap.appendChild(c)
  }

  document.body.appendChild(wrap)
  return wrap
}
