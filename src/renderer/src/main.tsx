import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import App from './App'
import './styles.css'

const mapProto = Map.prototype as unknown as Record<string, unknown>
if (typeof mapProto.getOrInsertComputed !== 'function') {
  mapProto.getOrInsertComputed = function (
    this: Map<unknown, unknown>,
    key: unknown,
    compute: (key: unknown) => unknown
  ) {
    if (!this.has(key)) this.set(key, compute(key))
    return this.get(key)
  }
}
if (typeof mapProto.getOrInsert !== 'function') {
  mapProto.getOrInsert = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
    if (!this.has(key)) this.set(key, value)
    return this.get(key)
  }
}

GlobalWorkerOptions.workerSrc = workerUrl

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
