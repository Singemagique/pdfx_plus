export const MIN_SCALE = 0.02
export const MAX_SCALE = 90
export const PAN_MARGIN = 3
export const FIT_MARGIN = 0.86
/**
 * The zoom a fitted, fully-wrapped row of pages comes up at. Documents wrap to the viewport width
 * (see wrapWidthForViewport), so at 1 a thumbnail shows at its designed world size — 280 css px
 * tall, large enough to read a page's layout and headings, while still showing 2–3 rows on a
 * typical laptop screen. It is also the scale the doc-header chrome is drawn for.
 */
export const TARGET_FIT_SCALE = 1
/**
 * Ceiling for the automatic fit. A short collection (one small document) is narrower than the
 * wrap width, so a pure width fit would blow its pages up on a large monitor; this keeps them
 * within a modest step of TARGET_FIT_SCALE and centres them instead.
 */
export const MAX_FIT_SCALE = 1.25
/** Screen px kept above fitted content — clears the 56 px overlay toolbar with a little air. */
export const FIT_TOP_MARGIN = 72
/** Screen px kept below the end of content when the fit is scrolled to a document. */
export const FIT_BOTTOM_MARGIN = 24
/** Duration of the animated fit that brings newly imported documents into view. */
export const FIT_ANIMATION_MS = 250
export const WHEEL_ZOOM_SPEED = 0.03
export const BUTTON_ZOOM_FACTOR = 1.35
