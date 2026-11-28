// Copy Page Text (DESIGN.md §3.6.3): the Document-menu and full-view context-menu command (PR8
// wires the menu item to this). The page's native and/or recognised text in source order, single
// spaces, one line per line (search/copy-text.ts `pageCopyText`), built from the SAME filtered
// items Find searches: native text minus what a redaction covers, recognised words minus the words
// under a redaction or over an object the redaction pass will remove (ocr-find-supply.ts). The
// clipboard is written through main (`pdfx:clipboard-write-text`): `navigator.clipboard` needs a
// focused document and user activation, which a native-menu command does not reliably give.

import { pageCopyText } from '../search/copy-text'
import type { FindTextAccess } from '../search/find-controller'
import type { OcrFindSupply } from './ocr-find-supply'

export interface CopyPageTextDeps {
  text: FindTextAccess
  supply: Pick<OcrFindSupply, 'ensure'>
  /** `window.api.writeClipboardText`. */
  write: (text: string) => Promise<void>
}

export type CopyPageTextResult =
  | { copied: true; chars: number }
  /** `empty`: the page has no text (after redaction filtering); `failed`: the clipboard refused. */
  | { copied: false; reason: 'empty' | 'failed' }

/** Copy one page's text (by page key) to the clipboard. */
export async function copyPageText(
  pageKey: string,
  deps: CopyPageTextDeps
): Promise<CopyPageTextResult> {
  // Native text read and the recognised text supplied (with its removal report) first, so a page
  // nobody searched yet copies all of its text, and a redacted one copies none it should not.
  await deps.supply.ensure(pageKey)
  const pt = deps.text.getPageText(pageKey)
  const s = pt ? pageCopyText(pt.items) : ''
  if (!s) return { copied: false, reason: 'empty' }
  try {
    await deps.write(s)
  } catch (err) {
    console.warn('Copy Page Text: the clipboard refused the text', err)
    return { copied: false, reason: 'failed' }
  }
  return { copied: true, chars: s.length }
}
