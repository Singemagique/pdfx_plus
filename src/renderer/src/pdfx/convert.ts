import { imageToPdf, isImageBytes, isImageFile, stripImageExtension } from './images'
import { buildMarkupPdf, isMarkupFile, stripMarkupExtension, type PageSize } from './markup'

export type { PageSize }

interface Converter {
  match: (name: string, data: Uint8Array) => boolean
  toPdf: (name: string, data: Uint8Array, fit?: PageSize, path?: string) => Promise<Uint8Array>
  rename: (name: string) => string
}

const converters: Converter[] = [
  {
    match: (name, data) => isImageFile(name) || isImageBytes(data),
    toPdf: (_name, data, fit) => imageToPdf(data, fit),
    rename: stripImageExtension
  },
  {
    match: (name) => isMarkupFile(name),
    toPdf: (name, data, fit, path) => buildMarkupPdf(name, data, fit, path),
    rename: stripMarkupExtension
  }
]

export const findConverter = (name: string, data: Uint8Array): Converter | null =>
  converters.find((c) => c.match(name, data)) ?? null
