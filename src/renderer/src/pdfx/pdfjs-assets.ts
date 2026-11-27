// Where pdf.js finds the binary data it loads on demand, and the getDocument() options that point
// it there.
//
// Since pdf.js 5.x the CCITTFax (office-scanner G3/G4), JBIG2 (Acrobat-compressed scans) and JPX
// (JPEG 2000) decoders are WebAssembly modules (jbig2.wasm, openjpeg.wasm) fetched from `wasmUrl`
// at first use. Without that option every such image silently decodes to nothing and the page
// renders BLANK where the scan should be. Likewise non-embedded standard 14 fonts need
// `standardFontDataUrl` and CJK predefined CMaps (UniJIS-UCS2-H, ...) need `cMapUrl`.
//
// The files are emitted next to the renderer bundle by the `pdfx-pdfjs-assets` plugin in
// electron.vite.config.ts, which copies them from node_modules/pdfjs-dist into
// `<renderer out>/pdfjs/<subdir>/` and serves the same paths from the dev server. The subdirectory
// names deliberately mirror pdfjs-dist's own package layout, so `pdfjsAssetOptions` resolves
// correctly against either the emitted `pdfjs/` directory or node_modules/pdfjs-dist itself (which
// is what the node tests do). Keep PDFJS_ASSET_DIR and the subdirectory names in sync with that
// plugin.

/** Directory (relative to the renderer's base URL) holding the copied pdfjs-dist assets. */
export const PDFJS_ASSET_DIR = 'pdfjs/'

/** pdfjs-dist subdirectories that are shipped, each served at `${PDFJS_ASSET_DIR}<name>/`. */
export const PDFJS_ASSET_SUBDIRS = {
  wasm: 'wasm/',
  standardFonts: 'standard_fonts/',
  cMaps: 'cmaps/'
} as const

/**
 * The wasm/ files pdf.js actually fetches in this app. The *_nowasm_fallback.js decoders (~600 KB)
 * are only dynamically imported when WebAssembly instantiation fails, which the CSP allows
 * ('wasm-unsafe-eval'); qcms_bg.wasm (ICC colour) is only loaded when the worker fetches its own
 * data, which `useWorkerFetch: false` below turns off; quickjs-eval is for scripting we never enable.
 */
export const PDFJS_WASM_FILES = ['jbig2.wasm', 'openjpeg.wasm'] as const

export interface PdfjsAssetOptions {
  wasmUrl: string
  standardFontDataUrl: string
  cMapUrl: string
  cMapPacked: true
  useWorkerFetch: false
}

/**
 * getDocument() options for pdf.js's on-demand data, resolved against `base` — a URL (or, under
 * node, a filesystem path) of a directory that ends in '/' and contains the shipped subdirectories.
 *
 * `useWorkerFetch: false` routes every one of these loads through the main thread (pdf.js's
 * "FetchBinaryData" message). pdf.js already picks that for the packaged app, because its
 * file:// page fails pdf.js's http(s)-only worker-fetch check; forcing it here makes the dev
 * server (http://localhost) take the identical path instead of a worker-side one that is never
 * exercised in production.
 */
export function pdfjsAssetOptions(base: string): PdfjsAssetOptions {
  if (!base.endsWith('/')) throw new Error(`pdf.js asset base must end with '/': ${base}`)
  return {
    wasmUrl: base + PDFJS_ASSET_SUBDIRS.wasm,
    standardFontDataUrl: base + PDFJS_ASSET_SUBDIRS.standardFonts,
    cMapUrl: base + PDFJS_ASSET_SUBDIRS.cMaps,
    cMapPacked: true,
    useWorkerFetch: false
  }
}

/**
 * Absolute URL of the emitted asset directory for a page at `documentBaseUri` whose Vite base is
 * `viteBase` (import.meta.env.BASE_URL: '/' under the dev server, './' in the built renderer).
 * pdf.js concatenates file names onto these strings, so they must be absolute and end in '/'.
 */
export function pdfjsAssetBase(documentBaseUri: string, viteBase: string): string {
  const base = viteBase.endsWith('/') ? viteBase : `${viteBase}/`
  return new URL(base + PDFJS_ASSET_DIR, documentBaseUri).href
}

/** The options for the running renderer (dev server or packaged file:// page). */
export function rendererPdfjsAssetOptions(): PdfjsAssetOptions {
  return pdfjsAssetOptions(pdfjsAssetBase(document.baseURI, import.meta.env.BASE_URL))
}
