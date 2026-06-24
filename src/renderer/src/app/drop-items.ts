import { isImageFile } from '../pdfx/images'
import { isMarkupFile } from '../pdfx/markup'

const DROPPABLE_MIME_TYPES = ['application/pdf', 'application/rtf']
const PDF_FILENAME = /\.(pdf|pdfx)$/i

function isDroppableMime(type: string): boolean {
  return (
    type === '' ||
    DROPPABLE_MIME_TYPES.includes(type) ||
    type.startsWith('image/') ||
    type.startsWith('text/')
  )
}

export function countDroppableItems(items: DataTransferItemList): number {
  let count = 0
  for (const item of Array.from(items)) {
    if (item.kind === 'file' && isDroppableMime(item.type)) count++
  }
  return count
}

export function isDroppableFile(name: string, type: string): boolean {
  return (
    PDF_FILENAME.test(name) ||
    isImageFile(name) ||
    isMarkupFile(name) ||
    type.startsWith('image/') ||
    type.startsWith('text/')
  )
}
