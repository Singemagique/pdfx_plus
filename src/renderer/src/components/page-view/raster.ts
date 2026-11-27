import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { BASE_RASTER, type DetailPlan } from './detail-geometry'

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
  isCancelled: () => boolean
  onTask: (task: RenderTask) => void
  onReady: () => void
}

export async function renderBase({
  pdf,
  pageNumber,
  naturalWidth,
  naturalHeight,
  baseRef,
  isCancelled,
  onTask,
  onReady
}: BaseParams): Promise<void> {
  const page = await pdf.getPage(pageNumber)
  if (isCancelled()) return
  const scale = BASE_RASTER / Math.max(naturalWidth, naturalHeight)
  const viewport = page.getViewport({ scale })
  const off = document.createElement('canvas')
  off.width = Math.max(1, Math.floor(viewport.width))
  off.height = Math.max(1, Math.floor(viewport.height))
  const task = page.render({ canvas: off, viewport })
  onTask(task)
  await task.promise
  if (isCancelled()) return
  const canvas = baseRef.current
  if (!canvas) return
  canvas.width = off.width
  canvas.height = off.height
  canvas.getContext('2d')!.drawImage(off, 0, 0)
  onReady()
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
