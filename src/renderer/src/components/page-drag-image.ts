export function buildPageDragImage(pageEl: HTMLElement, rect: DOMRect): HTMLElement {
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
    c.getContext('2d')?.drawImage(src, 0, 0, c.width, c.height)
    wrap.appendChild(c)
  }

  document.body.appendChild(wrap)
  return wrap
}
