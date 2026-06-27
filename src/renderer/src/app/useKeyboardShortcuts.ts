import { useEffect } from 'react'
import type { PageRef } from './types'

interface KeyboardShortcutDeps {
  active: boolean
  selected: PageRef | null
  onDeletePage: (target: PageRef) => void
  onDuplicate: (target: PageRef) => void
  onCopy: () => void
  onPaste: () => void
  onClearSelection: () => void
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
}

export function useKeyboardShortcuts({
  active,
  selected,
  onDeletePage,
  onDuplicate,
  onCopy,
  onPaste,
  onClearSelection
}: KeyboardShortcutDeps): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!active || isEditableTarget(event.target)) return
      const mod = event.metaKey || event.ctrlKey
      if ((event.key === 'Backspace' || event.key === 'Delete') && selected) {
        event.preventDefault()
        onDeletePage(selected)
      } else if (mod && event.key.toLowerCase() === 'd' && selected) {
        event.preventDefault()
        onDuplicate(selected)
      } else if (mod && event.key.toLowerCase() === 'c' && selected) {
        onCopy()
      } else if (mod && event.key.toLowerCase() === 'v') {
        onPaste()
      } else if (event.key === 'Escape') {
        onClearSelection()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, selected, onDeletePage, onDuplicate, onCopy, onPaste, onClearSelection])
}
