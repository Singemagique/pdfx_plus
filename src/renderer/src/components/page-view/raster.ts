import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { baseRasterScale, type DetailPlan, type PageClip } from './detail-geometry'

export const logRenderError =
  (label: string) =>
  (error: unknown): void => {
    if ((error as Error)?.name !== 'RenderingCancelledException') {
      console.error(label, error)
    }
  }

interface BaseParams {
  pdf: PDFDocumentProxy
  pageNumber: number
  naturalWidth: number
  naturalHeight: number
  baseRef: React.RefObject<HTMLCanvasElement | null>
  /** Render only this part of the page (a crop window, as page fractions); null = the whole page. */
  clip?: PageClip
  isCancelled: () => boolean
  onTask: (task: RenderTask) => void
  onReady: () => void
}

/**
 * Render the base raster: the whole page, or only `clip`, at BASE_RASTER device px on the
 * long side of what it covers. The canvas is placed over its region of the (full-page) PageView box
 * when its pixels land, so a re-render for a changed crop never shows stale pixels mis-registered.
 */
export async function renderBase({
  pdf,
  pageNumber,
  naturalWidth,
  naturalHeight,
  baseRef,
  clip,
  isCancelled,
  onTask,
  onReady
}: BaseParams): Promise<void> {
  const page = await pdf.getPage(pageNumber)
  if (isCancelled()) return
  const scale = baseRasterScale(naturalWidth, naturalHeight, clip)
  const viewport = page.getViewport({ scale })
  const off = document.createElement('canvas')
  let task: RenderTask
  if (clip) {
    off.width = Math.max(1, Math.round((clip.x1 - clip.x0) * viewport.width))
    off.height = Math.max(1, Math.round((clip.y1 - clip.y0) * viewport.height))
    task = page.render({
      canvas: off,
      viewport,
      transform: [1, 0, 0, 1, -clip.x0 * viewport.width, -clip.y0 * viewport.height]
    })
  } else {
    off.width = Math.max(1, Math.floor(viewport.width))
    off.height = Math.max(1, Math.floor(viewport.height))
    task = page.render({ canvas: off, viewport })
  }
  onTask(task)
  await task.promise
  if (isCancelled()) return
  const canvas = baseRef.current
  if (!canvas) return
  canvas.width = off.width
  canvas.height = off.height
  canvas.getContext('2d')!.drawImage(off, 0, 0)
  placeBase(canvas, clip)
  onReady()
}

const pct = (f: number): string => `${f * 100}%`

/** Lay the base canvas over its region of the page box (CSS defaults cover the whole page). */
function placeBase(canvas: HTMLCanvasElement, clip: PageClip): void {
  const s = canvas.style
  if (!clip) {
    s.left = s.top = s.width = s.height = ''
    return
  }
  s.left = pct(clip.x0)
  s.top = pct(clip.y0)
  s.width = pct(clip.x1 - clip.x0)
  s.height = pct(clip.y1 - clip.y0)
}

interface DetailParams {
  pdf: PDFDocumentProxy
  pageNumber: number
  plan: DetailPlan
  detailCanvas: HTMLCanvasElement
  isCancelled: () => boolean
  onTask: (task: RenderTask) => void
}

/** Render the visible region described by `plan` (see planDetail) into the detail canvas. */
export async function renderDetail({
  pdf,
  pageNumber,
  plan,
  detailCanvas,
  isCancelled,
  onTask
}: DetailParams): Promise<void> {
  const { renderScale, fx, fy, backingW, backingH, css } = plan
  const page = await pdf.getPage(pageNumber)
  if (isCancelled()) return
  const viewport = page.getViewport({ scale: renderScale })

  const off = document.createElement('canvas')
  off.width = backingW
  off.height = backingH
  const task = page.render({
    canvas: off,
    viewport,
    transform: [1, 0, 0, 1, -fx * viewport.width, -fy * viewport.height]
  })
  onTask(task)
  await task.promise
  if (isCancelled()) return

  detailCanvas.width = backingW
  detailCanvas.height = backingH
  detailCanvas.getContext('2d')!.drawImage(off, 0, 0)
  detailCanvas.style.display = 'block'
  detailCanvas.style.left = `${css.left}px`
  detailCanvas.style.top = `${css.top}px`
  detailCanvas.style.width = `${css.width}px`
  detailCanvas.style.height = `${css.height}px`
}
