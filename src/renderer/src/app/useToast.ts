// The app's one toast (`flash`). A toast with a button ([Resume], [Details]) stays until it is used,
// dismissed or replaced: on a timer a keyboard or screen-reader user could rarely reach the button
// in time, and for "Text recognition couldn't start" it is the way to the error code (WCAG 2.2.1,
// timing adjustable). A plain toast goes after TOAST_MS.

import { useCallback, useEffect, useRef, useState } from 'react'

export const TOAST_MS = 4000

export interface ToastAction {
  label: string
  run: () => void
}

export interface Toast {
  message: string
  action?: ToastAction
}

export function useToast(): {
  toast: Toast | null
  flash: (message: string, action?: ToastAction) => void
  dismiss: () => void
} {
  const [toast, setToast] = useState<Toast | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stop = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  const flash = useCallback((message: string, action?: ToastAction) => {
    stop()
    setToast({ message, action })
    if (!action) timer.current = setTimeout(() => setToast(null), TOAST_MS)
  }, [])
  const dismiss = useCallback(() => {
    stop()
    setToast(null)
  }, [])
  useEffect(() => stop, [])
  return { toast, flash, dismiss }
}
