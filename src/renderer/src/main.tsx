import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { GlobalWorkerOptions } from 'pdfjs-dist'
import PdfWorker from './pdfjs-worker?worker'
import './pdfjs-polyfill'
import App from './App'
import './styles.css'

// Use a custom worker (./pdfjs-worker) that installs the Map polyfills the stock pdf.js worker
// needs; workerPort takes a live Worker instead of a script URL. Without this, PDFs with AcroForm
// fields fail to render and getAnnotations throws in the worker realm.
GlobalWorkerOptions.workerPort = new PdfWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
