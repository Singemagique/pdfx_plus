import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
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
    plugins: [react(), stripDevCsp]
  }
})
