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
  // Every path that becomes an OpenedFile flows through here — record them so read-resource can
  // later verify an HTML resource base is a file the user actually opened.
  rememberOpened(paths)
  return Promise.all(
    paths.map(async (p) => ({
      name: basename(p),
      data: new Uint8Array(await readFile(p)),
      path: p
    }))
  )
}

export const importable = (p: string): boolean => IMPORTABLE.test(p) && !basename(p).startsWith('.')

// Bound a single drag-drop expansion so a deeply nested or pathological directory
// tree can't make the renderer read an unbounded number of files into memory.
const MAX_DROP_FILES = 10_000

export async function expandDropPaths(paths: string[]): Promise<string[]> {
  const out: string[] = []
  for (const p of paths) {
    if (out.length >= MAX_DROP_FILES) break
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
