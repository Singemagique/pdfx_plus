import { memo } from 'react'
import type { DocPlacement, DocReflow, Rect } from '../canvas/layout'
import { AddPageGhost, GhostPage } from './DropGhost'
import { PageCell } from './page-cell'

interface DocumentRowProps {
  item: DocPlacement
  /** Mid-drag positions (collapsed page removed / into-ghost opened); null → the layout's own. */
  reflow: DocReflow | null
  renderVersion: number
  selectedPageId: string | null
  pagesDraggable: boolean
  collapseId: string | null
  hiddenPageId: string | null
  intoGhost: { index: number; width: number; height: number } | null
  onSelectPage: (docId: string, pageId: string) => void
  onOpenPage: (docId: string, pageId: string) => void
  onPageDragStart: (docId: string, pageId: string) => void
  onPageDragEnd: () => void
  onAddPage: (docId: string) => void
}

/**
 * One document card. Every cell is absolutely positioned from the layout's world rects (made
 * card-relative here), so what is drawn is exactly what the drop math hit-tests against.
 */
function DocumentRowImpl({
  item,
  reflow,
  renderVersion,
  selectedPageId,
  pagesDraggable,
  collapseId,
  hiddenPageId,
  intoGhost,
  onSelectPage,
  onOpenPage,
  onPageDragStart,
  onPageDragEnd,
  onAddPage
}: DocumentRowProps): React.JSX.Element {
  const doc = item.doc
  const local = (r: Rect): Rect => ({ x: r.x - item.x, y: r.y - item.y, w: r.w, h: r.h })
  const base = new Map(item.pages.map((p) => [p.pageId, p]))
  const moved = reflow ? new Map(reflow.pages.map((p) => [p.pageId, p])) : null

  const cells: React.JSX.Element[] = []
  let visible = 0
  for (const page of doc.pages) {
    const collapsed = page.id === collapseId
    const slot = moved?.get(page.id) ?? base.get(page.id)
    if (!slot) continue
    const r = local(slot)
    cells.push(
      <PageCell
        key={page.id}
        docId={doc.id}
        page={page}
        x={r.x}
        y={r.y}
        width={r.w}
        pageHeight={r.h}
        renderVersion={renderVersion}
        selected={page.id === selectedPageId}
        collapsed={collapsed}
        hidden={page.id === hiddenPageId}
        pagesDraggable={pagesDraggable}
        visibleNumber={visible + 1}
        onSelectPage={onSelectPage}
        onOpenPage={onOpenPage}
        onPageDragStart={onPageDragStart}
        onPageDragEnd={onPageDragEnd}
      />
    )
    if (!collapsed) visible++
  }
  if (intoGhost && reflow?.ghost) {
    const g = local(reflow.ghost)
    cells.push(
      <GhostPage
        key="__into_ghost"
        x={g.x}
        y={g.y}
        width={intoGhost.width}
        height={intoGhost.height}
        grow
      />
    )
  }
  const add = local(item.addPage)
  cells.push(
    <AddPageGhost
      key="__add_page"
      x={add.x}
      y={add.y}
      width={add.w}
      height={add.h}
      edge={item.addPage.edge}
      onClick={() => onAddPage(doc.id)}
    />
  )

  const height = Math.max(item.height, reflow?.height ?? 0)
  return (
    <section className="doc-row" style={{ height }}>
      {cells}
    </section>
  )
}

export const DocumentRow = memo(DocumentRowImpl)
