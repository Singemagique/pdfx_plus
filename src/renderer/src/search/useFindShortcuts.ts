import { useEffect } from 'react'
import type { FindController } from './find-controller'

/**
 * Window-level Find keys for when focus is outside the find bar (the bar handles its own keys and
 * stops them there): Ctrl/Cmd+F opens it, F3 / Ctrl/Cmd+G step to the next match (Shift: the
 * previous one), opening the bar first if it is closed. The menu's Find… item covers Ctrl/Cmd+F too;
 * opening is idempotent, so both firing is harmless.
 */
export function useFindShortcuts({
  controller,
  enabled
}: {
  controller: FindController
  enabled: boolean
}): void {
  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()
      if (mod && !event.altKey && key === 'f') {
        event.preventDefault()
        controller.open()
      } else if (event.key === 'F3' || (mod && !event.altKey && key === 'g')) {
        event.preventDefault()
        if (!controller.getBarState().open) controller.open()
        else if (event.shiftKey) controller.prev()
        else controller.next()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [controller, enabled])
}
