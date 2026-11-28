// The Recognize Text… / Replace Recognized Text… dialog (DESIGN.md §3.8 "Dialog", "Language
// picker"), in the Sign dialog's modal pattern (focus trap, Esc). Pages scope, language chips with
// a searchable picker (Included, Installed and Download groups with native names, sizes and the
// host; CJK labelled; "Install from file…" in its footer, PR9), the auto-recognise settings, the
// privacy line, the D8 wording and the D7 export
// setting. Opening it asks the store to triage the collection (Stage 0 gate (b)), so the counts
// fill in as triage answers. Settings are saved when the user recognises, never on Cancel.
//
// "[✓] Fix page orientation for reading" (§3.8) is not shown: the engine always reads a page the
// way up it detects (PR6), and nothing yet carries the setting to it, so a box that could be
// unticked would promise something the app does not do. It returns with the engine option.
//
// Modal for real: focus never rests outside the box. A control that unmounts while focused (the
// picker on Esc or on choosing a language, a removed chip) hands focus to one that stays, and a
// window listener catches any key or focus that still lands outside, so Esc keeps closing the
// dialog and Delete never removes the page behind it.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLangPacks, useOcrSettings, useOcrStore, useOcrSummary } from '../../ocr/OcrContext'
import {
  CJK_NOTE,
  INCLUDED_LANGS,
  MAX_LANGS,
  installErrorCopy,
  langLabel,
  langMatches,
  langName,
  langOption,
  notInstalledCopy,
  pagesWord,
  type LangInfo,
  type LangOption
} from '../../ocr/ocr-ui'
import { LangDownloadPrompt } from './LangDownloadPrompt'
import { isSignedSource, SIGNED_SOURCE_NOTE } from '../../ocr/signed-source'
import type { DocEntry } from '../../types'
import { makePageKey } from '../../edit/model'
import { CloseIcon } from '../icons'

export const DIALOG_COPY = {
  langHint: 'Pick every language on these pages. Fewer is faster.',
  autoImports: 'Recognize imported photos automatically',
  autoOpened: 'Recognize scanned pages when I open PDFs',
  privacy: 'Runs on this computer. Nothing is uploaded.',
  layer: 'The page images are not changed; an invisible text layer is added when you export.',
  include: 'Include recognized text when exporting',
  keep: 'Recognition is kept while the file is open. Export or save as .pdfx to keep it.'
} as const

type Scope = 'doc' | 'all' | 'page'

export interface RecognizeDialogProps {
  mode: 'recognize' | 'replace'
  /** Fixed pages (a summary row's Replace…): no scope choice. */
  fixedKeys?: readonly string[]
  /** The document and page in view (full view) or selected (collection). */
  focusDocId: string | null
  focusPageKey: string | null
  inFullView: boolean
  docs: readonly DocEntry[]
  /** Extra installed languages (tests); the language packs' own list is used as well. */
  installed?: readonly LangInfo[]
  onClose: () => void
}

function LockIcon(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

/**
 * The box's Tab stops in order, as the browser walks them: of a radio group only the checked radio
 * (else the group's first) is a stop, so the trap's first and last are the real ends.
 */
export function tabStops(box: HTMLElement): HTMLElement[] {
  const all = [
    ...box.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'
    )
  ]
    .filter((el) => el.tabIndex >= 0)
    // Document order, whatever order the selector engine returns a selector list in.
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
  const radio = (el: HTMLElement): el is HTMLInputElement =>
    el instanceof HTMLInputElement && el.type === 'radio' && !!el.name
  return all.filter((el) => {
    if (!radio(el)) return true
    const group = all.filter((o): o is HTMLInputElement => radio(o) && o.name === el.name)
    return el === (group.find((g) => g.checked) ?? group[0])
  })
}

