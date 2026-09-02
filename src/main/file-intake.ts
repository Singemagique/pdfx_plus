import { basename, join } from 'path'
import { existsSync } from 'fs'
import { readFile, readdir, stat } from 'fs/promises'
import { rememberOpened } from './opened-paths'

export interface OpenedFile {
  name: string
  data: Uint8Array
  path?: string
}

export const IMPORTABLE = /\.(pdf|pdfx|png|jpe?g|webp|gif|bmp|avif|txt|rtf|svg|html?)$/i

export function collectFileArgs(argv: string[]): string[] {
  return argv.filter((arg) => /\.(pdf|pdfx)$/i.test(arg) && existsSync(arg))
}

export interface ReadFilesReport {
  files: OpenedFile[]
  /** The paths that could not be read, so the caller can tell the user rather than silently drop. */
  skipped: string[]
}

export async function readFilesReport(paths: string[]): Promise<ReadFilesReport> {
  // Per-file tolerant: one unreadable path (locked file, a directory named x.pdf, a TOCTOU delete)
  // must not sink the whole batch — callers include fire-and-forget open-file/second-instance
  // handlers, where an all-or-nothing rejection silently drops every other file.
  const results = await Promise.allSettled(
    paths.map(async (p) => ({
      name: basename(p),
      data: new Uint8Array(await readFile(p)),
      path: p
    }))
  )
  const opened: OpenedFile[] = []
  const read: string[] = []
  const skipped: string[] = []
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      opened.push(result.value)
      read.push(result.value.path)
    } else {
      // Reported to the caller as well as the console: a user who drops five files and gets three
      // back has no way to tell the two silent skips from files PDFx simply refused to show.
      skipped.push(String(paths[i]))
      console.warn(`pdfx: skipping unreadable file ${String(paths[i])}:`, result.reason)
    }
  })
  // Every path that becomes an OpenedFile flows through here — record them so read-resource can
  // later verify an HTML resource base is a file the user actually opened. Only the paths whose
  // bytes were actually delivered to the renderer are remembered: `paths` is untrusted input on
  // the clipboard/drop routes, so remembering ahead of the reads would let a renderer poison the
  // allowlist with any path it likes (nonexistent or unreadable) and unlock read-resource for it.
  rememberOpened(read)
  return { files: opened, skipped }
}

/** Files-only view of {@link readFilesReport}, for callers with nowhere to show a notice. */
export async function readFiles(paths: string[]): Promise<OpenedFile[]> {
  return (await readFilesReport(paths)).files
}

/** How many skipped names a notice spells out before collapsing the rest into "+N more". */
const MAX_LISTED_SKIPPED = 5

/** One-line, user-facing summary of the paths readFiles could not read. */
export function skippedNotice(skipped: string[]): string {
  const names = skipped.map((p) => basename(p))
  const listed = names.slice(0, MAX_LISTED_SKIPPED)
  const extra = names.length - listed.length
  const tail = extra > 0 ? `${listed.join(', ')} +${extra} more` : listed.join(', ')
  return `Could not read ${names.length} file${names.length === 1 ? '' : 's'}: ${tail}`
}

export const importable = (p: string): boolean => IMPORTABLE.test(p) && !basename(p).startsWith('.')

// Reject UNC roots (\\server\share, //server/share): touching one triggers outbound SMB and a
// compromised renderer could use it to enumerate network shares / leak an NTLM hash. Applied to
// every untrusted path entering the main process (drag-drop and clipboard alike).
export const isUncPath = (p: string): boolean => /^[\\/]{2}/.test(p)

// Bound a single drag-drop expansion so a deeply nested or pathological directory
// tree can't make the renderer read an unbounded number of files into memory.
export const MAX_DROP_FILES = 10_000

export async function expandDropPaths(paths: string[]): Promise<string[]> {
  const out: string[] = []
  for (const p of paths) {
    if (out.length >= MAX_DROP_FILES) break
    // Guard BEFORE any filesystem call — the UNC reject only works if nothing touches the path.
    if (typeof p !== 'string' || !p || isUncPath(p)) continue
    try {
      const info = await stat(p)
      if (info.isDirectory()) {
        const entries = await readdir(p, { recursive: true, withFileTypes: true })
        out.push(
          // isFile() is false for symlinks and directories, so symlinked entries
          // are skipped and the recursive walk never follows a link out of the tree.
          ...entries
            .filter((e) => e.isFile())
            .map((e) => join(e.parentPath ?? p, e.name))
            .filter(importable)
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
        )
      } else if (info.isFile() && importable(p)) {
        out.push(p)
      }
    } catch {
      continue
    }
  }
  return out.slice(0, MAX_DROP_FILES)
}
