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

export async function readFiles(paths: string[]): Promise<OpenedFile[]> {
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
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      opened.push(result.value)
      read.push(result.value.path)
    } else console.warn(`pdfx: skipping unreadable file ${String(paths[i])}:`, result.reason)
  })
  // Every path that becomes an OpenedFile flows through here — record them so read-resource can
  // later verify an HTML resource base is a file the user actually opened. Only the paths whose
  // bytes were actually delivered to the renderer are remembered: `paths` is untrusted input on
  // the clipboard/drop routes, so remembering ahead of the reads would let a renderer poison the
  // allowlist with any path it likes (nonexistent or unreadable) and unlock read-resource for it.
  rememberOpened(read)
  return opened
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
