// The drag image draws the cell's base raster — the upright page, or only its crop window — turned
// by the page's edit rotation, so a rotated (or rotated + cropped) page is not dragged stretched.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPageDragImage } from './page-drag-image'

interface Call {
  op: string
  args: number[]
}

let calls: Call[] = []
let made: HTMLCanvasElement[] = []

beforeEach(() => {
  calls = []
  made = []
  const ctx = {
    translate: (...args: number[]) => calls.push({ op: 'translate', args }),
    rotate: (...args: number[]) => calls.push({ op: 'rotate', args }),
    drawImage: (_src: unknown, ...args: number[]) => calls.push({ op: 'drawImage', args })
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement
  ) {
    made.push(this)
    return ctx as unknown as CanvasRenderingContext2D
  })
  Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

function cell(): HTMLElement {
  const el = document.createElement('div')
  const base = document.createElement('canvas')
  base.className = 'pageview-base ready'
  el.appendChild(base)
  return el
}

// The cell's on-screen box: a 2:1 landscape (e.g. a portrait crop turned 90°).
const rect = { width: 200, height: 100, left: 0, top: 0 } as DOMRect

describe('buildPageDragImage', () => {
  it('draws the raster straight into the box for an upright page', () => {
    const img = buildPageDragImage(cell(), rect)
    expect(calls.find((c) => c.op === 'rotate')).toBeUndefined()
    expect(calls.at(-1)).toEqual({ op: 'drawImage', args: [-100, -50, 200, 100] })
    img.remove()
  })

  it.each([
    [90, [-50, -100, 100, 200]],
    [180, [-100, -50, 200, 100]],
    [270, [-50, -100, 100, 200]]
  ])('turns the upright raster by %i° about the box centre', (rot, draw) => {
    buildPageDragImage(cell(), rect, rot)
    expect(calls[0]).toEqual({ op: 'translate', args: [100, 50] })
    expect(calls[1].op).toBe('rotate')
    expect(calls[1].args[0]).toBeCloseTo((rot * Math.PI) / 180, 12)
    expect(calls[2]).toEqual({ op: 'drawImage', args: draw })
    expect(made.at(-1)?.width).toBe(200)
    expect(made.at(-1)?.height).toBe(100)
  })
})
