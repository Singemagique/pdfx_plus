// The one-click OCR controls replace themselves when used: the chip's "Scanned · Recognize text"
// becomes "Recognizing 4 / 12 ✕", the banner's [Recognize 12 pages] becomes its [Stop], the
// toolbar's Recognize Text button goes once nothing waits. Removing the focused element drops focus
// to <body>, where keys reach the window shortcuts (Delete removes the selected page) and a
// keyboard or screen-reader user loses their place. This hook moves focus to what replaced it.

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * After each render of the owner: if focus was last inside `region` and is now nowhere (on
 * <body>), focus `pick()`. `region` is an element that outlives the controls it holds (it may use
 * `display: contents`); `pick` reads the DOM as it is after the render.
 */
export function useFocusRescue(
  region: RefObject<HTMLElement | null>,
  pick: () => HTMLElement | null | undefined
): void {
  const inside = useRef(false)
  const pickRef = useRef(pick)
  pickRef.current = pick
  useEffect(() => {
    // Removing the focused element fires no focusout in every engine, so "inside" is only ever
    // cleared by focus arriving somewhere else.
    const onIn = (e: FocusEvent): void => {
      inside.current = !!region.current && region.current.contains(e.target as Node | null)
    }
    document.addEventListener('focusin', onIn, true)
    return () => document.removeEventListener('focusin', onIn, true)
  }, [region])
  useLayoutEffect(() => {
    if (!inside.current) return
    const a = document.activeElement
    if (a && a !== document.body) return
    inside.current = false
    pickRef.current()?.focus()
  })
}
