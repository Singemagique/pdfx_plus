import { readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Strip the dev-only `ws:` (Vite HMR WebSocket) from the renderer CSP in PRODUCTION builds only.
// All signing network I/O happens in the main process, so the packaged renderer needs no WebSocket
// egress — leaving `ws:` in `connect-src` would give an XSS'd renderer an exfil channel. `apply:
// 'build'` keeps HMR working in `electron-vite dev`.
const stripDevCsp = {
  name: 'pdfx-strip-dev-csp',
  apply: 'build' as const,
  transformIndexHtml: (html: string): string => html.replace(' ws:', '')
}

// Ship the binary data pdf.js loads on demand: the wasm image decoders (CCITTFax/JBIG2 →
// jbig2.wasm, JPX → openjpeg.wasm; without them those scans render blank), the standard font data
// and the CJK CMaps. They are copied out of node_modules/pdfjs-dist (a devDependency, so not in the
// asar) into `<renderer out>/pdfjs/<subdir>/` and served at the same paths by the dev server.
// pdf.js wants DIRECTORY URLs it can append file names to, which is why these are emitted under
// fixed, unhashed names rather than imported with `?url`. The subdirectory names mirror pdfjs-dist's
// own layout; keep this in sync with src/renderer/src/pdfx/pdfjs-assets.ts (which builds the URLs).
// Only the wasm files pdf.js fetches are shipped: the *_nowasm_fallback.js decoders, qcms (ICC,
// unused with useWorkerFetch: false) and quickjs (scripting) are left out.
const PDFJS_DIST = resolve(__dirname, 'node_modules/pdfjs-dist')
const PDFJS_OUT_DIR = 'pdfjs/'
const PDFJS_WASM = ['jbig2.wasm', 'openjpeg.wasm', 'LICENSE_JBIG2', 'LICENSE_OPENJPEG']

function pdfjsAssetFiles(): string[] {
  const all = (dir: string): string[] =>
    readdirSync(join(PDFJS_DIST, dir), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => `${dir}/${e.name}`)
  return [...PDFJS_WASM.map((f) => `wasm/${f}`), ...all('standard_fonts'), ...all('cmaps')]
}

const pdfjsAssets = (): Plugin => {
  const files = new Set(pdfjsAssetFiles())
  return {
    name: 'pdfx-pdfjs-assets',
    configureServer(server) {
      // Exact allow-list lookup, so a crafted `..` path can never reach outside these files.
      server.middlewares.use(`/${PDFJS_OUT_DIR}`, (req, res, next) => {
        let rel: string
        try {
          rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '')
        } catch {
          return next() // malformed %-escape
        }
        if (!files.has(rel)) return next()
        res.setHeader(
          'Content-Type',
          rel.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'
        )
        res.end(readFileSync(join(PDFJS_DIST, rel)))
      })
    },
    generateBundle() {
      for (const rel of files) {
        this.emitFile({
          type: 'asset',
          fileName: PDFJS_OUT_DIR + rel,
          source: readFileSync(join(PDFJS_DIST, rel))
        })
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), stripDevCsp, pdfjsAssets()]
  }
})
