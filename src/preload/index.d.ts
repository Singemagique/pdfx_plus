import type { PdfxApi } from './index'

declare global {
  interface Window {
    api: PdfxApi
  }
}

// The OCR port protocol and settings types the renderer uses with `window.api.ocr` and
// `window.api.getSettings()` / `setSettings()` (src/shared is DOM-free, so these are plain types).
export type { FromOcr, OcrLinkEvent, OcrMessage, Settings, ToOcr } from './index'
