// The full-view banner's "at most once per document per session" (DESIGN.md §3.8), as App wires it:
// useBannerSeen(document in full view) with a child that reports the banner showed (OcrBanner's
// onShown runs in a child effect, before the hook's own effect in the same commit).

import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useBannerSeen, type BannerSeen } from './useBannerSeen'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
let latest: BannerSeen

/** Stands in for OcrBanner: it shows when the document has scans and was not seen. */
function Banner({ docId, scans }: { docId: string; scans: ReadonlySet<string> }): null {
  const offer = scans.has(docId) && !latest.seen.has(docId)
  const { onShown } = latest
  useEffect(() => {
    if (offer) onShown(docId)
  }, [offer, docId, onShown])
  return null
}

function Host({
  view,
  scans
}: {
  view: string | null
  scans: ReadonlySet<string>
}): React.JSX.Element | null {
  latest = useBannerSeen(view)
  return view ? createElement(Banner, { docId: view, scans }) : null
}

const scans = new Set(['A', 'B'])
const show = (view: string | null, s: ReadonlySet<string> = scans): Promise<void> =>
  act(async () => root.render(createElement(Host, { view, scans: s })))

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('useBannerSeen', () => {
  it('close full view after the banner showed: reopening the same document shows no banner', async () => {
    await show('A')
    expect(latest.seen.has('A')).toBe(false) // showing now, not yet seen
    await show(null)
    expect(latest.seen.has('A')).toBe(true)
    await show('A')
    expect(latest.seen.has('A')).toBe(true)
  })

  it('A → B (a document without the banner) → A: A is not offered again', async () => {
    await show('A', new Set(['A']))
    await show('B', new Set(['A']))
    expect(latest.seen.has('A')).toBe(true)
    await show('A', new Set(['A']))
    expect(latest.seen.has('A')).toBe(true)
  })

  it('A → B when B shows its banner too: both are remembered once full view leaves them', async () => {
    await show('A')
    await show('B') // B's banner reports in before the hook sees the move away from A
    expect(latest.seen.has('A')).toBe(true)
    expect(latest.seen.has('B')).toBe(false)
    await show(null)
    expect([...latest.seen].sort()).toEqual(['A', 'B'])
  })

  it('an answer (Not now, Recognize, Stop) marks the document at once', async () => {
    await show('A')
    await act(async () => latest.onDone('A'))
    expect(latest.seen.has('A')).toBe(true)
  })

  it('a document full view never showed the banner for is not marked', async () => {
    await show('A', new Set())
    await show(null, new Set())
    expect(latest.seen.size).toBe(0)
  })
})
