import { clipboard } from 'electron'

/** Copy Page Text's ceiling (DESIGN.md §3.6.3): 16 MB of UTF-8, far above any real page. */
export const MAX_CLIPBOARD_TEXT_BYTES = 16 * 1024 * 1024

/**
 * `pdfx:clipboard-write-text`: put plain text on the clipboard for the renderer (Copy Page Text).
 * Refuses anything that is not a string, and strings over 16 MB, so a compromised renderer cannot
 * push an unbounded payload through main.
 */
export function writeClipboardText(text: unknown): void {
  if (typeof text !== 'string') throw new Error('clipboard-write-text: refusing a non-string')
  // UTF-16 length × 3 bounds the UTF-8 size: only measure exactly when it could be over.
  if (
    text.length * 3 > MAX_CLIPBOARD_TEXT_BYTES &&
    Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_TEXT_BYTES
  )
    throw new Error('clipboard-write-text: text too large')
  clipboard.writeText(text)
}

export function clipboardFilePaths(): string[] {
  const paths: string[] = []
  if (process.platform === 'darwin') {
    const plist = clipboard.readBuffer('NSFilenamesPboardType').toString('utf8')
    for (const match of plist.matchAll(/<string>([\s\S]*?)<\/string>/g)) {
      paths.push(match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
    }
    if (paths.length === 0) {
      const url = clipboard.read('public.file-url')
      if (url?.startsWith('file://')) paths.push(decodeURIComponent(new URL(url).pathname))
    }
  } else if (process.platform === 'win32') {
    const buffer = clipboard.readBuffer('FileNameW')
    if (buffer.length > 0) {
      const path = buffer.toString('ucs2').replace(/\0+$/g, '')
      if (path) paths.push(path)
    }
  } else {
    for (const line of clipboard.readText().split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('file://')) paths.push(decodeURIComponent(new URL(trimmed).pathname))
    }
  }
  return paths
}
