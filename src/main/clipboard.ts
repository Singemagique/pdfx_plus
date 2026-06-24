import { clipboard } from 'electron'

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
