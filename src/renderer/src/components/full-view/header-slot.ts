import { createContext } from 'react'

/**
 * Where a full-view page's header (the recognized-text overlay's) is portalled: the slot between
 * the document title and the close button in FullViewChrome's bar, so it takes the room the bar
 * has instead of covering the title. FullView provides it (null until the bar has mounted: render
 * nothing yet); with no provider at all (a page rendered on its own) the header goes to <body>.
 */
export const FullViewHeaderSlot = createContext<HTMLElement | null | undefined>(undefined)
