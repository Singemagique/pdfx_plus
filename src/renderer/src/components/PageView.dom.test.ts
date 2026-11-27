// Wiring test for PageView's detail canvas: the CSS rotation a parent applies must reach the
// detail-geometry planner, so a quarter-turned page's detail canvas is rendered at the upright
// scale and covers the whole upright page (not the top ~60% of it).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PDFDocumentProxy } from 'pdfjs-dist'

import { PageView } from './PageView'

// US Letter laid out upright at 300 CSS px, displayed at 2× by an ancestor transform.
const W = 612
const H = 792
const LAYOUT_W = 300
const LAYOUT_H = (LAYOUT_W * H) / W
const UW = LAYOUT_W * 2
const UH = LAYOUT_H * 2

const renderScales: number[] = []
interface RenderCall {
  scale: number
  transform?: number[]
  canvas: { width: number; height: number }
}
const renderCalls: RenderCall[] = []
const pdfStub = {
  getPage: () =>
    Promise.resolve({
      getViewport: ({ scale }: { scale: number }) => ({ width: W * scale, height: H * scale }),
      render: ({
        viewport,
        transform,
        canvas
      }: {
        viewport: { width: number }
        transform?: number[]
        canvas: HTMLCanvasElement
      }) => {
        renderScales.push(viewport.width / W)
        renderCalls.push({
          scale: viewport.width / W,
          transform,
          canvas: { width: canvas.width, height: canvas.height }
        })
        return { promise: Promise.resolve(), cancel: () => {} }
      }
    })
} as unknown as PDFDocumentProxy

let pageRect = { left: 0, top: 0, width: 0, height: 0 }
let container: HTMLDivElement
let root: Root
const restore: (() => void)[] = []

function stub<T extends object>(obj: T, key: string, desc: PropertyDescriptor): void {
  const prev = Object.getOwnPropertyDescriptor(obj, key)
  Object.defineProperty(obj, key, { configurable: true, ...desc })
  restore.push(() =>
    prev ? Object.defineProperty(obj, key, prev) : delete (obj as Record<string, unknown>)[key]
  )
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  renderScales.length = 0
  renderCalls.length = 0
  // jsdom has no layout or canvas: give the page box a rect/width and canvases a no-op context.
  stub(Element.prototype, 'getBoundingClientRect', {
    value(this: Element) {
      const r = this.classList.contains('pageview') ? pageRect : { left: 0, top: 0, width: 0, height: 0 }
      return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top }
    }
  }) // prettier-ignore
  stub(HTMLElement.prototype, 'offsetWidth', {
    get(this: HTMLElement) {
      return this.classList.contains('pageview') ? LAYOUT_W : 0
    }
  })
  stub(HTMLCanvasElement.prototype, 'getContext', { value: () => ({ drawImage: () => {} }) })
  stub(window, 'devicePixelRatio', { value: 2 })
  stub(window, 'innerWidth', { value: 1600 })
  stub(window, 'innerHeight', { value: 1200 })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  while (restore.length) restore.pop()!()
  vi.restoreAllMocks()
})

type Clip = { x0: number; y0: number; x1: number; y1: number } | null

async function mount(rotation: number, clip: Clip = null): Promise<HTMLCanvasElement> {
  await act(async () => {
    root.render(
      createElement(PageView, {
        pdf: pdfStub,
        pageNumber: 1,
        naturalWidth: W,
        naturalHeight: H,
        version: 1,
        eager: true,
        rotation,
        clip
      })
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  return container.querySelector('.pageview-detail') as HTMLCanvasElement
}

describe('PageView detail canvas', () => {
  it.each([
    [0, UW, UH],
    [90, UH, UW],
    [180, UW, UH],
    [270, UH, UW]
  ])('covers the whole upright page at the upright scale when rotated %i°', async (rot, bw, bh) => {
    pageRect = { left: 20, top: 20, width: bw, height: bh }
    const detail = await mount(rot)

    expect(detail.style.display).toBe('block')
    expect(parseFloat(detail.style.left)).toBeCloseTo(0, 6)
    expect(parseFloat(detail.style.top)).toBeCloseTo(0, 6)
    expect(parseFloat(detail.style.width)).toBeCloseTo(LAYOUT_W, 6)
    expect(parseFloat(detail.style.height)).toBeCloseTo(LAYOUT_H, 6)
    expect(detail.width).toBe(Math.round(UW * 2))
    expect(detail.height).toBe(Math.round(UH * 2))
    // Last render is the detail pass (the first is the base raster).
    expect(renderScales.at(-1)).toBeCloseTo((UW / W) * 2, 9)
  })
})

describe('PageView base raster', () => {
  const base = (): HTMLCanvasElement =>
    container.querySelector('.pageview-base') as HTMLCanvasElement

  it('renders the whole page at BASE_RASTER on its long side, with no placement', async () => {
    pageRect = { left: 20, top: 20, width: 100, height: 100 } // small: no detail pass
    await mount(0)
    expect(renderCalls).toHaveLength(1)
    const [call] = renderCalls
    expect(call.scale).toBeCloseTo(1100 / H, 9)
    expect(call.transform).toBeUndefined()
    expect(call.canvas).toEqual({ width: Math.floor((W * 1100) / H), height: 1100 })
    expect(base().style.left).toBe('')
    expect(base().style.width).toBe('')
  })

  it('renders only the crop window, offset to it, and places the canvas over it', async () => {
    pageRect = { left: 20, top: 20, width: 100, height: 100 }
    const clip = { x0: 0.25, y0: 0.5, x1: 0.75, y1: 0.75 } // 306 × 198 pt
    await mount(0, clip)
    expect(renderCalls).toHaveLength(1)
    const [call] = renderCalls
    const scale = 1100 / (0.5 * W)
    expect(call.scale).toBeCloseTo(scale, 9)
    expect(call.canvas).toEqual({
      width: Math.round(0.5 * W * scale),
      height: Math.round(0.25 * H * scale)
    })
    expect(call.transform?.[4]).toBeCloseTo(-0.25 * W * scale, 9)
    expect(call.transform?.[5]).toBeCloseTo(-0.5 * H * scale, 9)
    const s = base().style
    expect([s.left, s.top, s.width, s.height]).toEqual(['25%', '50%', '50%', '25%'])
  })

  it('re-renders and re-places the base raster when the crop changes or is removed', async () => {
    pageRect = { left: 20, top: 20, width: 100, height: 100 }
    await mount(0, { x0: 0.25, y0: 0.5, x1: 0.75, y1: 0.75 })
    // A fresh but equal clip object is not a change.
    await mount(0, { x0: 0.25, y0: 0.5, x1: 0.75, y1: 0.75 })
    expect(renderCalls).toHaveLength(1)
    await mount(0, null)
    expect(renderCalls).toHaveLength(2)
    expect(renderCalls[1].transform).toBeUndefined()
    expect(base().style.left).toBe('')
  })
})
