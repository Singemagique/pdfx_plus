// React access to text recognition for the OCR surfaces (DESIGN.md §3.8). Two contexts:
// - OcrStoreContext: the store, the Find supply and the app's actions. Stable for the session, so
//   a page badge (one per cell) subscribes to ITS page only, through the store;
// - OcrSummaryContext: the collection summary (ocr-ui.ts), the store snapshot and the per-document
//   runs, rebuilt by OcrUiProvider on each store notification (≤ 10 Hz). The provider takes the
//   app tree as `children`, so a notification re-renders only the components reading it.
// The defaults are inert (no store: every surface renders nothing), as FindContext's are, so the
// components work in isolated tests without a provider.

import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import type { DocEntry } from '../types'
import type { OcrFindSupply } from './ocr-find-supply'
import type { OcrPageState, OcrSnapshot, OcrStore } from './ocr-store'
import { nextRuns, runProgress, summarizeOcr, type CollectionOcr } from './ocr-ui'

/** What the Recognize dialog is opened for. */
export interface OcrDialogRequest {
  mode?: 'recognize' | 'replace'
  /** Fixed pages (a summary row's Replace…); otherwise the dialog offers its scopes. */
  keys?: readonly string[]
}

export interface OcrActions {
  /** Recognize Text… / Replace Recognized Text… (the dialog). */
  openDialog(req?: OcrDialogRequest): void
  /** The one-click paths (banner, chip, Find row): the remembered settings, no dialog. */
  recognizeNow(keys: readonly string[]): void
  /** The summary popover, anchored to `anchor`, for one document or (null) all of them. */
  openSummary(anchor: HTMLElement | null, docId: string | null): void
  /** Open a page in full view (a summary row's [View]). */
  viewPage(docId: string, pageId: string): void
  /** The existing undoable rotate (a summary row's [Rotate]). */
  rotatePage(pageKey: string, delta: number): void
}

export interface OcrStoreValue {
  store: OcrStore | null
  supply: OcrFindSupply | null
  actions: OcrActions
}

const noop = (): void => {}
export const NULL_OCR_ACTIONS: OcrActions = {
  openDialog: noop,
  recognizeNow: noop,
  openSummary: noop,
  viewPage: noop,
  rotatePage: noop
}

const OcrStoreContext = createContext<OcrStoreValue>({
  store: null,
  supply: null,
  actions: NULL_OCR_ACTIONS
})

export interface OcrSummaryValue {
  summary: CollectionOcr
  snapshot: OcrSnapshot
  /** Per document: its current run's "done / total" (only while some of its pages are worked on). */
  runs: ReadonlyMap<string, { done: number; total: number }>
  /** Document ▸ Show Recognized Text (session state; the overlay that reads it is PR10's). */
  showRecognizedText: boolean
}

const EMPTY_SNAPSHOT: OcrSnapshot = Object.freeze({
  version: 0,
  link: 'unavailable',
  unavailable: null,
  batches: Object.freeze([]) as OcrSnapshot['batches'],
  running: false
}) as OcrSnapshot

export const EMPTY_SUMMARY: CollectionOcr = summarizeOcr([], { getPageState: () => null })

const OcrSummaryContext = createContext<OcrSummaryValue>({
  summary: EMPTY_SUMMARY,
  snapshot: EMPTY_SNAPSHOT,
  runs: new Map(),
  showRecognizedText: false
})

const noSubscribe = (): (() => void) => noop

interface ProviderProps {
  value: OcrStoreValue
  docs: readonly DocEntry[]
  showRecognizedText?: boolean
  children: ReactNode
}

export function OcrUiProvider({
  value,
  docs,
  showRecognizedText = false,
  children
}: ProviderProps): ReactNode {
  const { store } = value
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    () => store?.getSnapshot() ?? EMPTY_SNAPSHOT
  )
  const runsRef = useRef<Map<string, Set<string>>>(new Map())
  const summaryValue = useMemo<OcrSummaryValue>(() => {
    const summary = store ? summarizeOcr(docs, store) : EMPTY_SUMMARY
    runsRef.current = nextRuns(
      runsRef.current,
      new Map(summary.docs.map((d) => [d.docId, d.working]))
    )
    const runs = new Map<string, { done: number; total: number }>()
    for (const d of summary.docs)
      if (d.working.length > 0)
        runs.set(d.docId, runProgress(runsRef.current.get(d.docId), d.working))
    return { summary, snapshot, runs, showRecognizedText }
    // `snapshot` stands for every store change (its identity changes with its version).
  }, [store, docs, snapshot, showRecognizedText])
  return (
    <OcrStoreContext.Provider value={value}>
      <OcrSummaryContext.Provider value={summaryValue}>{children}</OcrSummaryContext.Provider>
    </OcrStoreContext.Provider>
  )
}

export function useOcrStore(): OcrStoreValue {
  return useContext(OcrStoreContext)
}

export function useOcrSummary(): OcrSummaryValue {
  return useContext(OcrSummaryContext)
}

/** One page's OCR state, re-rendering only when it changes (null: no store or not live). */
export function useOcrPageState(pageKey: string): OcrPageState | null {
  const { store } = useOcrStore()
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, () =>
    store ? store.getPageState(pageKey) : null
  )
}

/** The store's settings (identity changes when they do). */
export function useOcrSettings(): ReturnType<OcrStore['settings']> | null {
  const { store } = useOcrStore()
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, () => store?.settings() ?? null)
}
