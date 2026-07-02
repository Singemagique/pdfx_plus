import { resolve } from 'path'

// The set of filesystem paths the main process has surfaced to the renderer — via the open dialog,
// the clipboard, drag-drop expansion, or an OS "open with" / CLI arg. read-resource resolves an
// HTML file's relative resources against a base directory the renderer supplies; gating that base to
// paths the user ACTUALLY opened stops a compromised renderer from turning read-resource into an
// arbitrary-file-read (`dirname('C:/Users/v/.ssh/x')` + ref `id_rsa`) or an outbound-SMB primitive.
const opened = new Set<string>()

const key = (p: string): string => resolve(p)

/** Record every path handed to the renderer (called from the single readFiles chokepoint). */
export function rememberOpened(paths: readonly string[]): void {
  for (const p of paths) {
    if (typeof p === 'string' && p) {
      try {
        opened.add(key(p))
      } catch {
        // resolve() can throw on pathological input — just don't remember it.
      }
    }
  }
}

/** True only if `p` is a path the user actually opened this session. */
export function isOpenedPath(p: string): boolean {
  if (typeof p !== 'string' || !p) return false
  try {
    return opened.has(key(p))
  } catch {
    return false
  }
}

/** Test-only: drop all remembered paths. */
export function _resetOpenedPaths(): void {
  opened.clear()
}