export function RecognizeDialog({
  mode,
  fixedKeys,
  focusDocId,
  focusPageKey,
  inFullView,
  docs,
  installed = [],
  onClose
}: RecognizeDialogProps): React.JSX.Element | null {
  const { store } = useOcrStore()
  const { summary } = useOcrSummary()
  const settings = useOcrSettings()
  const replace = mode === 'replace'

  // Stage 0 gate (b): the dialog opened, so every live page's source is triaged now.
  const liveKeys = useMemo(
    () => docs.flatMap((d) => d.pages.map((p) => makePageKey(p.source.id, p.pageIndex))),
    [docs]
  )
  useEffect(() => {
    store?.prepare(liveKeys)
    // Once per opening: later docs changes are triaged by the store's own gates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])

  const focusDoc = focusDocId ? summary.byDoc.get(focusDocId) : undefined
  const docKeys = focusDoc ? (replace ? focusDoc.replaceable : focusDoc.unrecognized) : []
  const allKeys = replace ? summary.replaceable : summary.unrecognized
  type ScopeRow = { id: Scope; label: string; keys: readonly string[] }
  const allScope: ScopeRow = {
    id: 'all',
    label: `${replace ? 'Pages with recognized text' : 'Scanned pages'} in all documents (${allKeys.length})`,
    keys: allKeys
  }
  // Only scopes with something to act on (a "(0)" choice would leave a disabled primary button),
  // and the page scope only while its page is still in the collection. With nothing anywhere, the
  // collection-wide row stays, with its 0, so the dialog still says why the button is off.
  const offered: ScopeRow[] = fixedKeys
    ? [
        {
          id: 'page',
          label: fixedKeys.length === 1 ? 'This page' : pagesWord(fixedKeys.length),
          keys: fixedKeys
        }
      ]
    : [
        ...(focusDoc
          ? [
              {
                id: 'doc' as const,
                label: `${replace ? 'Pages with recognized text' : 'Scanned pages'} in this document (${docKeys.length})`,
                keys: docKeys
              }
            ]
          : []),
        allScope,
        ...(focusPageKey && summary.byKey.has(focusPageKey)
          ? [
              {
                id: 'page' as const,
                label: inFullView ? 'This page' : 'Selected page',
                keys: [focusPageKey]
              }
            ]
          : [])
      ].filter((s) => s.keys.length > 0)
  const scopes: ScopeRow[] = offered.length > 0 ? offered : [allScope]
  const initialScope = (): Scope => {
    if (fixedKeys) return 'page'
    if (focusDoc && docKeys.length > 0) return 'doc'
    if (allKeys.length > 0 || !scopes.some((s) => s.id === 'page')) return 'all'
    return 'page'
  }
  // Until the user picks one, the default follows the counts as triage fills them in.
  const [chosen, setScope] = useState<Scope | null>(null)
  const scope = chosen ?? initialScope()
  const current = scopes.find((s) => s.id === scope) ?? scopes[0]
  const keys = current?.keys ?? []

  const [langs, setLangs] = useState<string[]>(() => [...(settings?.['ocr.languages'] ?? ['eng'])])
  const [autoImports, setAutoImports] = useState(settings?.['ocr.autoRecognizeImports'] ?? true)
  const [autoOpened, setAutoOpened] = useState(settings?.['ocr.autoRecognizeOpened'] ?? false)
  const [include, setInclude] = useState(settings?.['ocr.includeInExports'] ?? true)
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState('')
  /** The Download option the consent prompt is open for. */
  const [consent, setConsent] = useState<string | null>(null)
  /** What the last Install from file… said. */
  const [installNote, setInstallNote] = useState<string | null>(null)
  const { langs: packs, snapshot: packSnap } = useLangPacks()
  const [submitting, setSubmitting] = useState(false)

  const signed = useMemo(
    () => docs.some((d) => d.pages.some((p) => isSignedSource(p.source?.bytes))),
    [docs]
  )

  const box = useRef<HTMLDivElement | null>(null)
  /** What Esc does now (the picker first, then the dialog); read by the window guard. */
  const escape = useRef<() => void>(() => {})
  /** Where focus goes after the render that unmounts the focused control. */
  const refocus = useRef<{ kind: 'add' } | { kind: 'chip'; index: number } | null>(null)

  // The window guard (declared before the focus effect below, so its cleanup runs first and never
  // pulls the restored focus back): a key or focus outside the box belongs to the dialog.
  useEffect(() => {
    const outside = (t: EventTarget | null): HTMLElement | null => {
      const b = box.current
      return b && !b.contains(t as Node | null) ? b : null
    }
    const onKey = (e: KeyboardEvent): void => {
      const b = outside(e.target)
      if (!b) return // inside: the box's own handler has it
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        escape.current()
      } else if (e.key === 'Tab') {
        e.preventDefault()
        const stops = tabStops(b)
        ;(e.shiftKey ? stops[stops.length - 1] : stops[0])?.focus()
      }
    }
    const onFocus = (e: FocusEvent): void => {
      const b = outside(e.target)
      if (b) tabStops(b)[0]?.focus()
    }
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', onFocus, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', onFocus, true)
    }
  }, [])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const b = box.current
    ;(
      b?.querySelector<HTMLElement>('button.primary:not(:disabled)') ??
      b?.querySelector<HTMLElement>('input:checked, input, button')
    )?.focus()
    return () => {
      // The opener can be gone (the toolbar's Recognize Text button goes once nothing waits):
      // then the activity pill, else the toolbar's first button.
      const back =
        previous && previous !== document.body && previous.isConnected
          ? previous
          : (document.querySelector<HTMLElement>('.ocr-pill') ??
            document.querySelector<HTMLElement>('.toolbar .btn:not(:disabled)'))
      back?.focus()
    }
  }, [])
  const searchRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (picking) searchRef.current?.focus()
  }, [picking])
  useLayoutEffect(() => {
    const want = refocus.current
    const b = box.current
    if (!want || !b) return
    refocus.current = null
    const xs = [...b.querySelectorAll<HTMLElement>('.ocr-lang-x:not(:disabled)')]
    const addBtn = b.querySelector<HTMLElement>('.ocr-add-lang')
    const target =
      want.kind === 'chip'
        ? (xs[want.index] ?? xs[want.index - 1] ?? addBtn)
        : (addBtn ?? xs[xs.length - 1])
    ;(target ?? tabStops(b)[0])?.focus()
  })

  const closePicker = (): void => {
    consentFromChip.current = false
    setPicking(false)
    setQuery('')
    setConsent(null)
    setInstallNote(null)
    refocus.current = { kind: 'add' }
  }
  /** The consent prompt was opened from a chip's [Download] (not from the picker's list). */
  const consentFromChip = useRef(false)
  const closeConsent = (): void => {
    if (consentFromChip.current) {
      consentFromChip.current = false
      closePicker()
      return
    }
    setConsent(null)
    queueMicrotask(() => searchRef.current?.focus())
  }
  const downloadFromChip = (code: string): void => {
    consentFromChip.current = true
    setQuery('')
    setInstallNote(null)
    setPicking(true)
    setConsent(code)
  }
  escape.current = () => (consent ? closeConsent() : picking ? closePicker() : onClose())

  if (!store) return null

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // Keys stop at the dialog: window shortcuts (Delete removes a page, arrows flip pages) must not
    // fire from inside it.
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      escape.current()
      return
    }
    if (e.key !== 'Tab' || !box.current) return
    const stops = tabStops(box.current)
    if (stops.length === 0) return
    const first = stops[0]
    const last = stops[stops.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const isIncluded = (code: string): boolean => INCLUDED_LANGS.some((i) => i.code === code)
  // In English-name order (the UI's language), whatever script the native name is in.
  const packOptions = [...packSnap.list]
    .filter((p) => !isIncluded(p.code))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .map((p) => langOption(p, packSnap.progress.get(p.code)))
  const installedOptions: LangOption[] = [
    ...packOptions.filter((o) => packs?.installed().has(o.code)),
    ...installed
      .filter((l) => !isIncluded(l.code) && !packOptions.some((o) => o.code === l.code))
      .map((l) => ({ ...l, cjk: false }))
  ]
  const downloadOptions = packOptions.filter((o) => !packs?.installed().has(o.code))
  const usable = (l: LangInfo): boolean => !langs.includes(l.code) && langMatches(l, query)
  const included = INCLUDED_LANGS.filter(usable)
  const downloaded = installedOptions.filter(usable)
  const downloadable = downloadOptions.filter(usable)
  /** Enter takes the first language that needs no download. */
  const addable = [...included, ...downloaded]
  const add = (code: string): void => {
    setLangs((ls) => (ls.length >= MAX_LANGS || ls.includes(code) ? ls : [...ls, code]))
    closePicker()
  }
  const consentInfo = consent ? packSnap.list.find((p) => p.code === consent) : undefined
  /**
   * Chosen languages this computer doesn't have (remembered from another run, a file deleted or
   * refused at startup): marked on their chips, with [Download], before anything is recognized.
   */
  const notInstalled =
    packs && packSnap.loaded
      ? langs.filter(
          (c) => !isIncluded(c) && !packs.installed().has(c) && !installed.some((l) => l.code === c)
        )
      : []
  const installFromFile = async (): Promise<void> => {
    if (!packs) return
    setInstallNote(null)
    const r = await packs.installFromFile()
    if (r.ok) {
      if (langs.length < MAX_LANGS && !langs.includes(r.code)) add(r.code)
      else setInstallNote(`${langName(r.code)} is installed.`)
      return
    }
    setInstallNote(installErrorCopy(r))
  }
  const option = (l: LangOption | LangInfo, onPick: () => void): React.JSX.Element => {
    const o = l as Partial<LangOption>
    return (
      <button key={l.code} role="option" aria-selected={false} onClick={onPick}>
        <span className="ocr-picker-row">
          <span className="ocr-picker-name">{l.label}</span>
          {o.detail && <span className="ocr-picker-detail">{o.detail}</span>}
        </span>
        {o.cjk && <span className="ocr-picker-note">{CJK_NOTE}</span>}
      </button>
    )
  }
  const removeLang = (index: number): void => {
    setLangs((ls) => ls.filter((_, i) => i !== index))
    refocus.current = { kind: 'chip', index }
  }

  const canSubmit = keys.length > 0 && langs.length > 0 && !submitting
  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      await store.setSettings({
        'ocr.languages': langs,
        'ocr.autoRecognizeImports': autoImports,
        'ocr.autoRecognizeOpened': autoOpened,
        'ocr.includeInExports': include
      })
    } catch (err) {
      console.warn('ocr: could not save the recognition settings', err)
    }
    if (replace) store.replace(keys, langs)
    else store.recognize(keys, { langs })
    onClose()
  }

  const checking = summary.untriaged > 0
  const primary = replace
    ? `Replace text on ${pagesWord(keys.length)}`
    : `Recognize ${pagesWord(keys.length)}`
  const titleId = 'ocr-dialog-title'

  return (
    <div className="sign-overlay" onPointerDown={onClose}>
      <div
        ref={box}
        className="sign-dialog ocr-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{replace ? 'Replace Recognized Text' : 'Recognize Text'}</h2>

        <fieldset className="ocr-fieldset">
          <legend>Pages</legend>
          {scopes.map((s) => (
            <label key={s.id} className="sign-check">
              <input
                type="radio"
                name="ocr-scope"
                checked={current?.id === s.id}
                onChange={() => setScope(s.id)}
              />
              {s.label}
            </label>
          ))}
          {checking && !fixedKeys && <p className="sign-module-hint">Checking pages…</p>}
        </fieldset>

        <fieldset className="ocr-fieldset">
          <legend>Languages</legend>
          <div className="ocr-langs">
            {langs.map((code, i) => (
              <span
                key={code}
                className={`ocr-lang-chip${notInstalled.includes(code) ? ' ocr-lang-chip-missing' : ''}`}
              >
                {langLabel(code)}
                {notInstalled.includes(code) && (
                  <>
                    <span className="ocr-lang-chip-note"> · not installed</span>
                    {packSnap.list.some((p) => p.code === code) && (
                      <button
                        className="sign-link ocr-lang-chip-download"
                        aria-label={`Download ${langName(code)} language data`}
                        onClick={() => downloadFromChip(code)}
                      >
                        Download
                      </button>
                    )}
                  </>
                )}
                <button
                  className="ocr-lang-x"
                  aria-label={`Remove ${langLabel(code)}`}
                  disabled={langs.length === 1}
                  onClick={() => removeLang(i)}
                >
                  <CloseIcon size={10} />
                </button>
              </span>
            ))}
            {langs.length < MAX_LANGS && (
              <button
                className="sign-link ocr-add-lang"
                aria-expanded={picking}
                onClick={() => (picking ? closePicker() : setPicking(true))}
              >
                + Add language
              </button>
            )}
          </div>
          {notInstalled.length > 0 && !(picking && consentInfo) && (
            <p className="sign-module-hint ocr-lang-missing" role="note">
              {notInstalledCopy(notInstalled)}
            </p>
          )}
          {picking && consentInfo && (
            <div className="ocr-picker">
              <LangDownloadPrompt
                key={consentInfo.code}
                info={consentInfo}
                onInstalled={(code) => add(code)}
                onCancel={closeConsent}
              />
            </div>
          )}
          {picking && !consentInfo && (
            <div className="ocr-picker">
              <input
                ref={searchRef}
                className="sign-input"
                type="text"
                placeholder="Search languages"
                aria-label="Search languages"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && addable[0]) {
                    e.preventDefault()
                    add(addable[0].code)
                  }
                }}
              />
              <div
                className={`ocr-picker-list${downloadable.length > 0 ? ' ocr-picker-list-tall' : ''}`}
                role="listbox"
                aria-label="Languages"
              >
                {included.length > 0 && <div className="ocr-picker-group">Included</div>}
                {included.map((l) => option(l, () => add(l.code)))}
                {downloaded.length > 0 && <div className="ocr-picker-group">Installed</div>}
                {downloaded.map((l) => option(l, () => add(l.code)))}
                {downloadable.length > 0 && <div className="ocr-picker-group">Download</div>}
                {downloadable.map((l) => option(l, () => setConsent(l.code)))}
                {addable.length === 0 && downloadable.length === 0 && (
                  <p className="sign-module-hint">No other languages</p>
                )}
              </div>
              {packs && (
                <div className="ocr-picker-footer">
                  <button className="sign-link" onClick={() => void installFromFile()}>
                    Install from file…
                  </button>
                  {installNote && (
                    <p className="sign-module-hint" role="status">
                      {installNote}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
          <p className="sign-module-hint">{DIALOG_COPY.langHint}</p>
        </fieldset>

        <label className="sign-check">
          <input
            type="checkbox"
            checked={autoImports}
            onChange={(e) => setAutoImports(e.target.checked)}
          />
          {DIALOG_COPY.autoImports}
        </label>
        <label className="sign-check">
          <input
            type="checkbox"
            checked={autoOpened}
            onChange={(e) => setAutoOpened(e.target.checked)}
          />
          {DIALOG_COPY.autoOpened}
        </label>

        <div className="ocr-privacy">
          <p>
            <LockIcon /> {DIALOG_COPY.privacy}
          </p>
          <p>{DIALOG_COPY.layer}</p>
        </div>

        <label className="sign-check">
          <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} />
          {DIALOG_COPY.include}
        </label>
        <p className="sign-module-hint">{DIALOG_COPY.keep}</p>
        {signed && <p className="sign-module-hint ocr-signed-note">{SIGNED_SOURCE_NOTE}</p>}

        <div className="sign-actions">
          <button className="btn glass" onClick={onClose}>
            Cancel
          </button>
          <button className="btn glass primary" disabled={!canSubmit} onClick={() => void submit()}>
            {primary}
          </button>
        </div>
      </div>
    </div>
  )
}
