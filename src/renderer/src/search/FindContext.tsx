// React access to the find controller. The default value is an inert controller, so components
// that read find state (page cells, full-view pages) also work — showing nothing — without a
// provider, as they do in isolated tests.

import { createContext, useContext, useSyncExternalStore } from 'react'
import type { FindBarState, FindController, PageFindStatus, PageHighlight } from './find-controller'

const CLOSED_BAR: FindBarState = Object.freeze({
  open: false,
  query: '',
  focusNonce: 0,
  total: 0,
  capped: false,
  currentIndex: -1,
  pagesMatched: 0,
  indexing: false,
  indexed: 0,
  indexTotal: 0
})
const NO_HIGHLIGHTS: readonly PageHighlight[] = Object.freeze([])
const noop = (): void => {}

export const NULL_FIND_CONTROLLER: FindController = {
  subscribe: () => noop,
  getBarState: () => CLOSED_BAR,
  getRawQuery: () => '',
  getPageStatus: () => null,
  getPageHighlights: () => NO_HIGHLIGHTS,
  getCurrentMatch: () => null,
  open: noop,
  close: noop,
  setQuery: noop,
  flush: () => false,
  next: noop,
  prev: noop,
  setDocs: noop,
  setOverlays: noop,
  cancelTimers: noop,
  text: {
    setSupplement: () => false,
    readNative: async () => undefined,
    onNativeText: () => noop,
    getPageText: () => undefined
  }
}

const FindContext = createContext<FindController>(NULL_FIND_CONTROLLER)

export function FindProvider({
  value,
  children
}: {
  value: FindController
  children: React.ReactNode
}): React.JSX.Element {
  return <FindContext.Provider value={value}>{children}</FindContext.Provider>
}

export function useFindController(): FindController {
  return useContext(FindContext)
}

/** 'current' / 'hit' / null for one page occurrence; re-renders only when that changes. */
export function usePageFindStatus(pageId: string): PageFindStatus {
  const ctl = useFindController()
  return useSyncExternalStore(ctl.subscribe, () => ctl.getPageStatus(pageId))
}

/** The match rects on one page (page px), identity-stable until the results change. */
export function usePageHighlights(pageId: string): readonly PageHighlight[] {
  const ctl = useFindController()
  return useSyncExternalStore(ctl.subscribe, () => ctl.getPageHighlights(pageId))
}

export function useFindBarState(controller?: FindController): FindBarState {
  const fromContext = useFindController()
  const ctl = controller ?? fromContext
  return useSyncExternalStore(ctl.subscribe, ctl.getBarState)
}
