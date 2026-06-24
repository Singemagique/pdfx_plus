import { dirname, resolve, relative, isAbsolute, extname } from 'path'
import { readFile, stat, realpath } from 'fs/promises'

export const RESOURCE_MIME: Record<string, string> = {
  css: 'text/css',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf'
}

export const RESOURCE_MAX = 12 * 1024 * 1024

export async function readResource(
  htmlPath: string,
  ref: string
): Promise<{ data: Uint8Array; mime: string } | null> {
  try {
    const baseDir = dirname(htmlPath)
    const target = resolve(baseDir, decodeURIComponent(ref.split(/[?#]/)[0]))
    const realBase = await realpath(baseDir)
    const real = await realpath(target)
    const within = relative(realBase, real)
    if (!within || within.startsWith('..') || isAbsolute(within)) return null
    const info = await stat(real)
    if (!info.isFile() || info.size > RESOURCE_MAX) return null
    const mime = RESOURCE_MIME[extname(real).slice(1).toLowerCase()] ?? 'application/octet-stream'
    return { data: new Uint8Array(await readFile(real)), mime }
  } catch {
    return null
  }
}
